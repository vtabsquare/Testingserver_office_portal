"""
Shift-relative attendance status (P / HL / A).

Present  : worked >= (scheduled shift length - tolerance_minutes)
Half day : worked >= 50% of scheduled shift length
Absent   : worked < 50%

Late uses grace_minutes (shift_start + grace) — unchanged in unified_server.

Check-in/check-out mechanics are unchanged; only classification uses shift settings.
"""

from __future__ import annotations

MIN_SHIFT_HOURS = 2
MIN_SHIFT_MINUTES = MIN_SHIFT_HOURS * 60
HALF_DAY_RATIO = 0.50
PRESENT_RATIO = 0.95  # Fallback when tolerance_minutes not configured
DEFAULT_TOLERANCE_MINUTES = 15
MAX_TOLERANCE_MINUTES = 120


def validate_shift_window(shift_start, shift_end):
    """Return (ok, error_message) for shift timing validation."""
    if not shift_start or not shift_end:
        return False, "shift_start and shift_end are required (HH:MM)"
    from unified_server import _time_to_minutes

    duration_minutes = _time_to_minutes(shift_end) - _time_to_minutes(shift_start)
    if duration_minutes < MIN_SHIFT_MINUTES:
        return False, f"Shift timing should be minimum {MIN_SHIFT_HOURS} hours"
    if duration_minutes <= 0:
        return False, "Shift end must be after shift start"
    return True, None


def normalize_tolerance_minutes(value, shift_duration_minutes=None):
    """Clamp tolerance to 0..MAX; must stay below shift length."""
    try:
        minutes = int(value)
    except (TypeError, ValueError):
        minutes = DEFAULT_TOLERANCE_MINUTES
    minutes = max(0, min(MAX_TOLERANCE_MINUTES, minutes))
    if shift_duration_minutes is not None:
        # Present threshold must remain above half-day threshold
        max_tol = max(0, int(shift_duration_minutes) - 1)
        minutes = min(minutes, max_tol)
    return minutes


def _resolve_employee_shift(employee_id):
    from unified_server import _resolve_employee_shift

    return _resolve_employee_shift(employee_id)


def _shift_expected_seconds(shift_start, shift_end):
    from unified_server import _time_to_minutes

    try:
        start_m = _time_to_minutes(shift_start)
        end_m = _time_to_minutes(shift_end)
        if end_m <= start_m:
            return None
        minutes = end_m - start_m
        if minutes < MIN_SHIFT_MINUTES:
            return None
        return minutes * 60
    except Exception:
        return None


def _present_seconds_from_shift(expected_seconds, tolerance_minutes, half_day_seconds):
    """Present threshold = shift duration minus tolerance (e.g. 9h - 15m = 8h45m)."""
    if tolerance_minutes is None:
        return max(half_day_seconds + 1, int(expected_seconds * PRESENT_RATIO))
    tol_sec = int(normalize_tolerance_minutes(tolerance_minutes)) * 60
    full_s = int(expected_seconds) - tol_sec
    return max(half_day_seconds + 1, full_s)


def get_shift_thresholds_for_employee(employee_id):
    """
    Thresholds derived from employee_shift_settings (or defaults).
    Example: 09:00-18:00, 15m tolerance => HL>=4.5h, P>=8h45m.
    """
    shift = _resolve_employee_shift(employee_id) or {}
    shift_start = shift.get("shift_start") or "09:00"
    shift_end = shift.get("shift_end") or "18:00"
    expected_seconds = _shift_expected_seconds(shift_start, shift_end)
    shift_duration_minutes = (
        int(expected_seconds / 60) if expected_seconds else MIN_SHIFT_MINUTES
    )
    if not expected_seconds:
        expected_seconds = 9 * 3600
        using_shift = False
        shift_duration_minutes = 9 * 60
    else:
        using_shift = True

    tolerance_raw = shift.get("tolerance_minutes")
    use_tolerance = tolerance_raw is not None and str(tolerance_raw).strip() != ""
    tolerance_minutes = (
        normalize_tolerance_minutes(tolerance_raw, shift_duration_minutes)
        if use_tolerance
        else None
    )

    half_day_seconds = max(1, int(expected_seconds * HALF_DAY_RATIO))
    full_day_seconds = _present_seconds_from_shift(
        expected_seconds, tolerance_minutes, half_day_seconds
    )

    present_mode = "tolerance" if use_tolerance else "ratio_fallback"

    return {
        "shift_start": shift_start,
        "shift_end": shift_end,
        "expected_seconds": int(expected_seconds),
        "expected_hours": round(expected_seconds / 3600.0, 2),
        "half_day_seconds": half_day_seconds,
        "full_day_seconds": full_day_seconds,
        "half_day_hours": round(half_day_seconds / 3600.0, 2),
        "full_day_hours": round(full_day_seconds / 3600.0, 2),
        "half_day_ratio": HALF_DAY_RATIO,
        "present_ratio": PRESENT_RATIO,
        "present_mode": present_mode,
        "tolerance_minutes": tolerance_minutes if use_tolerance else DEFAULT_TOLERANCE_MINUTES,
        "grace_minutes": int(shift.get("grace_minutes") or 15),
        "work_week": shift.get("work_week") or "mon-sat",
        "using_employee_shift": using_shift,
    }


def classify_seconds_for_employee(employee_id, total_seconds):
    """Map worked seconds to P / HL / A using per-employee shift thresholds."""
    thresholds = get_shift_thresholds_for_employee(employee_id)
    worked = max(0, int(total_seconds or 0))
    if worked >= thresholds["full_day_seconds"]:
        return "P"
    if worked >= thresholds["half_day_seconds"]:
        return "HL"
    return "A"


def classify_hours_for_employee(employee_id, hours_val):
    seconds = max(0, int(round(float(hours_val or 0) * 3600)))
    return classify_seconds_for_employee(employee_id, seconds)


def build_threshold_payload_for_employee(employee_id, total_seconds):
    """Progress payload for legacy status endpoints (optional employee-aware)."""
    thresholds = get_shift_thresholds_for_employee(employee_id)
    safe_seconds = max(0, int(total_seconds or 0))
    half_s = thresholds["half_day_seconds"]
    full_s = thresholds["full_day_seconds"]
    payload = {
        "half_day_seconds": half_s,
        "full_day_seconds": full_s,
        "expected_seconds": thresholds["expected_seconds"],
        "tolerance_minutes": thresholds.get("tolerance_minutes"),
        "present_mode": thresholds.get("present_mode"),
        "half_day_reached": safe_seconds >= half_s,
        "full_day_reached": safe_seconds >= full_s,
        "next_threshold_seconds": None,
    }
    if safe_seconds < half_s:
        payload["next_threshold_seconds"] = half_s - safe_seconds
    elif safe_seconds < full_s:
        payload["next_threshold_seconds"] = full_s - safe_seconds
    return payload


def status_label(status_code):
    labels = {"P": "Present", "HL": "Half Day", "A": "Absent"}
    return labels.get(status_code, "Absent")
