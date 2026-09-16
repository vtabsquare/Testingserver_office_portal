# expected_checkout_scheduler.py - Auto-pause attendance at expected checkout
#
# For every employee with an open (checked-in, not checked-out) session today,
# this computes the SAME "expected_checkout" projection shown on the Attendance
# Monitor (shift duration + any owed permission-compensation hours, minus time
# already worked today) and, once that moment passes, force-checks-out the
# employee using the exact same logic as a manual checkout (perform_checkout_v2).
#
# There is NO auto-resume - the employee must click Check In again themselves
# if they want to keep working past their expected checkout.

import os
import threading
import traceback
from datetime import datetime, timezone, timedelta

try:
    from zoneinfo import ZoneInfo
except ImportError:
    from pytz import timezone as ZoneInfo

EXPECTED_CHECKOUT_TZ = os.getenv("AUTO_CHECKOUT_TZ", "Asia/Calcutta")

# How often to check for employees past their expected checkout.
_TICK_SECONDS = 60

_scheduler_timer = None
_scheduler_running = False


def _get_biz_tz():
    try:
        return ZoneInfo(EXPECTED_CHECKOUT_TZ)
    except Exception:
        try:
            return ZoneInfo("Asia/Calcutta")
        except Exception:
            return timezone(timedelta(hours=5, minutes=30))


def _owed_compensation_hours_today(employee_id, today_str):
    """Mirror the owed-hours lookup used by the Attendance Monitor endpoint."""
    try:
        from supabase_helper import query_records as _sb_query_records
        rows = _sb_query_records(
            "crc6f_permissions",
            filters={"crc6f_makeupdate": today_str, "crc6f_compensated": False},
        )
        owed = 0.0
        for row in rows:
            if str(row.get("crc6f_employeeid") or "").strip().upper() != employee_id:
                continue
            mode = str(row.get("crc6f_compensationmode") or "none").strip().lower()
            if mode == "none":
                continue
            owed += float(row.get("crc6f_compensationhours") or 0)
        return owed
    except Exception as e:
        print(f"[EXPECTED-CHECKOUT-SCHEDULER] Failed to load compensation for {employee_id}: {e}")
        return 0.0


def _process_expected_checkouts():
    from attendance_service_v2 import (
        list_employee_ids_with_open_session_today,
        fetch_open_login_activity_for_checkout,
        fetch_attendance_record,
        perform_checkout_v2,
        LA_FIELD_CHECKIN_TS,
        LA_FIELD_BASE_SECONDS,
    )
    global RESOLVE_SHIFT_FUNC, SHIFT_DURATION_FUNC
    if not RESOLVE_SHIFT_FUNC or not SHIFT_DURATION_FUNC:
        print("[EXPECTED-CHECKOUT-SCHEDULER] Shift functions not initialized, skipping tick")
        return
    _resolve_employee_shift = RESOLVE_SHIFT_FUNC
    _shift_duration_minutes_from_times = SHIFT_DURATION_FUNC

    try:
        biz_tz = _get_biz_tz()
        now_utc = datetime.now(timezone.utc)
        today_str = now_utc.astimezone(biz_tz).date().isoformat()

        employee_ids = list_employee_ids_with_open_session_today(tz_name=EXPECTED_CHECKOUT_TZ)
        if not employee_ids:
            return

        for employee_id in employee_ids:
            try:
                la_row, session_date = fetch_open_login_activity_for_checkout(employee_id, today_str)
                if not la_row or not session_date:
                    continue

                # Prevent infinite loop: if this session is explicitly marked as overtime,
                # DO NOT auto-pause it based on standard shift durations.
                # Check both Dataverse (att_record.metadata) AND Supabase directly,
                # because Dataverse OData may not return the 'metadata' JSONB column.
                _is_overtime_session = False
                try:
                    att_record = fetch_attendance_record(employee_id, session_date)
                    if att_record:
                        meta = att_record.get("metadata") or {}
                        if isinstance(meta, str):
                            import json
                            try:
                                meta = json.loads(meta)
                            except Exception:
                                meta = {}
                        if meta.get("is_overtime"):
                            _is_overtime_session = True
                except Exception:
                    pass

                # Supabase direct check as authoritative fallback
                if not _is_overtime_session:
                    try:
                        from supabase_helper import get_supabase as _get_sb
                        _sb = _get_sb()
                        _sb_resp = (
                            _sb.table("crc6f_table13s")
                            .select("metadata")
                            .eq("crc6f_employeeid", employee_id)
                            .eq("crc6f_date", session_date)
                            .limit(1)
                            .execute()
                        )
                        for _sb_row in (_sb_resp.data or []):
                            _sb_meta = _sb_row.get("metadata") or {}
                            if isinstance(_sb_meta, str):
                                import json
                                try:
                                    _sb_meta = json.loads(_sb_meta)
                                except Exception:
                                    _sb_meta = {}
                            if _sb_meta.get("is_overtime"):
                                _is_overtime_session = True
                                break
                    except Exception as _sb_err:
                        print(f"[EXPECTED-CHECKOUT-SCHEDULER] Supabase overtime check failed for {employee_id}: {_sb_err}")

                if _is_overtime_session:
                    print(f"[EXPECTED-CHECKOUT-SCHEDULER] SKIPPING {employee_id} on {session_date} - is_overtime=True")
                    continue

                checkin_ts = la_row.get(LA_FIELD_CHECKIN_TS)
                if not checkin_ts:
                    continue

                shift = _resolve_employee_shift(employee_id) or {}
                duration_minutes = _shift_duration_minutes_from_times(
                    shift.get("shift_start"), shift.get("shift_end")
                )
                if duration_minutes is None:
                    continue

                owed_hours = _owed_compensation_hours_today(employee_id, today_str)
                effective_duration_seconds = (duration_minutes * 60) + int(round(owed_hours * 3600))

                # base_seconds = time already worked TODAY *before* the current session started.
                # total time worked = base_seconds + (now - checkin_ts)
                # Auto-pause when total >= effective_duration_seconds.
                base_seconds_worked = int(la_row.get(LA_FIELD_BASE_SECONDS) or 0)
                checkin_ts_int = int(checkin_ts)
                session_elapsed = max(0, int(now_utc.timestamp()) - checkin_ts_int)
                total_seconds_worked = base_seconds_worked + session_elapsed

                if total_seconds_worked < effective_duration_seconds:
                    continue

                result = perform_checkout_v2(employee_id, tz_name=EXPECTED_CHECKOUT_TZ)
                if result.get("success"):
                    print(f"[EXPECTED-CHECKOUT-SCHEDULER] Auto-paused {employee_id} at expected checkout "
                          f"(shift {duration_minutes}m + owed {owed_hours}h)")
                elif result.get("error") != "NO_ACTIVE_SESSION":
                    print(f"[EXPECTED-CHECKOUT-SCHEDULER] Checkout failed for {employee_id}: {result.get('error')}")
            except Exception as emp_err:
                print(f"[EXPECTED-CHECKOUT-SCHEDULER] Error processing {employee_id}: {emp_err}")
                traceback.print_exc()
    except Exception as e:
        print(f"[EXPECTED-CHECKOUT-SCHEDULER] Tick error: {e}")
        traceback.print_exc()


def _tick():
    global _scheduler_timer
    if not _scheduler_running:
        return
    try:
        _process_expected_checkouts()
    except Exception as e:
        print(f"[EXPECTED-CHECKOUT-SCHEDULER] Unexpected tick error: {e}")
        traceback.print_exc()
    finally:
        if _scheduler_running:
            _scheduler_timer = threading.Timer(_TICK_SECONDS, _tick)
            _scheduler_timer.daemon = True
            _scheduler_timer.start()


# Global pointers to avoid circular imports
RESOLVE_SHIFT_FUNC = None
SHIFT_DURATION_FUNC = None

def setup_expected_checkout_scheduler(app=None, resolve_func=None, duration_func=None):
    """Start the midnight auto-checkout scheduler. Safe to call multiple times."""
    global _scheduler_running, RESOLVE_SHIFT_FUNC, SHIFT_DURATION_FUNC
    
    if resolve_func: RESOLVE_SHIFT_FUNC = resolve_func
    if duration_func: SHIFT_DURATION_FUNC = duration_func

    if _scheduler_running:
        print("[EXPECTED-CHECKOUT-SCHEDULER] Already running, skipping duplicate setup")
        return

    _scheduler_running = True
    print(f"[EXPECTED-CHECKOUT-SCHEDULER] Starting auto-pause scheduler "
          f"(every {_TICK_SECONDS}s, timezone: {EXPECTED_CHECKOUT_TZ})")
    _tick()


def shutdown_expected_checkout_scheduler(app=None):
    global _scheduler_timer, _scheduler_running
    _scheduler_running = False
    if _scheduler_timer:
        _scheduler_timer.cancel()
        _scheduler_timer = None
    print("[EXPECTED-CHECKOUT-SCHEDULER] Shutdown complete")
