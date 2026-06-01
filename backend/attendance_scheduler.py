# attendance_scheduler.py - Scheduled Jobs for Attendance System
# Uses EXISTING Dataverse tables: crc6f_table13s + crc6f_hr_loginactivitytbs
# Handles midnight auto-checkout and absent marking
#
# IMPORTANT: Auto-checkout reuses the EXACT same logic as manual checkout
# from attendance_service_v2._auto_close_stale_sessions to guarantee parity.
# This scheduler only adds a PROACTIVE midnight trigger so that forgotten
# sessions are closed even when the user never opens the app the next day.
#
# Zero new dependencies - uses stdlib threading.Timer for scheduling.

from datetime import datetime, timezone, timedelta
import os
import threading
import requests
import traceback

from dataverse_helper import get_access_token, update_record, create_record, get_dataverse_session
from time_tracking import stop_active_task_entries_for_user

try:
    from zoneinfo import ZoneInfo
except ImportError:
    from pytz import timezone as ZoneInfo

# ================== CONFIGURATION ==================
RESOURCE = os.getenv("RESOURCE", "")
SOCKET_SERVER_URL = os.getenv("SOCKET_SERVER_URL", "http://localhost:4001")
AUTO_CHECKOUT_TZ = os.getenv("AUTO_CHECKOUT_TZ", "Asia/Calcutta")

HALF_DAY_SECONDS = 4 * 3600
FULL_DAY_SECONDS = 9 * 3600

# ================== EXISTING Dataverse tables ==================
ATTENDANCE_ENTITY = "crc6f_table13s"
LOGIN_ACTIVITY_ENTITY = "crc6f_hr_loginactivitytbs"
EMPLOYEE_ENTITY = "crc6f_table12s"

# Attendance table fields
FIELD_RECORD_ID = "crc6f_table13id"
FIELD_ATTENDANCE_ID = "crc6f_attendanceid"
FIELD_EMPLOYEE_ID = "crc6f_employeeid"
FIELD_DATE = "crc6f_date"
FIELD_CHECKIN = "crc6f_checkin"
FIELD_CHECKOUT = "crc6f_checkout"
FIELD_DURATION = "crc6f_duration"
FIELD_DURATION_INTEXT = "crc6f_duration_intext"
FIELD_STATUS = "crc6f_status"

# Login activity table fields
LA_PRIMARY_FIELD = "crc6f_hr_loginactivitytbid"
LA_FIELD_EMPLOYEE_ID = "crc6f_employeeid"
LA_FIELD_DATE = "crc6f_date"
LA_FIELD_CHECKIN_TIME = "crc6f_checkintime"
LA_FIELD_CHECKIN_TS = "crc6f_checkin_timestamp"
LA_FIELD_CHECKOUT_TS = "crc6f_checkout_timestamp"
LA_FIELD_CHECKOUT_TIME = "crc6f_checkouttime"
LA_FIELD_BASE_SECONDS = "crc6f_base_seconds"
LA_FIELD_TOTAL_SECONDS = "crc6f_total_seconds"

# ================== Scheduler state ==================
_scheduler_timer = None
_scheduler_running = False


def _get_biz_tz():
    """Return the business timezone object."""
    try:
        return ZoneInfo(AUTO_CHECKOUT_TZ)
    except Exception:
        try:
            return ZoneInfo("Asia/Calcutta")
        except Exception:
            return timezone(timedelta(hours=5, minutes=30))


def get_server_now_utc():
    return datetime.now(timezone.utc)


def derive_status(total_seconds, employee_id=None):
    if employee_id:
        try:
            from attendance_shift_status import classify_seconds_for_employee
            return classify_seconds_for_employee(employee_id, int(total_seconds or 0))
        except Exception:
            pass
    if total_seconds >= FULL_DAY_SECONDS:
        return "P"
    elif total_seconds >= HALF_DAY_SECONDS:
        return "HL"
    return "A"


def format_duration_text(seconds):
    hours = seconds // 3600
    minutes = (seconds % 3600) // 60
    return f"{hours} hour(s) {minutes} minute(s)"


def format_duration_hours(seconds):
    return round(seconds / 3600, 2)


def generate_id(prefix):
    import random
    import string
    chars = ''.join(random.choices(string.ascii_uppercase + string.digits, k=7))
    return f"{prefix}-{chars}"


def emit_attendance_changed(employee_id, event_type):
    try:
        requests.post(
            f"{SOCKET_SERVER_URL}/emit",
            json={
                "event": "attendance:changed",
                "data": {
                    "employee_id": employee_id,
                    "event_type": event_type,
                    "server_now_utc": get_server_now_utc().isoformat()
                }
            },
            timeout=2
        )
    except Exception:
        pass


def _get_headers(token):
    return {
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
        "Content-Type": "application/json",
        "OData-MaxVersion": "4.0",
        "OData-Version": "4.0"
    }


# ================== JOB 1: MIDNIGHT AUTO-CHECKOUT (ALL EMPLOYEES) ==================

def midnight_auto_checkout():
    """
    Proactive midnight auto-checkout: finds ALL open sessions across ALL employees
    where the session date is before the current local date and closes them at
    local midnight (00:00:00) of the NEXT day after the session date.

    This mirrors the EXACT same logic as manual checkout:
      1. Close login activity record (checkout time = 00:00:00, checkout_ts = midnight epoch)
      2. Update attendance record (checkout time, duration, status)
      3. Stop any running task timers
      4. Emit socket event so frontend updates
    """
    print(f"\n[SCHEDULER] ====== MIDNIGHT AUTO-CHECKOUT START ======")
    print(f"[SCHEDULER] Running at {get_server_now_utc().isoformat()}")

    try:
        token = get_access_token()
        headers = _get_headers(token)
        biz_tz = _get_biz_tz()
        now_utc = get_server_now_utc()
        local_today = now_utc.astimezone(biz_tz).date().isoformat()

        # Query ALL open sessions (checkin exists, no checkout) across all employees
        # We do NOT filter by date in OData to handle any Dataverse schema variation;
        # instead we filter by date in Python for maximum robustness.
        filter_q = (
            f"$filter={LA_FIELD_CHECKIN_TS} ne null "
            f"and {LA_FIELD_CHECKOUT_TS} eq null"
        )
        url = f"{RESOURCE}/api/data/v9.2/{LOGIN_ACTIVITY_ENTITY}?{filter_q}&$top=5000"
        print(f"[SCHEDULER] Querying open sessions: {url}")

        s = get_dataverse_session()
        resp = s.get(url, headers=headers, timeout=20)
        if resp.status_code != 200:
            print(f"[SCHEDULER] Failed to fetch open sessions: {resp.status_code} {resp.text[:300]}")
            return {"closed": 0, "error": f"fetch failed: {resp.status_code}"}

        all_open = resp.json().get("value", [])

        # Filter to only stale sessions (date < local today)
        stale_rows = []
        for row in all_open:
            row_date = str(row.get(LA_FIELD_DATE) or "")[:10]
            if row_date and row_date < local_today:
                stale_rows.append(row)

        print(f"[SCHEDULER] Found {len(all_open)} total open, {len(stale_rows)} stale (date < {local_today})")

        if not stale_rows:
            print(f"[SCHEDULER] No stale sessions to close")
            return {"closed": 0}

        closed = 0
        for row in stale_rows:
            try:
                la_id = row.get(LA_PRIMARY_FIELD)
                employee_id = (row.get(LA_FIELD_EMPLOYEE_ID) or "").strip().upper()
                raw_date = str(row.get(LA_FIELD_DATE) or "")[:10]
                checkin_ts = int(row.get(LA_FIELD_CHECKIN_TS) or 0)
                base_seconds = int(row.get(LA_FIELD_BASE_SECONDS) or 0)

                if not la_id or not employee_id or not raw_date or not checkin_ts:
                    continue

                # Calculate midnight cutoff for the session date
                day_obj = datetime.strptime(raw_date, "%Y-%m-%d").date()
                next_midnight_local = datetime(
                    day_obj.year, day_obj.month, day_obj.day, 0, 0, 0, tzinfo=biz_tz
                ) + timedelta(days=1)
                cutoff_utc = next_midnight_local.astimezone(timezone.utc)
                cutoff_ts = int(cutoff_utc.timestamp())

                # Calculate duration (capped at midnight)
                session_seconds = max(0, cutoff_ts - checkin_ts)
                total_seconds = base_seconds + session_seconds
                status = derive_status(total_seconds, employee_id)
                hours = format_duration_hours(total_seconds)
                duration_text = format_duration_text(total_seconds)

                # STEP 1: Close login activity record at midnight
                la_patch = {
                    LA_FIELD_CHECKOUT_TIME: next_midnight_local.strftime("%H:%M:%S"),
                    LA_FIELD_CHECKOUT_TS: cutoff_ts,
                    LA_FIELD_TOTAL_SECONDS: total_seconds,
                }
                la_url = f"{RESOURCE}/api/data/v9.2/{LOGIN_ACTIVITY_ENTITY}({la_id})"
                la_resp = s.patch(la_url, headers=headers, json=la_patch, timeout=15)
                if la_resp.status_code >= 400:
                    print(f"[SCHEDULER] Failed to close login activity for {employee_id} ({raw_date}): {la_resp.status_code}")
                    continue

                # STEP 2: Update attendance record (same as manual checkout)
                try:
                    att_filter = f"$filter={FIELD_EMPLOYEE_ID} eq '{employee_id}' and {FIELD_DATE} eq '{raw_date}'"
                    att_url = f"{RESOURCE}/api/data/v9.2/{ATTENDANCE_ENTITY}?{att_filter}"
                    att_resp = s.get(att_url, headers=headers, timeout=15)

                    if att_resp.status_code == 200:
                        att_records = att_resp.json().get("value", [])
                        if att_records:
                            att_record_id = att_records[0].get(FIELD_RECORD_ID) or att_records[0].get("crc6f_table13id")
                            if att_record_id:
                                att_update = {
                                    FIELD_CHECKOUT: next_midnight_local.strftime("%H:%M:%S"),
                                    FIELD_DURATION: str(hours),
                                    FIELD_DURATION_INTEXT: duration_text,
                                }
                                if FIELD_STATUS:
                                    att_update[FIELD_STATUS] = status
                                update_record(ATTENDANCE_ENTITY, att_record_id, att_update)
                                print(f"[SCHEDULER] Updated attendance for {employee_id} ({raw_date}): {hours}h, status={status}")
                except Exception as att_err:
                    print(f"[SCHEDULER] Attendance update warning for {employee_id} ({raw_date}): {att_err}")

                # STEP 3: Stop any running task timers (same as manual checkout)
                try:
                    result = stop_active_task_entries_for_user(employee_id, cutoff_utc.isoformat())
                    if result.get("stopped", 0) > 0:
                        print(f"[SCHEDULER] Stopped {result['stopped']} task timer(s) for {employee_id}")
                except Exception as task_err:
                    print(f"[SCHEDULER] Task stop warning for {employee_id}: {task_err}")

                # STEP 4: Emit socket event (same as manual checkout)
                emit_attendance_changed(employee_id, "auto_checkout_midnight")

                closed += 1
                print(f"[SCHEDULER] Auto-checked-out {employee_id} for {raw_date}: "
                      f"duration={hours}h, status={status}, checkout=00:00:00")

            except Exception as row_err:
                print(f"[SCHEDULER] Error processing row: {row_err}")
                traceback.print_exc()
                continue

        print(f"[SCHEDULER] ====== MIDNIGHT AUTO-CHECKOUT COMPLETE: {closed}/{len(stale_rows)} closed ======\n")
        return {"closed": closed}

    except Exception as e:
        print(f"[SCHEDULER] midnight_auto_checkout FAILED: {e}")
        traceback.print_exc()
        return {"closed": 0, "error": str(e)}


# ================== JOB 2: MARK ABSENT EMPLOYEES ==================

def mark_absent_employees():
    """
    Create 'Absent' records for employees who didn't check in yesterday.
    Should run daily after midnight.
    """
    print(f"[SCHEDULER] Running mark_absent_employees at {get_server_now_utc().isoformat()}")

    try:
        token = get_access_token()
        headers = _get_headers(token)
        now_utc = get_server_now_utc()
        yesterday = (now_utc - timedelta(days=1)).strftime("%Y-%m-%d")

        # Check if yesterday was a weekend
        yesterday_date = now_utc - timedelta(days=1)
        if yesterday_date.weekday() >= 5:
            print(f"[SCHEDULER] {yesterday} is a weekend, skipping absent marking")
            return

        # Get all active employees
        emp_url = f"{RESOURCE}/api/data/v9.2/{EMPLOYEE_ENTITY}?$filter=crc6f_activeflag eq true&$select=crc6f_employeeid"
        s = get_dataverse_session()
        emp_resp = s.get(emp_url, headers=headers, timeout=20)

        if emp_resp.status_code != 200:
            print(f"[SCHEDULER] Failed to fetch employees: {emp_resp.status_code}")
            return

        employees = emp_resp.json().get("value", [])
        all_employee_ids = {emp.get("crc6f_employeeid", "").upper() for emp in employees if emp.get("crc6f_employeeid")}

        # Get employees who have attendance for yesterday
        att_url = f"{RESOURCE}/api/data/v9.2/{ATTENDANCE_ENTITY}?$filter={FIELD_DATE} eq '{yesterday}'&$select={FIELD_EMPLOYEE_ID}"
        att_resp = s.get(att_url, headers=headers, timeout=20)

        if att_resp.status_code != 200:
            print(f"[SCHEDULER] Failed to fetch attendance: {att_resp.status_code}")
            return

        attendance_records = att_resp.json().get("value", [])
        employees_with_attendance = {rec.get(FIELD_EMPLOYEE_ID, "").upper() for rec in attendance_records}

        # Find employees without attendance
        absent_employees = all_employee_ids - employees_with_attendance
        print(f"[SCHEDULER] Found {len(absent_employees)} employees without attendance for {yesterday}")

        created_count = 0
        for employee_id in absent_employees:
            try:
                attendance_id = generate_id("ATD")
                create_record(ATTENDANCE_ENTITY, {
                    FIELD_ATTENDANCE_ID: attendance_id,
                    FIELD_EMPLOYEE_ID: employee_id,
                    FIELD_DATE: yesterday,
                    FIELD_DURATION: "0",
                    FIELD_DURATION_INTEXT: "0 hour(s) 0 minute(s)"
                })
                created_count += 1

            except Exception as e:
                print(f"[SCHEDULER] Error creating absent record for {employee_id}: {e}")
                continue

        print(f"[SCHEDULER] Successfully created {created_count} absent records")

    except Exception as e:
        print(f"[SCHEDULER] mark_absent_employees failed: {e}")
        traceback.print_exc()


# ================== THREADING-BASED SCHEDULER ==================
# Uses stdlib threading.Timer - no external dependency required.
# Schedules jobs to run at specific local times daily.

def _seconds_until_local_time(hour, minute, second=0):
    """Calculate seconds from now until the next occurrence of HH:MM:SS in business timezone."""
    biz_tz = _get_biz_tz()
    now_local = datetime.now(timezone.utc).astimezone(biz_tz)
    target_today = now_local.replace(hour=hour, minute=minute, second=second, microsecond=0)

    if target_today <= now_local:
        # Already past today, schedule for tomorrow
        target_today += timedelta(days=1)

    delta = (target_today - now_local).total_seconds()
    return max(1, int(delta))


def _schedule_next_midnight_job():
    """Schedule the midnight auto-checkout job to run at 00:00:00 local time."""
    global _scheduler_timer, _scheduler_running

    if not _scheduler_running:
        return

    wait_seconds = _seconds_until_local_time(0, 0, 5)  # 00:00:05 to avoid exact boundary
    biz_tz = _get_biz_tz()
    next_run = datetime.now(timezone.utc).astimezone(biz_tz) + timedelta(seconds=wait_seconds)
    print(f"[SCHEDULER] Next midnight auto-checkout in {wait_seconds}s (at {next_run.strftime('%Y-%m-%d %H:%M:%S %Z')})")

    def _run_and_reschedule():
        try:
            midnight_auto_checkout()
        except Exception as e:
            print(f"[SCHEDULER] Midnight job error: {e}")
            traceback.print_exc()

        # Also run absent marking ~10 minutes after midnight
        try:
            def _run_absent():
                try:
                    mark_absent_employees()
                except Exception as e2:
                    print(f"[SCHEDULER] Absent marking error: {e2}")
            absent_timer = threading.Timer(600, _run_absent)  # 10 minutes later
            absent_timer.daemon = True
            absent_timer.start()
        except Exception:
            pass

        # Schedule next run
        _schedule_next_midnight_job()

    _scheduler_timer = threading.Timer(wait_seconds, _run_and_reschedule)
    _scheduler_timer.daemon = True
    _scheduler_timer.start()


def setup_scheduler(app=None):
    """Start the midnight auto-checkout scheduler. Safe to call multiple times."""
    global _scheduler_running

    if _scheduler_running:
        print("[SCHEDULER] Already running, skipping duplicate setup")
        return

    _scheduler_running = True
    print(f"[SCHEDULER] Starting midnight auto-checkout scheduler (timezone: {AUTO_CHECKOUT_TZ})")
    _schedule_next_midnight_job()

    if app:
        app._attendance_scheduler_running = True


def shutdown_scheduler(app=None):
    """Stop the scheduler gracefully."""
    global _scheduler_timer, _scheduler_running

    _scheduler_running = False
    if _scheduler_timer:
        _scheduler_timer.cancel()
        _scheduler_timer = None
    print("[SCHEDULER] Shutdown complete")


if __name__ == "__main__":
    print("Running scheduler jobs manually...")
    result = midnight_auto_checkout()
    print(f"Auto-checkout result: {result}")
    mark_absent_employees()
