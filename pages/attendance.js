import { API_BASE_URL } from '../config.js';
import { state } from '../state.js';
import { fetchMonthlyAttendance, invalidateAttendanceCache } from '../features/attendanceApi.js';
import { getHolidays } from '../features/holidaysApi.js';
import { renderModal, closeModal } from '../components/modal.js';
import { clearCacheByPrefix } from '../features/cache.js';
import { isAdminUser, isManagerOrAdmin, isTeamLeadUser } from '../utils/accessControl.js';
import { fetchLoginEvents } from '../features/loginSettingsApi.js';
import { fetchShiftSettings } from '../features/shiftSettingsApi.js';
import {
    computeIsLateForShift,
    formatAttendanceDisplayTime,
    formatDurationHours,
    minCheckInTime,
} from '../features/shiftLate.js';
import { runWithSubmissionLoading } from '../utils/submissionLoading.js';

/** Set isLate from first check-in vs shift (independent of P/A/HL status). */
const applyLateFlagsToAttendanceMap = (attendanceMap, employeeId, shiftRes) => {
    const uid = String(employeeId || '').toUpperCase();
    const shift = shiftRes?.by_employee?.[uid] || shiftRes?.defaults || {};
    const shiftStart = shift.shift_start || '09:00';
    const grace = shift.grace_minutes || 15;
    attendanceMap.shiftStart = shiftStart;
    attendanceMap.graceMinutes = grace;
    Object.keys(attendanceMap).forEach((key) => {
        if (!/^\d+$/.test(key)) return;
        const dayData = attendanceMap[key];
        if (!dayData?.checkIn) return;
        dayData.isLate = computeIsLateForShift(dayData.checkIn, shiftStart, grace);
    });
};

/** Recompute late flag for today from First In (do not replace checkIn with current session). */
const mergeActiveTimerLateForToday = (attendanceMap, year, month, shiftStart, graceMin) => {
    if (!state.timer?.isRunning) return;
    const now = new Date();
    if (now.getFullYear() !== year || now.getMonth() + 1 !== month) return;
    const day = now.getDate();
    const row = attendanceMap[day] || { day, status: 'A' };
    if (row.checkIn) {
        row.isLate = computeIsLateForShift(row.checkIn, shiftStart, graceMin);
    }
    row.shiftStart = shiftStart;
    row.graceMinutes = graceMin;
    attendanceMap[day] = row;
};

/** Merge late_markers from monthly attendance API (login-activity table on server). */
const mergeLateFlagsFromTable = (attendanceMap, lateMarkers = {}) => {
    Object.entries(lateMarkers || {}).forEach(([dayKey, marker]) => {
        const day = Number(dayKey);
        if (!day || !marker) return;
        const row = attendanceMap[day] || { day, status: 'A' };
        if (marker.checkIn) {
            row.checkIn = minCheckInTime(row.checkIn, marker.checkIn) || marker.checkIn;
        }
        if (typeof marker.isLate === 'boolean') row.isLate = marker.isLate;
        attendanceMap[day] = row;
    });
};

const isManagerUserAttendance = () => {
    try {
        if (isManagerOrAdmin()) return true;
        const desig = String(state.user?.designation || '').toLowerCase();
        return desig.includes('manager');
    } catch { return false; }
};

const canViewTeamAttendance = () => {
    try {
        return isAdminUser() || isManagerUserAttendance() || isTeamLeadUser();
    } catch {
        return false;
    }
};

const canEditTeamAttendance = () => {
    try {
        return isAdminUser();
    } catch {
        return false;
    }
};

// Store holidays globally for the current page
let currentMonthHolidays = [];

// Helper function to check if a date is a holiday
const isHolidayDate = (year, month, day) => {
    const checkDate = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    return currentMonthHolidays.some(holiday => {
        const holidayDate = new Date(holiday.crc6f_date);
        const holidayDateStr = `${holidayDate.getFullYear()}-${String(holidayDate.getMonth() + 1).padStart(2, '0')}-${String(holidayDate.getDate()).padStart(2, '0')}`;
        return holidayDateStr === checkDate;
    });
};

const normalizeWorkWeek = (value) => (String(value || '').toLowerCase() === 'mon-fri' ? 'mon-fri' : 'mon-sat');
const isWeeklyOffDate = (year, month, day, workWeek = 'mon-sat') => {
    const dayOfWeek = new Date(year, month, day).getDay();
    if (dayOfWeek === 0) return true; // Sunday always weekly off
    if (dayOfWeek === 6 && normalizeWorkWeek(workWeek) === 'mon-fri') return true; // Saturday weekly off for Mon-Fri
    return false;
};

export const renderAttendanceTrackerPage = async (mode) => {
    const date = state.currentAttendanceDate;
    const monthName = date.toLocaleString('default', { month: 'long' });
    const year = date.getFullYear();

    const getStatusCellHTML = (dayData, isHoliday = false, isWeeklyOff = false) => {
        // A weekly-off day (Saturday for mon-fri employees, Sundays for everyone)
        // should show DO unless the employee actually has activity that day
        // (a real check-in, an approved/pending leave, or a present/half status).
        // This keeps "existing behaviour" for those who do work, while reliably
        // showing DO for those who don't — even if a stray empty/absent record exists.
        if (isWeeklyOff) {
            const dayStatus = String(dayData?.status || '').toUpperCase();
            const hasRealActivity = !!dayData && (
                !!dayData.checkIn ||
                !!dayData.leaveType ||
                (Array.isArray(dayData.pendingLeaves) && dayData.pendingLeaves.length > 0) ||
                ['P', 'HL', 'H', 'CL', 'SL', 'CO'].includes(dayStatus)
            );
            if (!hasRealActivity) {
                return `
                    <div class="status-cell status-do">DO</div>
                `;
            }
        }
        if (!dayData) {
            // If it's a holiday but no attendance data, show INL
            if (isHoliday) {
                return `
                    <div class="status-cell status-inl">INL</div>
                `;
            }
            return '';
        }
        const { status, isLate, isManual, isPending, half, EOP, leaveType, compensationType, leaveStart, leaveEnd, pendingLeaves = [], dayDuration } = dayData;

        const normalizedStatus = status === 'H' ? 'HL' : status;
        const isHalfDayLeaveFromLeave = String(dayDuration || '').toLowerCase().includes('half');
        const isHalfDayLeave = isHalfDayLeaveFromLeave
            || (leaveType && (normalizedStatus === 'HL' || status === 'HL'));
        let content = normalizedStatus;
        // Full-day approved leave → CL/SL/CO (+ LOP if unpaid). Half-day → HL block below.
        if (leaveType && !isHalfDayLeave) {
            const lt = String(leaveType).toLowerCase();
            let code = '';

            if (lt.includes('casual')) {
                code = 'CL';
            } else if (lt.includes('sick')) {
                code = 'SL';
            } else if (lt.includes('comp')) {
                code = 'CO';
            }

            const isPaid = String(compensationType || '').toLowerCase() === 'paid';
            const tooltip = `${leaveType} (${isPaid ? 'Paid' : 'Unpaid'})${leaveStart ? ` | ${leaveStart}` : ''}${leaveEnd ? ` → ${leaveEnd}` : ''}`;

            // Show LOP in red for unpaid leave
            const lopLine = isPaid
                ? ''
                : '<div class="leave-lop-text">(LOP)</div>';

            content = `
                <div class="leave-code" title="${tooltip}">
                    <div class="leave-code-symbol leave-${String(code).toLowerCase()}">${code}</div>
                    ${lopLine}
                </div>`;
        }
        if (isHalfDayLeave || status === 'HL' || status === 'H') {
            let halfText = half ? String(half) : '';
            if (!halfText && leaveType) {
                const lt = String(leaveType).toLowerCase();
                if (lt.includes('casual')) halfText = 'CL';
                else if (lt.includes('sick')) halfText = 'SL';
                else if (lt.includes('comp')) halfText = 'CO';
            }
            const extraParts = [];
            if (halfText) extraParts.push(halfText);
            const isPaidLeave = String(compensationType || '').toLowerCase() === 'paid';
            if (leaveType && !isPaidLeave) extraParts.push('(LOP)');
            if (EOP) extraParts.push('(EOP)');
            const leaveTooltip = leaveType
                ? `${leaveType} – Half Day (${isPaidLeave ? 'Paid' : 'Unpaid'})${leaveStart ? ` | ${leaveStart}` : ''}`
                : 'Half day';
            const extraLine = extraParts.length
                ? `<div class="status-hl-half">${extraParts.join(' ')}</div>`
                : '';
            content = `<div class="status-hl-text" title="${leaveTooltip}">HL</div>${extraLine}`;
        } else if (EOP) {
            content = `${status} (EOP)`;
        }

        const pendingOverlay = pendingLeaves.length
            ? `
                <div class="pending-leave-overlay" title="${pendingLeaves.map(pl => `${pl.leaveType || 'Leave'} (${pl.status || 'Pending'}) ${pl.start || ''}${pl.end ? ` → ${pl.end}` : ''}`).join('\n')}">
                    <span class="pending-label">Pending</span>
                    <div class="pending-dates">
                        ${pendingLeaves.map(pl => `
                            <span class="pending-chip">${(pl.leaveType || '').split(' ')[0] || 'Leave'}</span>
                        `).join('')}
                    </div>
                </div>
            `
            : '';

        const shiftStart = dayData.shiftStart || dayData._shiftStart || '09:00';
        const graceMin = dayData.graceMinutes || dayData._graceMinutes || 15;
        const showLate = !!isLate || (
            dayData.checkIn
                ? computeIsLateForShift(dayData.checkIn, shiftStart, graceMin)
                : false
        );

        const statusIcons = [
            showLate ? '<i class="fa-solid fa-clock-rotate-left late-icon" title="Late entry"></i>' : '',
            isManual ? '<i class="fa-solid fa-users manual-icon" title="Manually edited by admin"></i>' : '',
            isPending ? '<i class="fa-solid fa-triangle-exclamation pending-icon" title="Pending"></i>' : ''
        ].filter(Boolean).join('');

        return `
            <div class="status-cell status-${normalizedStatus.toLowerCase()}">
                ${content}
                ${pendingOverlay}
                ${statusIcons ? `<div class="status-icons">${statusIcons}</div>` : ''}
            </div>
        `;
    }

    const daysInMonth = new Date(year, date.getMonth() + 1, 0).getDate();

    const getTeamViewHTML = () => {
        const daysHeader = Array.from({ length: daysInMonth }, (_, i) => {
            const day = i + 1;
            const dayName = new Date(year, date.getMonth(), day).toLocaleString('default', { weekday: 'short' }).toUpperCase();
            return `<th class="attendance-day-header"><div class="day-name">${dayName}</div><div class="day-number">${String(day).padStart(2, '0')}</div></th>`;
        }).join('');

        // Get all employee IDs from the attendance data
        const employeeIds = Object.keys(state.attendanceData);
        const normalizedMeta = employeeIds.reduce((acc, id) => {
            const entryName = state.attendanceData[id]?.employeeName;
            if (entryName) acc[id] = entryName;
            return acc;
        }, {});
        console.log('📊 Rendering team attendance for employees:', employeeIds);

        // Calculate stats from all attendance data for the entire month
        let totalPresent = 0;
        let totalLate = 0;
        let totalLeaves = 0;
        let totalAbsent = 0;

        employeeIds.forEach(empId => {
            const empData = state.attendanceData[empId] || {};
            const workWeek = normalizeWorkWeek(empData.workWeek || 'mon-sat');
            for (let day = 1; day <= daysInMonth; day++) {
                if (isWeeklyOffDate(year, date.getMonth(), day, workWeek)) continue;
                const dayData = empData[day];
                if (dayData) {
                    if (dayData.leaveType) {
                        totalLeaves++;
                    } else if (dayData.status === 'P') {
                        totalPresent++;
                        if (dayData.isLate) totalLate++;
                    } else if (dayData.status === 'A') {
                        totalAbsent++;
                    }
                }
            }
        });

        // Generate rows for each employee
        const employeeRows = employeeIds.map(empId => {
            const empData = state.attendanceData[empId] || {};
            const employeeName =
                normalizedMeta[empId] ||
                empData.employeeName ||
                empId;
            const workWeek = normalizeWorkWeek(empData.workWeek || 'mon-sat');

            // Get initials for avatar
            const nameParts = employeeName.split(' ');
            const initials = nameParts.length >= 2
                ? `${nameParts[0][0]}${nameParts[1][0]}`.toUpperCase()
                : employeeName.substring(0, 2).toUpperCase();

            // Generate cells for each day of the month
            const dayCells = Array.from({ length: daysInMonth }, (_, i) => {
                const dayNum = i + 1;
                const dayData = empData[dayNum];
                const isHoliday = isHolidayDate(year, date.getMonth(), dayNum);
                const isWeeklyOff = isWeeklyOffDate(year, date.getMonth(), dayNum, workWeek);
                const cellHTML = getStatusCellHTML(dayData, isHoliday, isWeeklyOff);
                return `<td class="team-day-cell" data-emp-id="${empId}" data-day="${dayNum}">${cellHTML}</td>`;
            }).join('');

            return `
                <tr class="employee-row">
                    <td class="employee-name-cell">
                        <div class="employee-avatar">${initials}</div>
                        <div class="employee-details">
                            <div class="employee-name">${employeeName}</div>
                        </div>
                    </td>
                    ${dayCells}
                </tr>
            `;
        }).join('');

        return `
            <!-- Summary Cards -->
            <div class="attendance-summary-cards">
                <div class="summary-card">
                    <div class="summary-label">Late Entry</div>
                    <div class="summary-value">${totalLate}</div>
                </div>
                <div class="summary-card">
                    <div class="summary-label">No. of Leaves</div>
                    <div class="summary-value">${totalLeaves}</div>
                </div>
                <div class="summary-card">
                    <div class="summary-label">Present</div>
                    <div class="summary-value">${totalPresent}</div>
                </div>
                <div class="summary-card">
                    <div class="summary-label">Absent</div>
                    <div class="summary-value">${totalAbsent}</div>
                </div>
            </div>

            <div class="clean-attendance-table">
                <div class="table-scroll-wrapper">
                    <table class="team-attendance-table">
                        <thead>
                            <tr>
                                <th class="employee-column-header">EMPLOYEE</th>
                                ${daysHeader}
                            </tr>
                        </thead>
                        <tbody>${employeeRows || `<tr><td colspan="${daysInMonth + 1}" class="placeholder-text">No active employees to display.</td></tr>`}</tbody>
                    </table>
                </div>
            </div>
            <div class="attendance-legend">
                <div class="legend-item"><span class="legend-code legend-code-p">P</span><span>Present</span></div>
                <div class="legend-item"><span class="legend-code legend-code-a">A</span><span>Absent</span></div>
                <div class="legend-item"><span class="legend-code legend-code-hl">HL</span><span>Half day / Holiday</span></div>
                <div class="legend-item"><span class="legend-code legend-code-cl">CL</span><span>Casual leave</span></div>
                <div class="legend-item"><span class="legend-code legend-code-sl">SL</span><span>Sick leave</span></div>
                <div class="legend-item"><span class="legend-code legend-code-co">CO</span><span>Comp off</span></div>
                <div class="legend-item"><span class="legend-code legend-code-do">DO</span><span>Weekly day off</span></div>
                <div class="legend-item"><span class="legend-code legend-code-inl">INL</span><span>Indian national holiday</span></div>
            </div>
            
            <!-- Holiday section will be loaded dynamically -->
            <div id="holiday-section" class="holiday-section"></div>
        `;
    };

    const getMyViewHTML = async () => {
        const normalizedUserId = String(state.user?.id || '').toUpperCase();
        const myAttendance = state.attendanceData[normalizedUserId] || state.attendanceData[state.user.id] || {};
        const myWorkWeek = normalizeWorkWeek(myAttendance.workWeek || 'mon-sat');
        const month = date.getMonth();
        const firstDayIndex = new Date(year, month, 1).getDay(); // Sunday = 0

        const calendarCells = [];

        for (let i = 0; i < firstDayIndex; i++) {
            calendarCells.push('<div class="calendar-day empty"></div>');
        }

        const mapShiftStart = myAttendance.shiftStart || '09:00';
        const mapGrace = myAttendance.graceMinutes || 15;

        for (let i = 1; i <= daysInMonth; i++) {
            const rawDay = myAttendance[i];
            const dayData = rawDay
                ? {
                    ...rawDay,
                    shiftStart: rawDay.shiftStart || mapShiftStart,
                    graceMinutes: rawDay.graceMinutes || mapGrace,
                }
                : rawDay;
            const isSelected = i === state.selectedAttendanceDay;
            const isHoliday = isHolidayDate(year, month, i);
            const isWeeklyOff = isWeeklyOffDate(year, month, i, myWorkWeek);
            const statusHTML = getStatusCellHTML(dayData, isHoliday, isWeeklyOff);

            calendarCells.push(`
                <div class="calendar-day ${isSelected ? 'selected' : ''}" data-day="${i}">
                    <div class="day-header">${i}</div>
                    <div class="day-content">${statusHTML || '&nbsp;'}</div>
                </div>
            `);
        }

        const yearMonth = `${year}-${String(month + 1).padStart(2, '0')}`;

        // Get ONLY TODAY's data for current day login details
        const todayDate = new Date();
        const isCurrentMonth = year === todayDate.getFullYear() && month === todayDate.getMonth();
        const todayDay = isCurrentMonth ? todayDate.getDate() : null;

        // NOTE:
        // We intentionally do NOT use "login activity" for First In / Last Out here.
        // Login-activity represents the *current session* and can be overwritten on re-checkin.
        // Attendance table preserves the day's first check-in and last checkout.

        const todayLogDays = [];
        if (todayDay) {
            const todayRow = myAttendance[todayDay] || { day: todayDay, status: 'A' };
            if (todayRow.checkIn || todayRow.checkOut || state.timer?.isRunning) {
                todayLogDays.push(todayRow);
            }
        }

        const buildWeekMonthRows = async () => {
            const filter = state.attendanceFilter || 'week';
            const today = new Date();
            const viewingCurrentMonth = year === today.getFullYear() && month === today.getMonth();
            const monthStart = new Date(year, month, 1);
            const monthEnd = new Date(year, month, daysInMonth);

            let rangeStart;
            let rangeEnd;

            if (filter === 'week') {
                const referenceDate = viewingCurrentMonth
                    ? today
                    : new Date(year, month, state.selectedAttendanceDay || Math.min(daysInMonth, 15));
                rangeStart = new Date(referenceDate);
                rangeStart.setDate(referenceDate.getDate() - referenceDate.getDay());
                rangeEnd = new Date(rangeStart);
                rangeEnd.setDate(rangeStart.getDate() + 6);
            } else {
                rangeStart = new Date(monthStart);
                rangeEnd = new Date(monthEnd);
            }

            if (rangeStart < monthStart) rangeStart = new Date(monthStart);
            if (rangeEnd > monthEnd) rangeEnd = new Date(monthEnd);

            if (viewingCurrentMonth && rangeEnd > today) rangeEnd = new Date(today);

            const formatLocalDate = (dateObj) => {
                return `${dateObj.getFullYear()}-${String(dateObj.getMonth() + 1).padStart(2, '0')}-${String(dateObj.getDate()).padStart(2, '0')}`;
            };
            const fromStr = formatLocalDate(rangeStart);
            const toStr = formatLocalDate(rangeEnd);

            try {
                const loginData = await fetchLoginEvents({
                    employee_id: String(state.user.id || '').toUpperCase(),
                    from: fromStr,
                    to: toStr,
                });

                const summaryMap = new Map();
                (loginData.daily_summary || []).forEach((entry) => {
                    if (entry?.date) summaryMap.set(entry.date, entry);
                });

                const rows = [];

                for (let cursor = new Date(rangeEnd); cursor >= rangeStart; cursor.setDate(cursor.getDate() - 1)) {
                    const dateStr = formatLocalDate(cursor);
                    const dayNumber = cursor.getDate();
                    const summary = summaryMap.get(dateStr) || {};
                    const attendanceFallback = myAttendance[dayNumber] || {};

                    // Prefer attendance table for First In / Last Out.
                    // (login-activity is session-level and may reflect the latest re-checkin)
                    const checkInTime = attendanceFallback.checkIn
                        ? formatAttendanceDisplayTime(attendanceFallback.checkIn)
                        : (summary.check_in_time ? formatAttendanceDisplayTime(summary.check_in_time) : '--:--:--');
                    let checkOutTime = attendanceFallback.checkOut
                        ? formatAttendanceDisplayTime(attendanceFallback.checkOut)
                        : (summary.check_out_time ? formatAttendanceDisplayTime(summary.check_out_time) : '--:--:--');
                    const checkInForCompare = attendanceFallback.checkIn
                        ? formatAttendanceDisplayTime(attendanceFallback.checkIn)
                        : (summary.check_in_time ? formatAttendanceDisplayTime(summary.check_in_time) : '');
                    if (checkOutTime && checkInForCompare && checkOutTime < checkInForCompare && checkOutTime.startsWith('05:30')) {
                        checkOutTime = '00:00:00';
                    }

                    let totalTimeHTML = '--';
                    const { duration } = attendanceFallback;
                    if (typeof duration === 'number' && Number.isFinite(duration) && duration >= 0) {
                        totalTimeHTML = formatDurationHours(duration);
                    } else if (summary.total_seconds != null && Number(summary.total_seconds) >= 0) {
                        totalTimeHTML = formatDurationHours(Number(summary.total_seconds) / 3600);
                    } else if (attendanceFallback.leaveType) {
                        totalTimeHTML = 'Leave';
                    }

                    rows.push(`
                        <tr>
                            <td>${String(dayNumber).padStart(2, '0')} ${cursor.toLocaleString('default', { month: 'short' })} ${cursor.getFullYear()}</td>
                            <td>${checkInTime}</td>
                            <td>${checkOutTime}</td>
                            <td>${totalTimeHTML}</td>
                        </tr>`);
                }

                if (rows.length === 0) {
                    const filterText = filter === 'week' ? 'this week' : 'this month';
                    return `<tr><td colspan="4" class="placeholder-text">No login data for ${filterText}</td></tr>`;
                }

                return rows.join('');
            } catch (err) {
                console.warn('⚠️ Failed to fetch login activity for week/month:', err);
                const filterText = (state.attendanceFilter || 'week') === 'week' ? 'this week' : 'this month';
                return `<tr><td colspan="4" class="placeholder-text">Unable to load login data for ${filterText}</td></tr>`;
            }
        };

        const entryExitDetailsHTML = await buildWeekMonthRows();

        const recentLogDays = todayLogDays;

        const firstLastOutRows = recentLogDays.map(d => {
            let checkInTime = formatAttendanceDisplayTime(d.checkIn, '');
            let checkOutTime = formatAttendanceDisplayTime(d.checkOut, '');

            let totalTimeHTML = '--';
            if (typeof d.duration === 'number' && Number.isFinite(d.duration) && d.duration >= 0) {
                totalTimeHTML = formatDurationHours(d.duration);
            } else if (
                isCurrentMonth
                && d.day === todayDay
                && state.timer?.isRunning
                && Number.isFinite(state.timer.startTime)
            ) {
                const elapsedSec = Math.max(0, Math.floor((Date.now() - state.timer.startTime) / 1000));
                totalTimeHTML = formatDurationHours(elapsedSec / 3600);
            }

            return `
            <tr>
                <td>${d.day} ${date.toLocaleString('default', { month: 'short' })} ${year}</td>
                <td>${checkInTime || '--:--:--'}</td>
                <td>${checkOutTime || '--:--:--'}</td>
                <td>${totalTimeHTML}</td>
            </tr>`
        }).join('') || `<tr><td colspan="4" class="placeholder-text">No recent check-in data</td></tr>`;

        return `
            <div class="my-attendance-grid">
                <div class="calendar-header">Sun</div>
                <div class="calendar-header">Mon</div>
                <div class="calendar-header">Tue</div>
                <div class="calendar-header">Wed</div>
                <div class="calendar-header">Thu</div>
                <div class="calendar-header">Fri</div>
                <div class="calendar-header">Sat</div>
                ${calendarCells.join('')}
            </div>
            <div class="attendance-legend">
                <div class="legend-item"><span class="legend-code legend-code-p">P</span><span>Present</span></div>
                <div class="legend-item"><span class="legend-code legend-code-a">A</span><span>Absent</span></div>
                <div class="legend-item"><span class="legend-code legend-code-hl">HL</span><span>Half day / Holiday</span></div>
                <div class="legend-item"><span class="legend-code legend-code-cl">CL</span><span>Casual leave</span></div>
                <div class="legend-item"><span class="legend-code legend-code-sl">SL</span><span>Sick leave</span></div>
                <div class="legend-item"><span class="legend-code legend-code-co">CO</span><span>Comp off</span></div>
                <div class="legend-item"><span class="legend-code legend-code-do">DO</span><span>Weekly day off</span></div>
                <div class="legend-item"><span class="legend-code legend-code-inl">INL</span><span>Indian national holiday</span></div>
            </div>
            
            <!-- Holiday section will be loaded dynamically -->
            <div id="holiday-section" class="holiday-section"></div>
            
            <!-- Login Details Grid -->
            <div class="login-details-grid">
                <div class="login-details-card">
                    <h4 class="login-details-title">Current Day Login Details</h4>
                    <div class="table-container">
                        <table class="table">
                        <thead><tr><th>Date</th><th>First in</th><th>Last out</th><th>Total in-time</th></tr></thead>
                        <tbody>${firstLastOutRows}</tbody>
                        </table>
                    </div>
                </div>
                <div class="login-details-card">
                    <div class="login-details-header">
                        <h4 class="login-details-title">Current Week / Month Login Details</h4>
                        <div class="filter-dropdown">
                            <select id="time-filter" class="filter-select">
                                <option value="week">Week</option>
                                <option value="month">Month</option>
                            </select>
                        </div>
                    </div>
                    <div class="table-container">
                        <table class="table">
                        <thead><tr><th>Date</th><th>First in</th><th>Last out</th><th>Total in-time</th></tr></thead>
                        <tbody>${entryExitDetailsHTML}</tbody>
                        </table>
                    </div>
                </div>
            </div>
        `;
    };

    const myControls = `
        <div class="page-header-actions" style="display:flex; gap:0.5rem; flex-wrap:wrap;">
            <button type="button" class="btn btn-secondary" id="refresh-attendance-btn" title="Reload from database">
                <i class="fa-solid fa-rotate"></i> Refresh
            </button>
            <button class="btn btn-success" id="submit-attendance-btn"><i class="fa-solid fa-paper-plane"></i> Submit Attendance</button>
        </div>
    `;

    const headerHTML = `
        <div class="attendance-header page-header">
            <div class="page-header-title">
                <h1>${mode === 'my' ? 'My Attendance' : 'My Team Attendance'}</h1>
            </div>
            <div class="month-navigator">
                <button class="month-nav-btn" data-direction="prev"><i class="fa-solid fa-chevron-left"></i></button>
                <span>${monthName} ${year}</span>
                <button class="month-nav-btn" data-direction="next"><i class="fa-solid fa-chevron-right"></i></button>
            </div>
            ${mode === 'my' ? myControls : `
                <div class="page-header-actions">
                    <button class="btn btn-secondary" id="export-attendance-btn">
                        <i class="fa-solid fa-file-export"></i> Export CSV
                    </button>
                </div>
            `}
        </div>
    `;
    
    const myViewHTML = mode === 'my' ? await getMyViewHTML() : getTeamViewHTML();
    
    const content = `
        ${headerHTML}
        <div class="card attendance-card">
            ${myViewHTML}
        </div>
    `;

    document.getElementById('app-content').innerHTML = content;

    // Set up event listeners
    const timeFilter = document.getElementById('time-filter');
    if (timeFilter) {
        timeFilter.value = state.attendanceFilter || 'week';
        timeFilter.addEventListener('change', async (e) => {
            state.attendanceFilter = e.target.value;
            await renderAttendanceTrackerPage(mode);
        });
    }

    const refreshBtn = document.getElementById('refresh-attendance-btn');
    if (refreshBtn && mode === 'my') {
        refreshBtn.addEventListener('click', async () => {
            const uid = String(state.user?.id || '').toUpperCase();
            const m = date.getMonth() + 1;
            invalidateAttendanceCache(uid, year, m);
            await renderMyAttendancePage();
        });
    }

    // Set up submit attendance button listener
    const submitBtn = document.getElementById('submit-attendance-btn');
    if (submitBtn) {
        submitBtn.addEventListener('click', handleSubmitAttendance);

        // Check if attendance already submitted for this month
        checkAttendanceSubmissionStatus(submitBtn, year, date.getMonth() + 1);
    }

    // Load and display holidays for current month
    loadHolidaysForMonth(date.getMonth(), year);

    // Set up export button listener
    const exportBtn = document.getElementById('export-attendance-btn');
    if (exportBtn && mode === 'team') {
        exportBtn.addEventListener('click', () => exportTeamAttendanceToCSV(monthName, year));
    }

    if (mode === 'team' && canEditTeamAttendance()) {
        const monthIndex = date.getMonth();
        document.querySelectorAll('.team-day-cell').forEach((cell) => {
            cell.addEventListener('click', () => {
                const empId = cell.getAttribute('data-emp-id');
                const dayStr = cell.getAttribute('data-day') || '0';
                const day = parseInt(dayStr, 10);
                if (!empId || !day) return;
                openTeamAttendanceEditModal(empId, day, year, monthIndex);
            });
        });
    }
}

const openTeamAttendanceEditModal = (employeeId, day, year, monthIndex) => {
    const container = state.attendanceData[employeeId] || {};
    const dayData = container[day] || {};
    const employeeName = container.employeeName || employeeId;
    const d = new Date(year, monthIndex, day);
    const status = String(dayData.status || '').toUpperCase();
    let initialCode = 'A';
    if (status === 'P') initialCode = 'P';
    else if (status === 'H' || status === 'HL') initialCode = 'HL';
    const dateLabel = d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
    const body = `
        <div class="modal-form modern-form" style="padding-top:4px;">
            <div class="form-section" style="padding:16px 18px; border-radius:18px;">
                <div class="form-section-header" style="margin-bottom:12px;">
                    <div>
                        <p class="form-eyebrow">Attendance</p>
                        <h3>Edit status</h3>
                    </div>
                    <div style="text-align:right; font-size:13px; color:var(--text-muted); min-width:160px;">
                        <div><strong>${employeeName}</strong> (${employeeId})</div>
                        <div>${dateLabel}</div>
                    </div>
                </div>

                <div class="form-grid">
                    <div class="form-field">
                        <label class="form-label" for="att-code-select">Attendance status</label>
                        <select class="input-control" id="att-code-select">
                            <option value="P" ${initialCode === 'P' ? 'selected' : ''}>Full day | P – 09:00 hours (Present)</option>
                            <option value="HL" ${initialCode === 'HL' ? 'selected' : ''}>Half day | HL – 04:00–09:00 hours</option>
                            <option value="A" ${initialCode === 'A' ? 'selected' : ''}>Absent | A – Below 04:00 hours</option>
                        </select>
                    </div>
                </div>
            </div>
        </div>
    `;
    renderModal('Edit attendance', body, [
        { id: 'att-edit-cancel', text: 'Cancel', className: 'btn btn-secondary', type: 'button' },
        { id: 'att-edit-save', text: 'Save', className: 'btn btn-primary', type: 'button' }
    ]);
    setTimeout(() => {
        const cancelBtn = document.getElementById('att-edit-cancel');
        const saveBtn = document.getElementById('att-edit-save');
        if (cancelBtn) cancelBtn.addEventListener('click', () => closeModal());
        if (saveBtn) {
            saveBtn.addEventListener('click', async () => {
                const selectEl = document.getElementById('att-code-select');
                if (!selectEl) return;
                const code = selectEl.value;
                try {
                    const baseUrl = API_BASE_URL.replace(/\/$/, '');
                    const res = await fetch(`${baseUrl}/api/attendance/manual-edit`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ employee_id: employeeId, year, month: monthIndex + 1, day, code })
                    });
                    const data = await res.json().catch(() => ({ success: false }));
                    if (!res.ok || !data.success) {
                        alert(data.error || 'Failed to update attendance');
                        return;
                    }
                    
                    // Clear ALL attendance cache to ensure fresh data is fetched
                    try {
                        if (state?.cache?.attendance) {
                            // Wipe entire attendance cache so every employee re-fetches
                            state.cache.attendance = {};
                        }
                        // Clear state.attendanceData to force fresh fetch
                        state.attendanceData = {};
                        clearCacheByPrefix('attendance_');
                    } catch (cacheErr) {
                        console.warn('Failed to clear attendance cache:', cacheErr);
                    }
                    
                    closeModal();
                    // Refresh team attendance page with fresh data
                    await renderTeamAttendancePage();
                } catch (err) {
                    console.error('manual-edit failed', err);
                    alert('Failed to update attendance');
                }
            });
        }
    }, 30);
};

const normalizeEmployeeFlagForWorkingDays = (value) => {
    const normalized = String(value || '').trim().toLowerCase();
    return normalized === 'intern' ? 'Intern' : 'Employee';
};

const getMonthlyWorkingDays = (year, monthIndex, employeeFlag, workWeek = 'mon-sat') => {
    const includeSaturdays = normalizeWorkWeek(workWeek) === 'mon-sat' || normalizeEmployeeFlagForWorkingDays(employeeFlag) === 'Intern';
    const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
    let workingDays = 0;

    for (let day = 1; day <= daysInMonth; day++) {
        const dayOfWeek = new Date(year, monthIndex, day).getDay();
        const isSunday = dayOfWeek === 0;
        const isSaturday = dayOfWeek === 6;
        if (isSunday) continue;
        if (isSaturday && !includeSaturdays) continue;
        workingDays += 1;
    }

    return workingDays;
};

// Function to export team attendance data to CSV
const exportTeamAttendanceToCSV = (monthName, year) => {
    const employeeIds = Object.keys(state.attendanceData);
    const date = state.currentAttendanceDate;
    const daysInMonth = new Date(year, date.getMonth() + 1, 0).getDate();

    // Prepare CSV data
    const csvRows = [];

    // Add header row
    const headers = ['Employee Name', 'Employee ID'];
    const monthNumber = String(date.getMonth() + 1).padStart(2, '0');
    for (let day = 1; day <= daysInMonth; day++) {
        headers.push(`${day}/${monthNumber}`);
    }
    headers.push('Total Present', 'Total Leaves', 'Total Absent', 'Total Late Entry', 'Total Working Days');
    csvRows.push(headers.join(','));

    // Add data rows
    employeeIds.forEach(empId => {
        const empData = state.attendanceData[empId] || {};
        const employeeName = empData.employeeName || empId;
        const employeeFlag = normalizeEmployeeFlagForWorkingDays(empData.employeeFlag);
        const totalWorkingDays = getMonthlyWorkingDays(year, date.getMonth(), employeeFlag, empData.workWeek);
        const row = [employeeName, empId];

        // Track totals
        let totalPresent = 0;
        let totalLeaves = 0;
        let totalAbsent = 0;
        let totalLate = 0;

        // Add status for each day
        for (let day = 1; day <= daysInMonth; day++) {
            const workWeek = normalizeWorkWeek(empData.workWeek || 'mon-sat');
            if (isWeeklyOffDate(year, date.getMonth(), day, workWeek)) {
                row.push('DO');
                continue;
            }
            const dayData = empData[day];
            let status = '';
            if (dayData) {
                if (dayData.leaveType) {
                    status = 'L';
                    totalLeaves++;
                } else if (dayData.status === 'P') {
                    status = dayData.isLate ? 'PL' : 'P';
                    totalPresent++;
                    if (dayData.isLate) totalLate++;
                } else if (dayData.status === 'A') {
                    status = 'A';
                    totalAbsent++;
                } else if (dayData.status === 'HL' || dayData.status === 'H') {
                    status = 'HL';
                    totalPresent += 0.5;
                    totalAbsent += 0.5;
                }
            } else if (isHolidayDate(year, date.getMonth(), day)) {
                status = 'INL';
            }
            row.push(status);
        }

        // Add totals
        row.push(totalPresent, totalLeaves, totalAbsent, totalLate, totalWorkingDays);
        csvRows.push(row.join(','));
    });

    // Create and download CSV file
    const csvContent = csvRows.join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    link.setAttribute('download', `team_attendance_${monthName.toLowerCase()}_${year}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
};

// Helper function to load and render holidays for the current month
async function loadHolidaysForMonth(month, year) {
    try {
        const holidays = await getHolidays();
        const holidaySection = document.getElementById('holiday-section');

        if (!holidaySection) return;

        // Filter holidays for the current month
        currentMonthHolidays = holidays.filter(h => {
            const holidayDate = new Date(h.crc6f_date);
            return holidayDate.getMonth() === month && holidayDate.getFullYear() === year;
        });

        if (currentMonthHolidays.length === 0) {
            holidaySection.innerHTML = `
                <div class="holiday-info-card">
                    <div class="holiday-header">
                        <i class="fa-solid fa-calendar-day holiday-info-icon"></i>
                        <h4>Holidays this month</h4>
                    </div>
                    <p class="no-holidays-text">No holidays in this month</p>
                </div>
            `;
        } else {
            const holidaysList = currentMonthHolidays.map(h => {
                const date = new Date(h.crc6f_date);
                const dayName = date.toLocaleString('default', { weekday: 'short' });
                const dayNum = date.getDate();
                return `
                    <div class="holiday-item">
                        <div class="holiday-date">
                            <span class="holiday-day">${dayNum}</span>
                            <span class="holiday-weekday">${dayName}</span>
                        </div>
                        <div class="holiday-name">
                            <i class="fa-solid fa-umbrella-beach holiday-beach-icon"></i>
                            ${h.crc6f_holidayname}
                        </div>
                    </div>
                `;
            }).join('');

            holidaySection.innerHTML = `
                <div class="holiday-info-card">
                    <div class="holiday-header">
                        <i class="fa-solid fa-calendar-day holiday-info-icon"></i>
                        <h4>Holidays this month (${currentMonthHolidays.length})</h4>
                    </div>
                    <div class="holiday-list">
                        ${holidaysList}
                    </div>
                </div>
            `;
        }

        // Inject holiday styles if not already present
        if (!document.getElementById('holiday-styles')) {
            const style = document.createElement('style');
            style.id = 'holiday-styles';
            style.innerHTML = `
                .holiday-section {
                    margin-top: 20px;
                }
                
                .holiday-info-card {
                    background: #f8f9fa;
                    border-radius: 12px;
                    padding: 20px;
                    box-shadow: 0 2px 8px rgba(0,0,0,0.08);
                }
                
                .holiday-header {
                    display: flex;
                    align-items: center;
                    gap: 10px;
                    margin-bottom: 15px;
                    padding-bottom: 10px;
                    border-bottom: 2px solid #e0e0e0;
                }
                
                .holiday-header h4 {
                    margin: 0;
                    font-size: 18px;
                    font-weight: 600;
                    color: #2c3e50;
                }
                
                .holiday-header i {
                    font-size: 20px;
                }
                
                .no-holidays-text {
                    text-align: center;
                    color: #7f8c8d;
                    font-style: italic;
                    margin: 10px 0;
                }
                
                .holiday-list {
                    display: flex;
                    flex-direction: column;
                    gap: 12px;
                }
                
                .holiday-item {
                    display: flex;
                    align-items: center;
                    background: white;
                    padding: 12px 16px;
                    border-radius: 8px;
                    box-shadow: 0 1px 4px rgba(0,0,0,0.06);
                    transition: transform 0.2s, box-shadow 0.2s;
                }
                
                .holiday-item:hover {
                    transform: translateX(4px);
                    box-shadow: 0 2px 8px rgba(0,0,0,0.12);
                }
                
                .holiday-date {
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    justify-content: center;
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                    color: white;
                    border-radius: 8px;
                    padding: 8px 12px;
                    min-width: 60px;
                    margin-right: 16px;
                }
                
                .holiday-day {
                    font-size: 24px;
                    font-weight: 700;
                    line-height: 1;
                }
                
                .holiday-weekday {
                    font-size: 11px;
                    font-weight: 500;
                    text-transform: uppercase;
                    letter-spacing: 0.5px;
                    margin-top: 2px;
                    opacity: 0.9;
                }
                
                .holiday-name {
                    display: flex;
                    align-items: center;
                    font-size: 15px;
                    font-weight: 500;
                    color: #2c3e50;
                    flex: 1;
                }
            `;
            document.head.appendChild(style);
        }
    } catch (error) {
        console.error('Error loading holidays:', error);
        const holidaySection = document.getElementById('holiday-section');
        if (holidaySection) {
            holidaySection.innerHTML = `
                <div class="holiday-info-card">
                    <div class="holiday-header">
                        <i class="fa-solid fa-calendar-day holiday-error-icon"></i>
                        <h4>Unable to load holidays</h4>
                    </div>
                    <p class="no-holidays-text">Error: ${error.message}</p>
                </div>
            `;
        }
    }
}

export const renderMyAttendancePage = async () => {
    const date = state.currentAttendanceDate;
    const year = date.getFullYear();
    const month = date.getMonth() + 1; // JavaScript months are 0-indexed

    // Lightweight skeleton while holidays and monthly attendance are loading
    try {
        const monthLabel = date.toLocaleString('default', { month: 'long', year: 'numeric' });
        const skeleton = `
            <div class="card" style="padding: 16px 20px;">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 1rem;">
                    <div>
                        <div class="skeleton skeleton-heading-md" style="width: 200px;"></div>
                        <div class="skeleton skeleton-text" style="margin-top: 0.4rem; width: 180px;"></div>
                    </div>
                    <div class="skeleton skeleton-pill" style="width: 160px; height: 32px;"></div>
                </div>
                <div class="skeleton skeleton-chart-line"></div>
            </div>
        `;
        const app = document.getElementById('app-content');
        if (app) app.innerHTML = skeleton;
    } catch { }

    try {
        // Load holidays for the current month
        const allHolidays = await getHolidays();
        currentMonthHolidays = allHolidays.filter(h => {
            const hDate = new Date(h.crc6f_date);
            return hDate.getFullYear() === year && hDate.getMonth() + 1 === month;
        });
        console.log(`📅 Loaded ${currentMonthHolidays.length} holidays for ${year}-${month}`);

        const uid = String(state.user.id || '').toUpperCase();
        const prevMap = state.attendanceData[uid] || state.attendanceData[state.user.id] || {};
        const [records, shiftRes] = await Promise.all([
            fetchMonthlyAttendance(uid, year, month, true),
            fetchShiftSettings().catch(() => ({ defaults: { work_week: 'mon-sat' }, by_employee: {} })),
        ]);

        const attendanceMap = {};
        records.forEach(rec => {
            if (rec.day) {
                const prev = prevMap[rec.day] || {};
                attendanceMap[rec.day] = {
                    day: rec.day,
                    status: rec.status,
                    isLate: !!rec.isLate,
                    workWeek: normalizeWorkWeek(rec.workWeek),
                    checkIn: rec.checkIn || prev.checkIn,
                    checkOut: rec.checkOut,
                    duration: rec.duration,
                    isManual: !!(rec.isManual || rec.is_manual),
                    leaveType: rec.leaveType,
                    compensationType: rec.paid_unpaid,
                    leaveStart: rec.leaveStart,
                    leaveEnd: rec.leaveEnd,
                    leaveStatus: rec.leaveStatus,
                    dayDuration: rec.dayDuration,
                    half: rec.half,
                    pendingLeaves: rec.pendingLeaves || prev.pendingLeaves || [],
                };
            }
        });
        const now = new Date();
        if (now.getFullYear() === year && now.getMonth() + 1 === month) {
            const todayDay = now.getDate();
            const prevToday = prevMap[todayDay];
            if (prevToday?.checkIn) {
                const apiToday = attendanceMap[todayDay] || { day: todayDay };
                attendanceMap[todayDay] = {
                    ...apiToday,
                    checkIn: apiToday.checkIn || prevToday.checkIn,
                    isLate: !!(apiToday.isLate || prevToday.isLate),
                    status: apiToday.status ?? prevToday.status,
                    pendingLeaves: apiToday.pendingLeaves?.length
                        ? apiToday.pendingLeaves
                        : (prevToday.pendingLeaves || []),
                };
            }
        }
        mergeLateFlagsFromTable(attendanceMap, records.lateMarkers || {});
        const shiftMeta = shiftRes?.by_employee?.[uid] || shiftRes?.defaults || {};
        const shiftStart = shiftMeta.shift_start || '09:00';
        const graceMin = shiftMeta.grace_minutes || 15;
        applyLateFlagsToAttendanceMap(attendanceMap, uid, shiftRes);
        mergeActiveTimerLateForToday(attendanceMap, year, month, shiftStart, graceMin);
        Object.keys(attendanceMap).forEach((key) => {
            if (!/^\d+$/.test(key)) return;
            attendanceMap[key].shiftStart = shiftStart;
            attendanceMap[key].graceMinutes = graceMin;
        });
        attendanceMap.employeeName = state.user?.name || state.user?.full_name || state.user?.id || '';
        const shiftWorkWeek = shiftRes?.by_employee?.[uid]?.work_week || shiftRes?.defaults?.work_week;
        attendanceMap.workWeek = normalizeWorkWeek(shiftWorkWeek || records[0]?.workWeek);
        state.attendanceData[uid] = attendanceMap;
        state.attendanceData[state.user.id] = attendanceMap;
    } catch (err) {
        console.error('Failed to fetch attendance:', err);
    }

    await renderAttendanceTrackerPage('my');
};

export const renderTeamAttendancePage = async () => {
    // Check if user has access
    if (!canViewTeamAttendance()) {
        console.warn('⚠️ Access denied: Only administrators, managers, and team leads can view team attendance');
        document.getElementById('app-content').innerHTML = `
            <div class="card access-denied-card">
                <i class="fa-solid fa-lock access-denied-icon"></i>
                <h2>Access Denied</h2>
                <p>You don't have permission to view team attendance.</p>
                <p>Only administrators, managers, and team leads can access this page.</p>
                <button class="btn btn-primary" onclick="window.location.hash='#/attendance-my'" style="margin-top: 16px;">
                    <i class="fa-solid fa-arrow-left"></i> Go to My Attendance
                </button>
            </div>
        `;
        return;
    }

    // Skeleton for team attendance while logs are loading
    try {
        const date = state.currentAttendanceDate;
        const monthLabel = date.toLocaleString('default', { month: 'long', year: 'numeric' });
        const skeleton = `
            <div class="card" style="padding: 16px 20px;">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 1rem;">
                    <div>
                        <div class="skeleton skeleton-heading-md" style="width: 220px;"></div>
                        <div class="skeleton skeleton-text" style="margin-top: 0.4rem; width: 200px;"></div>
                    </div>
                    <div class="skeleton skeleton-pill" style="width: 180px; height: 32px;"></div>
                </div>
                <div class="skeleton skeleton-chart-line"></div>
            </div>
        `;
        const app = document.getElementById('app-content');
        if (app) app.innerHTML = skeleton;
    } catch { }

    const date = state.currentAttendanceDate;
    const year = date.getFullYear();
    const month = date.getMonth() + 1;

    // Get current user's employee ID
    const currentEmpId = String(state.user?.id || '').toUpperCase();
    console.log('🔍 Current employee ID for team attendance:', currentEmpId);

    // For emp001 (admin), fetch all employees from Dataverse
    // For other employees, use the filtered list as before
    let employeesToFetch = [];
    const employeeMeta = {};
    let shiftRes = { defaults: { work_week: 'mon-sat' }, by_employee: {} };

    try {
        // Load holidays for the current month
        const allHolidays = await getHolidays();
        currentMonthHolidays = allHolidays.filter(h => {
            const hDate = new Date(h.crc6f_date);
            return hDate.getFullYear() === year && hDate.getMonth() + 1 === month;
        });
        console.log(`📅 Loaded ${currentMonthHolidays.length} holidays for ${year}-${month}`);

        // Load shift settings once (so DO logic works even on empty months)
        shiftRes = await fetchShiftSettings().catch(() => ({ defaults: { work_week: 'mon-sat' }, by_employee: {} }));

        // Admin always sees all employees
        console.log('✅ Admin user detected. Fetching attendance for ALL employees from Dataverse');
        // Import the listEmployees function if not already imported
        const { listEmployees } = await import('../features/employeeApi.js');
        const allEmployees = await listEmployees(1, 5000);
        const employeeIds = (allEmployees.items || []).map(emp => {
            const empId = String(emp.employee_id || emp.id || '').toUpperCase();
            if (empId) {
                employeeMeta[empId] = {
                    name: `${emp.first_name || ''} ${emp.last_name || ''}`.trim() || emp.name || empId,
                    employeeFlag: emp.employee_flag || emp.employeeFlag || emp.crc6f_employeeflag || 'Employee'
                };
            }
            return empId;
        }).filter(Boolean);

        employeesToFetch = employeeIds;
        console.log(`📊 Fetched ${employeesToFetch.length} employees from Dataverse`);

        // Clear previous attendance data to avoid stale records
        state.attendanceData = {};

        // Fetch attendance for each employee
        await Promise.all(employeesToFetch.map(async (empId) => {
            console.log(`🔄 Fetching attendance for employee: ${empId}`);
            let records = [];
            try {
                records = await fetchMonthlyAttendance(empId, year, month, true);
                console.log(`📊 Fetched ${records.length} attendance records for ${empId}`);
            } catch (err) {
                console.warn(`⚠️ Failed to fetch attendance for ${empId}:`, err);
                records = [];
            }

            const attendanceMap = {};
            records.forEach(rec => {
                if (rec.day) {
                    attendanceMap[rec.day] = {
                        day: rec.day, // Explicitly include the day property
                        status: rec.status,
                        isLate: !!rec.isLate,
                        workWeek: normalizeWorkWeek(rec.workWeek),
                        checkIn: rec.checkIn,
                        checkOut: rec.checkOut,
                        duration: rec.duration,
                        isManual: !!(rec.isManual || rec.is_manual),
                        leaveType: rec.leaveType,
                        compensationType: rec.paid_unpaid,
                        leaveStart: rec.leaveStart,
                        leaveEnd: rec.leaveEnd,
                        leaveStatus: rec.leaveStatus,
                        dayDuration: rec.dayDuration,
                        half: rec.half,
                        pendingLeaves: rec.pendingLeaves || [],
                    };
                }
            });

            const meta = employeeMeta[empId] || {};
            attendanceMap.employeeName = meta.name || empId;
            attendanceMap.employeeFlag = meta.employeeFlag || 'Employee';
            const empShiftWorkWeek = shiftRes?.by_employee?.[empId]?.work_week || shiftRes?.defaults?.work_week;
            attendanceMap.workWeek = normalizeWorkWeek(empShiftWorkWeek || records[0]?.workWeek);
            mergeLateFlagsFromTable(attendanceMap, records.lateMarkers || {});
            applyLateFlagsToAttendanceMap(attendanceMap, empId, shiftRes);
            const empShift = shiftRes?.by_employee?.[empId] || shiftRes?.defaults || {};
            Object.keys(attendanceMap).forEach((key) => {
                if (!/^\d+$/.test(key)) return;
                attendanceMap[key].shiftStart = empShift.shift_start || '09:00';
                attendanceMap[key].graceMinutes = empShift.grace_minutes || 15;
            });

            // Store both attendance data and employee info
            state.attendanceData[empId] = attendanceMap;
        }));

        console.log(`✅ Team attendance loaded for ${Object.keys(state.attendanceData).length} employees`);
    } catch (err) {
        console.error('❌ Failed to fetch team attendance:', err);
        // Initialize empty attendance data if fetch fails
        state.attendanceData = {};
    }

    await renderAttendanceTrackerPage('team');
};

export const leaveTeamAttendancePage = () => {
    /* no-op: late entry uses HTTP refresh only */
};

// Check if attendance has been submitted for the current month
async function checkAttendanceSubmissionStatus(submitBtn, year, month) {
    try {
        const employeeId = String(state.user.id || '').toUpperCase();
        const response = await fetch(`${API_BASE_URL}/api/attendance/submission-status/${employeeId}/${year}/${month}`);
        const data = await response.json();

        if (data.success && data.submitted) {
            submitBtn.disabled = true;
            submitBtn.innerHTML = '<i class="fa-solid fa-check"></i> Submitted';
            submitBtn.classList.remove('btn-success');
            submitBtn.classList.add('btn-secondary');
            submitBtn.style.cursor = 'not-allowed';
        }
    } catch (error) {
        console.error('Error checking submission status:', error);
    }
}

// Handle attendance submission
async function handleSubmitAttendance() {
    const date = state.currentAttendanceDate;
    const year = date.getFullYear();
    const month = date.getMonth() + 1;
    const employeeId = String(state.user.id || '').toUpperCase();

    if (!confirm(`Are you sure you want to submit your attendance for ${date.toLocaleString('default', { month: 'long' })} ${year}?\n\nOnce submitted, you cannot modify it until next month.`)) {
        return;
    }

    await runWithSubmissionLoading(async () => {
        try {
            console.log(`📤 Submitting attendance for ${employeeId} - ${year}/${month}`);

            const response = await fetch(`${API_BASE_URL}/api/attendance/submit`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    employee_id: employeeId,
                    year: year,
                    month: month
                })
            });

            const data = await response.json();

            if (!response.ok || !data.success) {
                throw new Error(data.error || 'Failed to submit attendance');
            }

            alert('✅ Attendance submitted successfully! It has been sent to admin for review.');
            console.log('✅ Attendance submitted to admin inbox');

            const submitBtn = document.getElementById('submit-attendance-btn');
            if (submitBtn) {
                submitBtn.disabled = true;
                submitBtn.innerHTML = '<i class="fa-solid fa-check"></i> Submitted';
                submitBtn.classList.remove('btn-success');
                submitBtn.classList.add('btn-secondary');
                submitBtn.style.cursor = 'not-allowed';
            }
        } catch (error) {
            console.error('❌ Failed to submit attendance:', error);
            alert(`❌ Failed to submit attendance: ${error.message || error}`);
        }
    }, 'Submitting attendance...');
}

export const handleAttendanceNav = async (direction) => {
    // Normalize to avoid DST/overflow issues, then move exactly one month.
    const nextDate = new Date(state.currentAttendanceDate);
    nextDate.setDate(1);
    if (direction === 'next') {
        nextDate.setMonth(nextDate.getMonth() + 1);
    } else {
        nextDate.setMonth(nextDate.getMonth() - 1);
    }
    state.currentAttendanceDate = nextDate;

    // Clear the attendance data cache to force fresh fetch
    if (state.cache && state.cache.attendance) {
        const uid = String(state.user.id || '').toUpperCase();
        const year = state.currentAttendanceDate.getFullYear();
        const month = state.currentAttendanceDate.getMonth() + 1;
        const cacheKey = `${uid}|${year}|${month}`;
        delete state.cache.attendance[cacheKey];
    }

    // Re-render the active attendance view with fresh data for the new month.
    const isTeamView = window.location.hash.includes('attendance-team');
    if (isTeamView) {
        await renderTeamAttendancePage();
    } else {
        await renderMyAttendancePage();
    }
};