# face_auth_alert_scheduler.py - Backend FaceAuth re-verification alert scheduler
#
# The frontend (features/faceAuthAlert.js) already nags the user in-tab every
# 2 hours to re-verify their face, but that only works while the OfficeHub
# browser tab is open/running. This scheduler moves the same due_soon /
# overdue / missed calculation to the backend - using crc6f_lastfaceverifiedat
# (persisted server-side on face verification) instead of localStorage - and
# pushes an alert to the external Monitoring Tool so its Desktop Agent can
# show a native OS notification even when the OfficeHub tab is closed.
#
# Scope: only employees who currently have an open (checked-in) attendance
# session are evaluated - there's no reason to nag someone who has checked
# out, and the Monitoring Tool's Desktop Agent pauses for them anyway.

import os
import threading
import traceback
from datetime import datetime, timezone, timedelta

try:
    from zoneinfo import ZoneInfo
except ImportError:
    from pytz import timezone as ZoneInfo

FACEAUTH_ALERT_TZ = os.getenv("AUTO_CHECKOUT_TZ", "Asia/Calcutta")

# Mirrors the thresholds in features/faceAuthAlert.js so the backend and the
# in-app frontend banner always agree on state.
REVERIFY_INTERVAL = timedelta(hours=2)
WARNING_THRESHOLD = timedelta(minutes=15)  # due_soon starts 15 min before the 2h mark
MISSED_THRESHOLD = timedelta(minutes=30)   # missed starts 30 min after the 2h mark

# Deep link the Monitoring Tool's native notification opens on click. Once
# loaded (user already logged in), this route immediately triggers the same
# redirectToFaceAuth() flow the in-app banner's "Verify Now" button uses.
FACEAUTH_VERIFY_DEEP_LINK = os.getenv(
    "FACEAUTH_VERIFY_DEEP_LINK",
    "https://officehub360.vtabsquare.com/#/faceauth-reverify",
)

# Scheduler tick interval (seconds).
_TICK_SECONDS = 60

_scheduler_timer = None
_scheduler_running = False


def _parse_timestamp(value):
    """Parse an ISO timestamp (with or without trailing 'Z') into an aware datetime."""
    if not value:
        return None
    try:
        text = str(value)
        if text.endswith("Z"):
            text = text[:-1] + "+00:00"
        dt = datetime.fromisoformat(text)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except Exception:
        return None


def _compute_alert_level(last_verified_at):
    """
    Mirror the frontend's verified/due_soon/overdue/missed state machine
    (features/faceAuthAlert.js: checkFaceAuthStatus()).
    Returns None if there's nothing to compare against yet (never verified
    through the tracked flow) - in that case we don't want to alert blindly.
    """
    if not last_verified_at:
        return None

    now = datetime.now(timezone.utc)
    elapsed = now - last_verified_at
    remaining = REVERIFY_INTERVAL - elapsed

    if remaining > WARNING_THRESHOLD:
        return "verified"
    if remaining > timedelta(0):
        return "due_soon"
    overdue = -remaining
    if overdue < MISSED_THRESHOLD:
        return "overdue"
    return "missed"


def _process_face_auth_alerts():
    from attendance_service_v2 import list_employee_ids_with_open_session_today
    from dataverse_helper import query_records, update_record_by_alt_key
    from monitoring_integration import send_face_verification_alert

    try:
        employee_ids = list_employee_ids_with_open_session_today(tz_name=FACEAUTH_ALERT_TZ)
        if not employee_ids:
            return

        for employee_id in employee_ids:
            try:
                rows = query_records("crc6f_table12s", filters={"crc6f_employeeid": employee_id})
                if not rows:
                    continue
                emp = rows[0]

                face_auth_raw = emp.get("crc6f_faceauthrequired")
                face_auth_required = (
                    face_auth_raw is None or face_auth_raw == ""
                    or str(face_auth_raw).lower() in ("yes", "true", "1")
                )
                if not face_auth_required:
                    continue

                last_verified_at = _parse_timestamp(emp.get("crc6f_lastfaceverifiedat"))
                new_level = _compute_alert_level(last_verified_at)
                if not new_level:
                    continue  # never verified through the tracked flow yet - nothing to compare against

                stored_level = emp.get("crc6f_lastfacealertlevel") or "verified"
                if new_level == stored_level:
                    continue  # no change since last tick - don't re-notify

                # Persist the new level regardless of outcome below, so we
                # never re-evaluate/spam the same transition every tick.
                try:
                    update_record_by_alt_key(
                        "crc6f_table12s",
                        employee_id,
                        {"crc6f_lastfacealertlevel": new_level},
                        alt_key_field="crc6f_employeeid",
                    )
                except Exception as persist_err:
                    print(f"[FACEAUTH-ALERT-SCHEDULER] Failed to persist alert level for {employee_id}: {persist_err}")

                if new_level in ("due_soon", "overdue", "missed"):
                    send_face_verification_alert(employee_id, new_level, FACEAUTH_VERIFY_DEEP_LINK)
                    print(f"[FACEAUTH-ALERT-SCHEDULER] {employee_id}: {stored_level} -> {new_level} (alert sent)")
                else:
                    print(f"[FACEAUTH-ALERT-SCHEDULER] {employee_id}: {stored_level} -> {new_level}")
            except Exception as emp_err:
                print(f"[FACEAUTH-ALERT-SCHEDULER] Error processing {employee_id}: {emp_err}")
                traceback.print_exc()
    except Exception as e:
        print(f"[FACEAUTH-ALERT-SCHEDULER] Tick error: {e}")
        traceback.print_exc()


def _tick():
    global _scheduler_timer
    if not _scheduler_running:
        return
    try:
        _process_face_auth_alerts()
    except Exception as e:
        print(f"[FACEAUTH-ALERT-SCHEDULER] Unexpected tick error: {e}")
        traceback.print_exc()
    finally:
        if _scheduler_running:
            _scheduler_timer = threading.Timer(_TICK_SECONDS, _tick)
            _scheduler_timer.daemon = True
            _scheduler_timer.start()


def setup_face_auth_alert_scheduler(app=None):
    """Start the FaceAuth re-verification alert scheduler. Safe to call multiple times."""
    global _scheduler_running

    if _scheduler_running:
        print("[FACEAUTH-ALERT-SCHEDULER] Already running, skipping duplicate setup")
        return

    _scheduler_running = True
    print(f"[FACEAUTH-ALERT-SCHEDULER] Starting (every {_TICK_SECONDS}s, timezone: {FACEAUTH_ALERT_TZ})")
    _tick()

    if app:
        app._face_auth_alert_scheduler_running = True


def shutdown_face_auth_alert_scheduler():
    global _scheduler_timer, _scheduler_running
    _scheduler_running = False
    if _scheduler_timer:
        _scheduler_timer.cancel()
        _scheduler_timer = None
    print("[FACEAUTH-ALERT-SCHEDULER] Shutdown complete")
