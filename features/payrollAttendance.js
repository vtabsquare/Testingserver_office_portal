/**
 * Payroll monthly export: working_days + paid_days per employee.
 * Rules: INL + Present + paid leaves count; LOP (unpaid) does not; half-day = 0.5.
 */

export const normalizeWorkWeek = (value) =>
  (String(value || '').toLowerCase() === 'mon-fri' ? 'mon-fri' : 'mon-sat');

const normalizeEmployeeFlag = (value) => {
  const n = String(value || '').trim().toLowerCase();
  return n === 'intern' ? 'Intern' : 'Employee';
};

/** Working days in month for employee shift (Mon–Fri vs Mon–Sat; interns include Saturday). */
export function getMonthlyWorkingDays(year, monthIndex, employeeFlag, workWeek = 'mon-sat') {
  const includeSaturdays =
    normalizeWorkWeek(workWeek) === 'mon-sat' ||
    normalizeEmployeeFlag(employeeFlag) === 'Intern';
  const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
  let workingDays = 0;

  for (let day = 1; day <= daysInMonth; day++) {
    const dayOfWeek = new Date(year, monthIndex, day).getDay();
    if (dayOfWeek === 0) continue;
    if (dayOfWeek === 6 && !includeSaturdays) continue;
    workingDays += 1;
  }

  return workingDays;
}

export function isWeeklyOffDay(year, monthIndex, day, workWeek = 'mon-sat') {
  const dayOfWeek = new Date(year, monthIndex, day).getDay();
  if (dayOfWeek === 0) return true;
  if (dayOfWeek === 6 && normalizeWorkWeek(workWeek) === 'mon-fri') return true;
  return false;
}

export function isHolidayOnDay(holidays, year, monthIndex, day) {
  const checkDate = `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return (holidays || []).some((holiday) => {
    const holidayDate = new Date(holiday.crc6f_date);
    const holidayDateStr = `${holidayDate.getFullYear()}-${String(holidayDate.getMonth() + 1).padStart(2, '0')}-${String(holidayDate.getDate()).padStart(2, '0')}`;
    return holidayDateStr === checkDate;
  });
}

const normalizeText = (value) => String(value ?? '').trim().toLowerCase();

function hasUnpaidMarker(value) {
  const text = normalizeText(value);
  return text === 'false' ||
    text === 'unpaid' ||
    text === 'lop' ||
    text.includes('unpaid') ||
    text.includes('lop') ||
    text.includes('loss of pay');
}

function hasPaidMarker(value) {
  const text = normalizeText(value);
  return text === 'true' ||
    text === 'paid' ||
    text === 'pay';
}

function isPaidCompensation(dayData) {
  const candidates = [
    dayData?.compensationType,
    dayData?.paid_unpaid,
    dayData?.paidUnpaid,
    dayData?.compensation,
    dayData?.isPaid,
    dayData?.is_paid,
    dayData?.half,
    dayData?.leaveType,
    dayData?.leaveStatus,
    dayData?.dayDuration,
  ];

  if (candidates.some(hasUnpaidMarker)) return false;
  if (candidates.some(hasPaidMarker)) return true;
  return true;
}

function isHalfDayRecord(dayData) {
  if (!dayData) return false;
  const dayDur = String(dayData.dayDuration || '').toLowerCase();
  if (dayDur.includes('half')) return true;
  if (dayData.half) return true;
  const st = String(dayData.status || '').toUpperCase();
  return st === 'HL' || st === 'H';
}

function hasApprovedLeave(dayData) {
  if (!dayData) return false;
  if (dayData.leaveType) return true;
  const st = String(dayData.status || '').toUpperCase();
  return ['CL', 'SL', 'CO'].includes(st);
}

/**
 * Paid-day credit for one calendar day (0, 0.5, or 1).
 * Skips weekly off (caller should not invoke for DO).
 */
export function computeDayPaidCredit(dayData, isHoliday) {
  const st = String(dayData?.status || '').toUpperCase();

  if (!dayData) {
    return isHoliday ? 1 : 0;
  }

  if (dayData.pendingLeaves?.length && !hasApprovedLeave(dayData) && st !== 'P' && st !== 'HL' && st !== 'H') {
    return 0;
  }

  if (st === 'INL' || (isHoliday && st !== 'A' && st !== 'HL' && st !== 'H' && !hasApprovedLeave(dayData))) {
    if (st === 'P') return 1;
    if (st === 'A') return 0;
    return 1;
  }

  if (hasApprovedLeave(dayData)) {
    const paid = isPaidCompensation(dayData);
    if (isHalfDayRecord(dayData)) {
      // HL + paid leave (CL/SL/CO paid) = full paid day (0.5 work + 0.5 paid leave)
      // HL + unpaid leave (LOP) = only 0.5 (the worked half)
      return paid ? 1 : 0.5;
    }
    return paid ? 1 : 0;
  }

  if (st === 'HL' || st === 'H') return 0.5;
  if (st === 'P') return 1;
  if (st === 'A') return 0;

  if (isHoliday) return 1;

  return 0;
}

export function computePaidDaysForEmployee(empData, year, monthIndex, holidays = []) {
  const workWeek = detectEffectiveWorkWeek(empData || {}, year, monthIndex);
  const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
  let paidDays = 0;

  for (let day = 1; day <= daysInMonth; day++) {
    if (isWeeklyOffDay(year, monthIndex, day, workWeek)) continue;
    const isHoliday = isHolidayOnDay(holidays, year, monthIndex, day);
    const dayData = empData?.[day];
    paidDays += computeDayPaidCredit(dayData, isHoliday);
  }

  return Math.round(paidDays * 10) / 10;
}

/**
 * Detect effective work week from actual Saturday attendance records.
 * If every Saturday in the month has status DO (or no attendance record at all),
 * the employee is Mon-Fri regardless of the stored workWeek metadata.
 */
function detectEffectiveWorkWeek(empData, year, monthIndex) {
  const storedWorkWeek = normalizeWorkWeek(empData.workWeek || 'mon-sat');
  if (storedWorkWeek === 'mon-fri') return 'mon-fri';

  // Even if storedWorkWeek is mon-sat, check actual Saturday records
  const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
  const saturdays = [];
  for (let d = 1; d <= daysInMonth; d++) {
    if (new Date(year, monthIndex, d).getDay() === 6) saturdays.push(d);
  }
  if (saturdays.length === 0) return storedWorkWeek;

  const allSaturdaysAreDO = saturdays.every((d) => {
    const dayData = empData[d];
    if (!dayData) return true; // no record = treated as DO/off
    return String(dayData.status || '').toUpperCase() === 'DO';
  });

  return allSaturdaysAreDO ? 'mon-fri' : 'mon-sat';
}

export function buildPayrollExportRows(attendanceDataByEmployee, year, monthIndex, holidays = []) {
  const month = monthIndex + 1;
  const rows = [];

  Object.keys(attendanceDataByEmployee || {}).forEach((empId) => {
    const empData = attendanceDataByEmployee[empId] || {};
    const workWeek = detectEffectiveWorkWeek(empData, year, monthIndex);
    const employeeFlag = normalizeEmployeeFlag(empData.employeeFlag);
    const workingDays = getMonthlyWorkingDays(year, monthIndex, employeeFlag, workWeek);
    const paidDays = computePaidDaysForEmployee(empData, year, monthIndex, holidays);

    rows.push({
      employee_id: empId,
      employee_name: empData.employeeName || empId,
      month,
      year,
      working_days: workingDays,
      paid_days: paidDays,
    });
  });

  rows.sort((a, b) => String(a.employee_name).localeCompare(String(b.employee_name)));
  return rows;
}

function csvEscape(value) {
  const s = String(value ?? '');
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function exportTeamPayrollCSV(attendanceDataByEmployee, year, monthIndex, holidays = [], monthName = '') {
  const rows = buildPayrollExportRows(attendanceDataByEmployee, year, monthIndex, holidays);
  const headers = ['employee_id', 'employee_name', 'month', 'year', 'working_days', 'paid_days'];
  const csvLines = [
    headers.join(','),
    ...rows.map((r) =>
      [
        csvEscape(r.employee_id),
        csvEscape(r.employee_name),
        r.month,
        r.year,
        r.working_days,
        r.paid_days,
      ].join(',')
    ),
  ];

  const blob = new Blob([csvLines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  const url = URL.createObjectURL(blob);
  const label = (monthName || `month_${monthIndex + 1}`).toLowerCase().replace(/\s+/g, '_');
  link.setAttribute('href', url);
  link.setAttribute('download', `payroll_attendance_${label}_${year}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
