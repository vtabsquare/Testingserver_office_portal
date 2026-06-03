/** Client-side late check: on time through shift_start + grace; late after that minute. */
export function normalizeCheckInForLate(checkInValue) {
  if (!checkInValue) return null;
  const raw = String(checkInValue).trim();
  if (!raw) return null;
  if (raw.includes('T') || /^\d{4}-\d{2}-\d{2}/.test(raw)) {
    const dt = new Date(raw.includes('T') ? raw.replace(' ', 'T') : raw);
    return Number.isNaN(dt.getTime()) ? null : dt;
  }
  if (/^\d{2}:\d{2}(:\d{2})?$/.test(raw)) {
    const parts = raw.split(':');
    const hh = Number(parts[0]);
    const mm = Number(parts[1]);
    if (Number.isInteger(hh) && Number.isInteger(mm)) {
      const d = new Date();
      d.setHours(hh, mm, 0, 0);
      return d;
    }
  }
  return null;
}

/** Format timer/API ms timestamp as HH:MM:SS for late comparison. */
export function formatCheckInFromTimestamp(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = new Date(n);
  if (Number.isNaN(d.getTime())) return null;
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

/** Format stored duration hours as "09h 07m". */
export function formatDurationHours(hours, fallback = '--') {
  const h = Number(hours);
  if (!Number.isFinite(h) || h < 0) return fallback;
  const totalMins = Math.round(h * 60);
  const hrs = Math.floor(totalMins / 60);
  const mins = totalMins % 60;
  return `${String(hrs).padStart(2, '0')}h ${String(mins).padStart(2, '0')}m`;
}

/** Format attendance First In / Last Out for display (IST from API, or ISO → local). */
export function formatAttendanceDisplayTime(value, fallback = '--:--:--') {
  if (!value) return fallback;
  const trimmed = String(value).trim();
  if (!trimmed) return fallback;
  if (trimmed.includes('T') || /^\d{4}-\d{2}-\d{2}/.test(trimmed)) {
    let v = trimmed;
    const hasTZ = /Z$|[+-]\d{2}:?\d{2}$/.test(trimmed);
    if (!hasTZ && /^\d{4}-\d{2}-\d{2}[T ]/.test(trimmed)) {
      v = trimmed.replace(' ', 'T') + 'Z';
    }
    const parsed = new Date(v);
    if (Number.isNaN(parsed.getTime())) return fallback;
    return parsed.toTimeString().split(' ')[0].substring(0, 8);
  }
  // HH:MM(:SS) from monthly API — already normalized to business timezone (IST).
  if (/^\d{2}:\d{2}(:\d{2})?$/.test(trimmed)) {
    return trimmed.length === 5 ? `${trimmed}:00` : trimmed;
  }
  return fallback;
}

/** Pick the later of two HH:MM(:SS) strings (same calendar day). */
export function maxCheckInTime(a, b) {
  if (!a) return b || null;
  if (!b) return a || null;
  const toMin = (t) => {
    const parts = String(t).trim().split(':');
    const hh = Number(parts[0]);
    const mm = Number(parts[1] ?? 0);
    if (!Number.isInteger(hh) || !Number.isInteger(mm)) return -1;
    return hh * 60 + mm;
  };
  return toMin(a) >= toMin(b) ? a : b;
}

/** Pick the earlier of two HH:MM(:SS) strings (same calendar day) — used for First In. */
export function minCheckInTime(a, b) {
  if (!a) return b || null;
  if (!b) return a || null;
  const toMin = (t) => {
    const parts = String(t).trim().split(':');
    const hh = Number(parts[0]);
    const mm = Number(parts[1] ?? 0);
    if (!Number.isInteger(hh) || !Number.isInteger(mm)) return -1;
    return hh * 60 + mm;
  };
  return toMin(a) <= toMin(b) ? a : b;
}

const parseTimeToMinutes = (timeValue) => {
  const parts = String(timeValue || '').split(':');
  if (parts.length < 2) return null;
  const hh = Number(parts[0]);
  const mm = Number(parts[1]);
  if (!Number.isInteger(hh) || !Number.isInteger(mm)) return null;
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return (hh * 60) + mm;
};

const MIN_SHIFT_MINUTES = 2 * 60;

/** Mirror backend: Present = shift duration − tolerance; HL = 50%. */
export function computeThresholdsFromShiftTimes(shiftStart, shiftEnd, toleranceMinutes = 15) {
  const startM = parseTimeToMinutes(shiftStart);
  const endM = parseTimeToMinutes(shiftEnd);
  if (startM === null || endM === null || endM <= startM) return null;
  const minutes = endM - startM;
  if (minutes < MIN_SHIFT_MINUTES) return null;
  const expectedSeconds = minutes * 60;
  const halfDaySeconds = Math.max(1, Math.floor(expectedSeconds * 0.5));
  let tol = Number(toleranceMinutes);
  if (!Number.isFinite(tol) || tol < 0) tol = 15;
  tol = Math.min(tol, minutes - 1);
  const fullDaySeconds = Math.max(
    halfDaySeconds + 1,
    expectedSeconds - Math.floor(tol) * 60
  );
  return {
    shift_start: shiftStart,
    shift_end: shiftEnd,
    expected_seconds: expectedSeconds,
    half_day_seconds: halfDaySeconds,
    full_day_seconds: fullDaySeconds,
    tolerance_minutes: tol,
  };
}

/** Match backend attendance_shift_status: 50% HL; P uses tolerance or API thresholds. */
export function deriveStatusFromWorkedSeconds(totalSeconds, thresholds = null) {
  const worked = Math.max(0, Number(totalSeconds) || 0);
  const half = thresholds?.half_day_seconds ?? 4 * 3600;
  const full = thresholds?.full_day_seconds ?? 9 * 3600;
  if (worked >= full) return 'P';
  if (worked >= half) return 'HL';
  return 'A';
}

export function computeIsLateForShift(checkInValue, shiftStart, graceMinutes = 15) {
  if (!checkInValue || !shiftStart) return false;
  const grace = Number(graceMinutes) || 15;
  const checkinDt = normalizeCheckInForLate(checkInValue);
  if (!checkinDt) return false;
  const checkinMinutes = checkinDt.getHours() * 60 + checkinDt.getMinutes();
  const parts = String(shiftStart).trim().split(':');
  if (parts.length < 2) return false;
  const hh = Number(parts[0]);
  const mm = Number(parts[1]);
  if (!Number.isInteger(hh) || !Number.isInteger(mm)) return false;
  const shiftMinutes = hh * 60 + mm;
  return checkinMinutes > shiftMinutes + grace;
}
