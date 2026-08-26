# permission.py - Hour-based "Permission" short-leave module
#
# Employees apply for a same-day permission window (start_time-end_time).
# Approval is AUDIT-ONLY - it does not gate anything. Regardless of
# Pending/Approved/Rejected status, once the permission's start_time arrives
# (checked by a background scheduler tick), the employee's active attendance
# session is force-checked-out ("paused") using the exact same logic as a
# manual checkout. There is NO auto-resume at end_time - the employee must
# click Check In again themselves.

import os
import random
import string
import threading
import traceback
from datetime import datetime, date, time as dtime, timezone, timedelta

from flask import Blueprint, request, jsonify

from dataverse_helper import (
    create_record,
    update_record,
    get_record,
    query_records,
    get_employee_name,
    get_employee_email,
    get_l2_l3_emails,
)
from mail_app import send_email

try:
    from zoneinfo import ZoneInfo
except ImportError:
    from pytz import timezone as ZoneInfo

permission_bp = Blueprint('permission', __name__, url_prefix='/api/permissions')

PERMISSION_ENTITY = "crc6f_permissions"
PERMISSION_TZ = os.getenv("AUTO_CHECKOUT_TZ", "Asia/Calcutta")

# Scheduler tick interval (seconds). Any permission whose start_time has
# passed since the last tick will be processed on the next one, so this
# controls the worst-case delay before the pause actually happens.
_TICK_SECONDS = 60

_scheduler_timer = None
_scheduler_running = False


def _get_biz_tz():
    try:
        return ZoneInfo(PERMISSION_TZ)
    except Exception:
        try:
            return ZoneInfo("Asia/Calcutta")
        except Exception:
            return timezone(timedelta(hours=5, minutes=30))


def _now_local():
    return datetime.now(timezone.utc).astimezone(_get_biz_tz())


def _normalize_employee_id(value):
    return str(value or "").strip().upper()


def generate_permission_id():
    random_part = ''.join(random.choices(string.ascii_uppercase + string.digits, k=7))
    return f"PRM-{random_part}"


def _parse_time_str(value):
    """Parse 'HH:MM' or 'HH:MM:SS' into a datetime.time, or None."""
    if not value:
        return None
    raw = str(value).strip()
    for fmt in ("%H:%M:%S", "%H:%M"):
        try:
            return datetime.strptime(raw, fmt).time()
        except ValueError:
            continue
    return None


def _normalize_permission_row(row):
    if not row:
        return {}
    return {
        "id": row.get("crc6f_permissionid"),
        "permission_id": row.get("crc6f_permission_code"),
        "employee_id": row.get("crc6f_employeeid"),
        "date": str(row.get("crc6f_date") or "")[:10],
        "start_time": str(row.get("crc6f_starttime") or "")[:5],
        "end_time": str(row.get("crc6f_endtime") or "")[:5],
        "reason": row.get("crc6f_reason") or "",
        "status": row.get("crc6f_status") or "Pending",
        "approved_by": row.get("crc6f_approvedby"),
        "approved_on": row.get("crc6f_approvedon"),
        "rejection_reason": row.get("crc6f_rejectionreason") or "",
        "paused_at": row.get("crc6f_pausedat"),
        "created_at": row.get("created_at") or row.get("createdon"),
        "compensation_mode": row.get("crc6f_compensationmode") or "none",
        "makeup_date": str(row.get("crc6f_makeupdate") or "")[:10] or None,
        "compensation_hours": float(row.get("crc6f_compensationhours") or 0),
        "compensated": bool(row.get("crc6f_compensated") or False),
        "compensated_at": row.get("crc6f_compensatedat"),
    }


def _get_employee_work_week(employee_id):
    """Lazy import to avoid a circular import with unified_server at module load time."""
    try:
        from unified_server import _resolve_employee_shift
        shift = _resolve_employee_shift(employee_id) or {}
        return str(shift.get("work_week") or "mon-sat").strip().lower()
    except Exception:
        return "mon-sat"


def _current_work_week_range(employee_id, on_date):
    """Return (week_start, week_end) dates for the work week containing on_date."""
    work_week = _get_employee_work_week(employee_id)
    week_start = on_date - timedelta(days=on_date.weekday())  # Monday
    week_end = week_start + timedelta(days=4 if work_week == "mon-fri" else 5)  # Fri or Sat
    return week_start, week_end


# ================== ROUTES ==================

@permission_bp.route('', methods=['GET'])
def list_permissions():
    """List permission requests, optionally filtered by employee_id/status/date."""
    try:
        employee_id = _normalize_employee_id(request.args.get('employee_id', ''))
        status_filter = str(request.args.get('status') or '').strip()
        date_filter = str(request.args.get('date') or '').strip()

        filters = {}
        if employee_id:
            filters["crc6f_employeeid"] = employee_id
        if status_filter:
            filters["crc6f_status"] = status_filter
        if date_filter:
            filters["crc6f_date"] = date_filter

        rows = query_records(
            PERMISSION_ENTITY,
            filters=filters or None,
            order_by="created_at",
            order_desc=True,
        )
        requests_out = [_normalize_permission_row(r) for r in rows]
        return jsonify({"success": True, "requests": requests_out, "count": len(requests_out)}), 200
    except Exception as e:
        print(f"[ERROR] Failed to list permission requests: {e}")
        traceback.print_exc()
        return jsonify({"success": False, "error": str(e), "requests": []}), 500


@permission_bp.route('', methods=['POST'])
def create_permission():
    """Apply for a same-day hour-based permission."""
    employee_id = ""
    reason = ""
    start_time_str = ""
    end_time_str = ""
    date_str = ""
    try:
        data = request.get_json() or {}
        employee_id = _normalize_employee_id(data.get('employee_id') or data.get('employeeId'))
        date_str = str(data.get('date') or '').strip()
        start_time_str = str(data.get('start_time') or data.get('startTime') or '').strip()
        end_time_str = str(data.get('end_time') or data.get('endTime') or '').strip()
        reason = str(data.get('reason') or '').strip()
        compensation_mode = str(data.get('compensation_mode') or data.get('compensationMode') or 'none').strip().lower()
        makeup_date_str = str(data.get('makeup_date') or data.get('makeupDate') or '').strip()

        if not employee_id:
            return jsonify({"success": False, "error": "employee_id is required"}), 400
        if not date_str:
            return jsonify({"success": False, "error": "date is required"}), 400
        if not start_time_str or not end_time_str:
            return jsonify({"success": False, "error": "start_time and end_time are required"}), 400
        if compensation_mode not in ("none", "today", "week"):
            return jsonify({"success": False, "error": "compensation_mode must be 'none', 'today', or 'week'"}), 400

        start_t = _parse_time_str(start_time_str)
        end_t = _parse_time_str(end_time_str)
        if not start_t or not end_t:
            return jsonify({"success": False, "error": "start_time/end_time must be in HH:MM format"}), 400
        if end_t <= start_t:
            return jsonify({"success": False, "error": "end_time must be after start_time"}), 400

        try:
            req_date = datetime.strptime(date_str, "%Y-%m-%d").date()
        except ValueError:
            return jsonify({"success": False, "error": "date must be in YYYY-MM-DD format"}), 400

        # Past times are rejected server-side too (UI already disables them).
        now_local = _now_local()
        if req_date < now_local.date():
            return jsonify({"success": False, "error": "Cannot apply permission for a past date"}), 400
        if req_date == now_local.date():
            start_dt_local = datetime.combine(req_date, start_t, tzinfo=_get_biz_tz())
            if start_dt_local < now_local:
                return jsonify({"success": False, "error": "Start time cannot be in the past"}), 400

        # Compensation hours owed = the permission's own duration.
        duration_seconds = (
            (end_t.hour * 3600 + end_t.minute * 60 + end_t.second)
            - (start_t.hour * 3600 + start_t.minute * 60 + start_t.second)
        )
        compensation_hours = round(duration_seconds / 3600.0, 2)

        makeup_date = None
        if compensation_mode == "today":
            makeup_date = req_date
        elif compensation_mode == "week":
            if not makeup_date_str:
                return jsonify({"success": False, "error": "makeup_date is required when compensation_mode is 'week'"}), 400
            try:
                makeup_date = datetime.strptime(makeup_date_str, "%Y-%m-%d").date()
            except ValueError:
                return jsonify({"success": False, "error": "makeup_date must be in YYYY-MM-DD format"}), 400
            if makeup_date < now_local.date():
                return jsonify({"success": False, "error": "makeup_date cannot be in the past"}), 400
            if makeup_date.weekday() == 6:
                return jsonify({"success": False, "error": "makeup_date cannot be a Sunday"}), 400
            week_start, week_end = _current_work_week_range(employee_id, req_date)
            if not (week_start <= makeup_date <= week_end):
                return jsonify({
                    "success": False,
                    "error": f"makeup_date must be within the current work week ({week_start.isoformat()} to {week_end.isoformat()})",
                }), 400

        payload = {
            "crc6f_permission_code": generate_permission_id(),
            "crc6f_employeeid": employee_id,
            "crc6f_date": req_date.isoformat(),
            "crc6f_starttime": start_t.strftime("%H:%M:%S"),
            "crc6f_endtime": end_t.strftime("%H:%M:%S"),
            "crc6f_status": "Pending",
            "crc6f_compensationmode": compensation_mode,
            "crc6f_compensationhours": compensation_hours if compensation_mode != "none" else 0,
            "crc6f_compensated": False,
        }
        if makeup_date:
            payload["crc6f_makeupdate"] = makeup_date.isoformat()
        if reason:
            payload["crc6f_reason"] = reason

        created = create_record(PERMISSION_ENTITY, payload)
        normalized = _normalize_permission_row(created or payload)

        return jsonify({
            "success": True,
            "message": "Permission request submitted successfully",
            "request": normalized,
        }), 201
    except Exception as e:
        print(f"[ERROR] Failed to create permission request: {e}")
        traceback.print_exc()
        return jsonify({"success": False, "error": str(e)}), 500
    finally:
        try:
            if employee_id:
                emp_name = get_employee_name(employee_id) or employee_id
                recipients = get_l2_l3_emails()
                recipient_emails = [r["email"] for r in recipients if r.get("email")]
                if recipient_emails:
                    send_email(
                        subject=f"Permission Request: {emp_name} ({employee_id})",
                        recipients=recipient_emails,
                        body=(
                            f"Employee {emp_name} ({employee_id}) has submitted a Permission request "
                            f"for {date_str} from {start_time_str} to {end_time_str}. "
                            f"Reason: {reason or 'Not provided'}. Please review in HR Tool."
                        ),
                        html=f"""
                        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
                            <h2 style="color:#1a73e8;">🕒 New Permission Request</h2>
                            <table style="width:100%;border-collapse:collapse;">
                                <tr><td style="padding:8px;font-weight:bold;">Employee</td><td style="padding:8px;">{emp_name} ({employee_id})</td></tr>
                                <tr style="background:#f8f9fa;"><td style="padding:8px;font-weight:bold;">Date</td><td style="padding:8px;">{date_str}</td></tr>
                                <tr><td style="padding:8px;font-weight:bold;">Time</td><td style="padding:8px;">{start_time_str} - {end_time_str}</td></tr>
                                <tr style="background:#f8f9fa;"><td style="padding:8px;font-weight:bold;">Reason</td><td style="padding:8px;">{reason or 'Not provided'}</td></tr>
                            </table>
                            <p style="margin-top:16px;color:#5f6368;">Note: attendance already auto-pauses at the start time regardless of approval; this is for record-keeping.</p>
                        </div>
                        """,
                        async_send=True,
                    )
        except Exception as mail_err:
            print(f"[WARN] Failed to send permission request notification: {mail_err}")


@permission_bp.route('/<request_id>/approve', methods=['POST'])
def approve_permission(request_id):
    """Audit-only approval. Does not affect the auto-pause behavior."""
    try:
        data = request.get_json() or {}
        approved_by = _normalize_employee_id(data.get('approved_by') or data.get('approvedBy') or 'EMP001')

        update_record(PERMISSION_ENTITY, request_id, {
            "crc6f_status": "Approved",
            "crc6f_approvedby": approved_by,
            "crc6f_approvedon": datetime.now(timezone.utc).isoformat(),
        })
        return jsonify({"success": True, "message": "Permission request approved", "request_id": request_id}), 200
    except Exception as e:
        print(f"[ERROR] Failed to approve permission request {request_id}: {e}")
        traceback.print_exc()
        return jsonify({"success": False, "error": str(e)}), 500


@permission_bp.route('/<request_id>/reject', methods=['POST'])
def reject_permission(request_id):
    """Audit-only rejection. Does not affect the auto-pause behavior."""
    try:
        data = request.get_json() or {}
        rejection_reason = str(data.get('reason') or '').strip()

        update_record(PERMISSION_ENTITY, request_id, {
            "crc6f_status": "Rejected",
            "crc6f_rejectionreason": rejection_reason,
        })
        return jsonify({"success": True, "message": "Permission request rejected", "request_id": request_id}), 200
    except Exception as e:
        print(f"[ERROR] Failed to reject permission request {request_id}: {e}")
        traceback.print_exc()
        return jsonify({"success": False, "error": str(e)}), 500


@permission_bp.route('/compensation-due', methods=['GET'])
def list_compensation_due():
    """
    Org-wide list of outstanding (un-fulfilled) permission compensations,
    for the Admin Dashboard's small "Compensation Due" table.
    """
    try:
        rows = query_records(PERMISSION_ENTITY, filters={"crc6f_compensated": False})
        today_str = _now_local().date().isoformat()
        due = []
        for row in rows:
            mode = str(row.get("crc6f_compensationmode") or "none").strip().lower()
            if mode == "none":
                continue
            hours = float(row.get("crc6f_compensationhours") or 0)
            if hours <= 0:
                continue
            employee_id = _normalize_employee_id(row.get("crc6f_employeeid"))
            makeup_date = str(row.get("crc6f_makeupdate") or "")[:10]
            due.append({
                "id": row.get("crc6f_permissionid"),
                "permission_id": row.get("crc6f_permission_code"),
                "employee_id": employee_id,
                "employee_name": get_employee_name(employee_id) or employee_id,
                "permission_date": str(row.get("crc6f_date") or "")[:10],
                "hours_due": hours,
                "makeup_date": makeup_date or None,
                "compensation_mode": mode,
                "overdue": bool(makeup_date and makeup_date < today_str),
            })
        due.sort(key=lambda r: r.get("makeup_date") or "")
        return jsonify({"success": True, "due": due, "count": len(due)}), 200
    except Exception as e:
        print(f"[ERROR] Failed to list compensation-due: {e}")
        traceback.print_exc()
        return jsonify({"success": False, "error": str(e), "due": []}), 500


@permission_bp.route('/active/<employee_id>', methods=['GET'])
def get_active_permission(employee_id):
    """
    Return today's permission window (if any) that the employee is currently
    inside of, for the dashboard "On Permission until X" banner.
    """
    try:
        employee_id = _normalize_employee_id(employee_id)
        now_local = _now_local()
        today_str = now_local.date().isoformat()

        rows = query_records(
            PERMISSION_ENTITY,
            filters={"crc6f_employeeid": employee_id, "crc6f_date": today_str},
        )

        active = None
        for row in rows:
            start_t = _parse_time_str(row.get("crc6f_starttime"))
            end_t = _parse_time_str(row.get("crc6f_endtime"))
            if not start_t or not end_t:
                continue
            if start_t <= now_local.time() <= end_t:
                active = row
                break

        if not active:
            return jsonify({"success": True, "active": False}), 200

        normalized = _normalize_permission_row(active)
        return jsonify({"success": True, "active": True, "request": normalized}), 200
    except Exception as e:
        print(f"[ERROR] Failed to get active permission for {employee_id}: {e}")
        traceback.print_exc()
        return jsonify({"success": False, "error": str(e), "active": False}), 500


# ================== AUTO-PAUSE SCHEDULER ==================

def _process_due_permissions():
    """
    Find today's permissions whose start_time has arrived and that haven't
    been processed yet (crc6f_pausedat IS NULL). Force-checkout any employee
    with an active session, then mark the permission as processed either way
    so it is never retried.
    """
    from attendance_service_v2 import perform_checkout_v2

    try:
        now_local = _now_local()
        today_str = now_local.date().isoformat()

        rows = query_records(PERMISSION_ENTITY, filters={"crc6f_date": today_str})
        due_rows = []
        for row in rows:
            if row.get("crc6f_pausedat"):
                continue
            start_t = _parse_time_str(row.get("crc6f_starttime"))
            if not start_t:
                continue
            if now_local.time() >= start_t:
                due_rows.append(row)

        if not due_rows:
            return

        for row in due_rows:
            employee_id = _normalize_employee_id(row.get("crc6f_employeeid"))
            record_id = row.get("crc6f_permissionid")
            if not employee_id or not record_id:
                continue
            try:
                result = perform_checkout_v2(employee_id, tz_name=PERMISSION_TZ)
                if result.get("success"):
                    print(f"[PERMISSION-SCHEDULER] Auto-paused attendance for {employee_id} "
                          f"(permission {row.get('crc6f_permission_code')})")
                elif result.get("error") == "NO_ACTIVE_SESSION":
                    print(f"[PERMISSION-SCHEDULER] {employee_id} had no active session at permission "
                          f"start time - nothing to pause ({row.get('crc6f_permission_code')})")
                else:
                    print(f"[PERMISSION-SCHEDULER] Checkout failed for {employee_id}: {result.get('error')}")
            except Exception as checkout_err:
                print(f"[PERMISSION-SCHEDULER] Error force-checking-out {employee_id}: {checkout_err}")
                traceback.print_exc()
            finally:
                # Mark processed regardless of outcome so we never retry/spam.
                try:
                    update_record(PERMISSION_ENTITY, record_id, {
                        "crc6f_pausedat": datetime.now(timezone.utc).isoformat(),
                    })
                except Exception as mark_err:
                    print(f"[PERMISSION-SCHEDULER] Failed to mark permission {record_id} as paused: {mark_err}")
    except Exception as e:
        print(f"[PERMISSION-SCHEDULER] Tick error: {e}")
        traceback.print_exc()


def _get_worked_seconds_for_date(employee_id, date_str):
    """Best-effort total worked seconds for an employee on a given date.
    Uses the live login-activity row if the session is still open/from that
    day, otherwise falls back to the stored attendance record's duration."""
    from attendance_service_v2 import (
        fetch_login_activity, fetch_attendance_record,
        LA_FIELD_CHECKIN_TS, LA_FIELD_CHECKOUT_TS, LA_FIELD_BASE_SECONDS, LA_FIELD_TOTAL_SECONDS,
        FIELD_DURATION,
    )
    try:
        la = fetch_login_activity(employee_id, date_str)
        if la:
            checkin_ts = la.get(LA_FIELD_CHECKIN_TS)
            checkout_ts = la.get(LA_FIELD_CHECKOUT_TS)
            base_seconds = int(la.get(LA_FIELD_BASE_SECONDS) or 0)
            total_stored = int(la.get(LA_FIELD_TOTAL_SECONDS) or 0)
            if checkin_ts and not checkout_ts:
                now_ts = int(datetime.now(timezone.utc).timestamp())
                return base_seconds + max(0, now_ts - int(checkin_ts))
            if total_stored:
                return total_stored
            return base_seconds
    except Exception as e:
        print(f"[PERMISSION-SCHEDULER] login_activity lookup failed for {employee_id} on {date_str}: {e}")

    try:
        att = fetch_attendance_record(employee_id, date_str)
        if att:
            return int(float(att.get(FIELD_DURATION) or 0) * 3600)
    except Exception as e:
        print(f"[PERMISSION-SCHEDULER] attendance_record lookup failed for {employee_id} on {date_str}: {e}")
    return 0


def _process_compensation_fulfillment():
    """
    For any un-fulfilled compensation whose makeup_date has arrived (today
    or earlier), check whether that day's total worked seconds now covers
    the normal shift requirement PLUS the owed hours. If so, mark it
    compensated so it drops off the "due" list. If the makeup day passes
    without enough hours worked, it just stays flagged as overdue - no
    retroactive penalty beyond whatever the original permission day's own
    Present/Half-day/Absent status already reflects.
    """
    from unified_server import _resolve_employee_shift, _shift_duration_minutes_from_times

    try:
        today_str = _now_local().date().isoformat()
        rows = query_records(PERMISSION_ENTITY, filters={"crc6f_compensated": False})
        for row in rows:
            mode = str(row.get("crc6f_compensationmode") or "none").strip().lower()
            if mode == "none":
                continue
            makeup_date = str(row.get("crc6f_makeupdate") or "")[:10]
            if not makeup_date or makeup_date > today_str:
                continue  # makeup day hasn't arrived yet

            employee_id = _normalize_employee_id(row.get("crc6f_employeeid"))
            record_id = row.get("crc6f_permissionid")
            owed_hours = float(row.get("crc6f_compensationhours") or 0)
            if not employee_id or not record_id or owed_hours <= 0:
                continue

            shift = _resolve_employee_shift(employee_id) or {}
            duration_minutes = _shift_duration_minutes_from_times(shift.get("shift_start"), shift.get("shift_end")) or 0
            required_seconds = int(duration_minutes * 60 + owed_hours * 3600)

            worked_seconds = _get_worked_seconds_for_date(employee_id, makeup_date)
            if worked_seconds >= required_seconds:
                try:
                    update_record(PERMISSION_ENTITY, record_id, {
                        "crc6f_compensated": True,
                        "crc6f_compensatedat": datetime.now(timezone.utc).isoformat(),
                    })
                    print(f"[PERMISSION-SCHEDULER] Compensation fulfilled for {employee_id} "
                          f"({row.get('crc6f_permission_code')}) on {makeup_date}")
                except Exception as mark_err:
                    print(f"[PERMISSION-SCHEDULER] Failed to mark compensation fulfilled for {record_id}: {mark_err}")
    except Exception as e:
        print(f"[PERMISSION-SCHEDULER] Compensation fulfillment check error: {e}")
        traceback.print_exc()


def _tick():
    global _scheduler_timer
    if not _scheduler_running:
        return
    try:
        _process_due_permissions()
    except Exception as e:
        print(f"[PERMISSION-SCHEDULER] Unexpected tick error: {e}")
        traceback.print_exc()
    try:
        _process_compensation_fulfillment()
    except Exception as e:
        print(f"[PERMISSION-SCHEDULER] Unexpected compensation-tick error: {e}")
        traceback.print_exc()
    finally:
        if _scheduler_running:
            _scheduler_timer = threading.Timer(_TICK_SECONDS, _tick)
            _scheduler_timer.daemon = True
            _scheduler_timer.start()


def setup_permission_scheduler(app=None):
    """Start the permission auto-pause scheduler. Safe to call multiple times."""
    global _scheduler_running

    if _scheduler_running:
        print("[PERMISSION-SCHEDULER] Already running, skipping duplicate setup")
        return

    _scheduler_running = True
    print(f"[PERMISSION-SCHEDULER] Starting auto-pause scheduler (every {_TICK_SECONDS}s, timezone: {PERMISSION_TZ})")
    _tick()

    if app:
        app._permission_scheduler_running = True


def shutdown_permission_scheduler():
    global _scheduler_timer, _scheduler_running
    _scheduler_running = False
    if _scheduler_timer:
        _scheduler_timer.cancel()
        _scheduler_timer = None
    print("[PERMISSION-SCHEDULER] Shutdown complete")
