import { getPageContentHTML } from '../utils.js';
import { API_BASE_URL } from '../config.js';
import { timedFetch } from '../features/timedFetch.js';
import { fetchOnLeaveToday, fetchEmployeeLeaves } from '../features/leaveApi.js';
import { listActiveEmployees } from '../features/employeeApi.js';
import { fetchLoginEvents } from '../features/loginSettingsApi.js';
import { isAdminUser } from '../utils/accessControl.js';
import { canViewApplication } from '../utils/roleSettings.js';
import { state } from '../state.js';
import { renderModal, closeModal } from '../components/modal.js';

const BASE_URL = API_BASE_URL.replace(/\/$/, '');
const DASHBOARD_PATH = '#/admin-dashboard';
const isAdminDashboardRoute = () => String(window.location.hash || '').startsWith(DASHBOARD_PATH);

const buildAdminAuthQuery = () => {
  const qs = new URLSearchParams();
  const requesterEmployeeId = normalizeEmpId(state.user?.id || state.user?.employee_id);
  const requesterEmail = String(state.user?.email || '').trim().toLowerCase();
  if (requesterEmployeeId) qs.set('requester_employee_id', requesterEmployeeId);
  if (requesterEmail) qs.set('requester_email', requesterEmail);
  const query = qs.toString();
  return query ? `?${query}` : '';
};

let adminDashboardPollId = null;
let adminDashboardTickId = null;
let refreshInFlight = false;
let liveRefreshDebounceId = null;
let liveHooksBound = false;

const escapeHtml = (value = '') => String(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const normalizeEmpId = (value = '') => String(value || '').trim().toUpperCase();

const formatDuration = (seconds = 0) => {
  const safe = Math.max(0, Number(seconds) || 0);
  const hh = Math.floor(safe / 3600).toString().padStart(2, '0');
  const mm = Math.floor((safe % 3600) / 60).toString().padStart(2, '0');
  const ss = Math.floor(safe % 60).toString().padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
};

const formatCheckInTime = (timeStr = '') => {
  if (!timeStr) return '--';
  
  // Handle ISO format: 2025-03-11T09:30:00Z or 2025-03-11T09:30:00+05:30
  if (timeStr.includes('T') && (timeStr.includes('Z') || timeStr.includes('+'))) {
    try {
      const date = new Date(timeStr);
      if (isNaN(date.getTime())) return timeStr; // Return original if invalid
      
      // Get local time in HH:MM format
      const hours = date.getHours().toString().padStart(2, '0');
      const minutes = date.getMinutes().toString().padStart(2, '0');
      return `${hours}:${minutes}`;
    } catch (e) {
      return timeStr; // Return original if parsing fails
    }
  }
  
  // Handle time-only format: 09:30:00 or 09:30
  if (timeStr.match(/^\d{1,2}:\d{2}/)) {
    return timeStr.split(':').slice(0, 2).join(':');
  }
  
  // Return original if no format matches
  return timeStr;
};

const formatDisplayDate = (dateStr = '') => {
  if (!dateStr) return '--';
  try {
    const date = new Date(dateStr);
    if (Number.isNaN(date.getTime())) return dateStr;
    return date.toLocaleDateString('en-IN', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    });
  } catch {
    return dateStr;
  }
};

const formatUpcomingLabel = (daysUntil) => {
  const safeDays = Number(daysUntil);
  if (!Number.isFinite(safeDays) || safeDays <= 0) return 'Starting soon';
  return `Upcoming in ${safeDays} day${safeDays === 1 ? '' : 's'}`;
};

const stopDashboardTimers = () => {
  if (adminDashboardPollId) {
    clearInterval(adminDashboardPollId);
    adminDashboardPollId = null;
  }
  if (adminDashboardTickId) {
    clearInterval(adminDashboardTickId);
    adminDashboardTickId = null;
  }
};

const scheduleLiveRefresh = () => {
  if (!isAdminDashboardRoute()) return;
  if (liveRefreshDebounceId) {
    clearTimeout(liveRefreshDebounceId);
    liveRefreshDebounceId = null;
  }
  liveRefreshDebounceId = setTimeout(() => {
    liveRefreshDebounceId = null;
    refreshAndRender(false, 'live');
  }, 250);
};

const bindLiveRefreshHooks = () => {
  if (liveHooksBound) return;

  window.addEventListener('taskTimerStarted', scheduleLiveRefresh);
  window.addEventListener('taskTimerStopped', scheduleLiveRefresh);
  window.addEventListener('storage', (event) => {
    const key = String(event?.key || '');
    if (!key) return;
    if (key.startsWith('tt_active_') || key.startsWith('tt_accum_')) {
      scheduleLiveRefresh();
    }
  });

  liveHooksBound = true;
};

const buildStatusDonut = (checkedIn = 0, notCheckedIn = 0) => {
  const total = Math.max(checkedIn + notCheckedIn, 1);
  const checkedPct = (checkedIn / total) * 100;
  // Calculate dash offset for SVG circle (circumference = 2 * pi * r ≈ 440 for r=70)
  const circumference = 2 * Math.PI * 70;
  const offset = circumference - (checkedPct / 100) * circumference;
  
  return `
    <div class="hud-ring-container">
      <svg class="hud-ring-svg" viewBox="0 0 160 160">
        <circle class="hud-ring-bg" cx="80" cy="80" r="70"></circle>
        <circle class="hud-ring-fg" cx="80" cy="80" r="70" 
          stroke-dasharray="${circumference}" 
          stroke-dashoffset="${offset}"
        ></circle>
      </svg>
      <div class="hud-ring-center">
        <div class="value">${checkedIn}<span style="font-size:1rem;color:#64748b;">/${total}</span></div>
        <div class="label">Checked In</div>
      </div>
    </div>
    <div class="hud-donut-legend">
      <span><i class="dot dot-present"></i> Checked In</span>
      <span><i class="dot dot-absent"></i> Offline</span>
    </div>
  `;
};



const buildSkeleton = () => `
  <section class="admin-dashboard admin-dashboard-hightech">
    <div class="admin-dashboard-grid-hightech">
      ${Array.from({ length: 4 }).map(() => `
        <section class="admin-card-hightech">
          <div class="skeleton skeleton-heading-md"></div>
          <div class="skeleton skeleton-text" style="margin-top:0.6rem;width:70%"></div>
          <div class="skeleton skeleton-list-line-lg" style="margin-top:1.1rem"></div>
          <div class="skeleton skeleton-list-line-sm"></div>
        </section>
      `).join('')}
    </div>
  </section>
`;

const fetchAttendanceMonitoring = async () => {
  const res = await timedFetch(`${BASE_URL}/api/admin/attendance-monitoring/today${buildAdminAuthQuery()}`, {}, 'adminAttendanceMonitoring');
  const data = await res.json();
  if (!res.ok || !data.success) {
    throw new Error(data.error || 'Failed to load attendance monitoring');
  }
  return data;
};

const fetchActiveTaskSnapshot = async () => {
  const res = await timedFetch(`${BASE_URL}/api/admin/active-tasks${buildAdminAuthQuery()}`, {}, 'adminActiveTasks');
  const data = await res.json();
  if (!res.ok || !data.success) {
    throw new Error(data.error || 'Failed to load active tasks');
  }
  return data;
};

let tsMonitorMonth = new Date().getMonth() + 1;
let tsMonitorYear = new Date().getFullYear();
let _tsMonitorEmployees = []; // populated from admin dashboard data
let tsMonitorSearch = '';
let tsMonitorSort = { key: 'employee_id', dir: 'asc' };
let _lastTsMonitorData = null;

const fetchTimesheetMonitor = async (month, year, employees) => {
  try {
    const res = await timedFetch(`${BASE_URL}/api/admin/timesheet-monitor?month=${month}&year=${year}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employees: employees || [] }),
    }, 'adminTimesheetMonitor');
    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.error || 'Failed to load timesheet monitor');
    }
    return data;
  } catch (err) {
    console.warn('Timesheet monitor fetch failed:', err);
    return null;
  }
};

const buildTimesheetMonitorCard = (tsData) => {
  if (!tsData) {
    return `
      <section class="admin-card-hightech">
        <header class="card-heading">
          <div>
            <p class="eyebrow">Timesheet</p>
            <h3>Timesheet Submissions Monitor</h3>
          </div>
        </header>
        <p class="placeholder-text" style="padding: 20px;">Unable to load timesheet monitor data.</p>
      </section>
    `;
  }

  const weeks = tsData.weeks || [];
  const employees = tsData.employees || [];
  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const monthLabel = `${monthNames[(tsData.month || 1) - 1]} ${tsData.year || ''}`;

  // Count submission stats for the month
  let totalSubmitted = 0;
  let totalNotSubmitted = 0;
  let totalPending = 0;
  employees.forEach(emp => {
    const hasAnySubmission = (emp.weeks || []).some(w => w.status && w.status !== 'Not Submitted');
    const hasNotSubmitted = (emp.weeks || []).some(w => w.status === 'Not Submitted' && w.hours > 0);
    const hasPending = (emp.weeks || []).some(w => w.status === 'Pending');
    if (hasPending) totalPending++;
    if (hasAnySubmission) totalSubmitted++;
    if (hasNotSubmitted) totalNotSubmitted++;
  });

  const statusBadge = (status) => {
    let s = (status || '').toLowerCase();
    let cls = 'ts-mon-badge-none';
    let label = status || 'Not Submitted';
    if (s === 'pending') {
      cls = 'ts-mon-badge-accepted';
      label = 'Submitted';
    } else if (s === 'accepted') {
      cls = 'ts-mon-badge-accepted';
    } else if (s === 'rejected') {
      cls = 'ts-mon-badge-rejected';
    } else if (s === 'not submitted') {
      cls = 'ts-mon-badge-none';
    }
    return `<span class="ts-mon-badge ${cls}">${escapeHtml(label)}</span>`;
  };

  const formatWeekHeader = (w) => {
    try {
      const s = new Date(w.start + 'T00:00:00');
      const e = new Date(w.end + 'T00:00:00');
      const fmt = (d) => `${d.getDate()} ${d.toLocaleDateString('en-US', { month: 'short' })}`;
      return `${w.label}<br><span style="font-size:10px;color:var(--text-secondary);font-weight:400;">${fmt(s)} - ${fmt(e)}</span>`;
    } catch { return w.label || ''; }
  };

  const searchTerm = String(tsMonitorSearch || '').trim().toLowerCase();
  const filteredEmployees = employees.filter(emp => {
    if (!searchTerm) return true;
    const nameMatch = String(emp.employee_name || '').toLowerCase().includes(searchTerm);
    const idMatch = String(emp.employee_id || '').toLowerCase().includes(searchTerm);
    return nameMatch || idMatch;
  });

  filteredEmployees.sort((a, b) => {
    const valA = String(a[tsMonitorSort.key] || '').toLowerCase();
    const valB = String(b[tsMonitorSort.key] || '').toLowerCase();
    if (valA < valB) return tsMonitorSort.dir === 'asc' ? -1 : 1;
    if (valA > valB) return tsMonitorSort.dir === 'asc' ? 1 : -1;
    return 0;
  });

  const employeeRows = filteredEmployees.map(emp => {
    const weekCells = (emp.weeks || []).map(w => {
      const hoursLabel = w.hours > 0 ? `<div style="font-size:11px;color:var(--text-secondary);margin-top:2px;">${w.hours}h</div>` : '';
      return `<td style="text-align:center;vertical-align:middle;">${statusBadge(w.status)}${hoursLabel}</td>`;
    }).join('');
    return `
      <tr>
        <td>
          <div class="admin-employee-cell">
            <strong>${escapeHtml(emp.employee_id)}</strong>
            <span>${escapeHtml(emp.employee_name)}</span>
          </div>
        </td>
        ${weekCells}
      </tr>
    `;
  }).join('');

  return `
    <section class="admin-card-hightech" id="ts-monitor-card">
      <header class="card-heading" style="flex-wrap:wrap;gap:12px;align-items:center;">
        <div>
          <p class="eyebrow">Timesheet</p>
          <h3>Timesheet Submissions Monitor</h3>
        </div>
        <div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap;margin-left:auto;">
          <div style="position:relative;">
            <i class="fa-solid fa-search" style="position:absolute;left:10px;top:50%;transform:translateY(-50%);color:var(--text-secondary);font-size:14px;"></i>
            <input type="text" id="ts-mon-search" class="input" placeholder="Search by name or ID..." value="${escapeHtml(tsMonitorSearch)}" style="padding-left:32px;height:36px;border-radius:8px;border:1px solid var(--border-color);background:var(--bg-secondary);color:var(--text-primary);width:220px;font-size:14px;">
          </div>
          <div style="display:flex;align-items:center;border:1px solid var(--border-color);border-radius:8px;overflow:hidden;background:var(--bg-secondary);">
            <button id="ts-mon-prev" class="btn btn-ghost" style="padding:4px 12px;height:36px;border-radius:0;border-right:1px solid var(--border-color);"><i class="fa-solid fa-chevron-left" style="font-size:12px;"></i></button>
            <span id="ts-mon-month-label" style="font-weight:600;font-size:13px;min-width:110px;text-align:center;padding:0 12px;color:var(--text-primary);">${escapeHtml(monthLabel)}</span>
            <button id="ts-mon-next" class="btn btn-ghost" style="padding:4px 12px;height:36px;border-radius:0;border-left:1px solid var(--border-color);"><i class="fa-solid fa-chevron-right" style="font-size:12px;"></i></button>
          </div>
        </div>
      </header>
      <div style="padding:12px 20px 0;display:flex;gap:24px;flex-wrap:wrap;">
        <div style="font-size:13px;color:var(--text-secondary);">Total Employees: <strong style="color:var(--text-primary);">${employees.length}</strong></div>
        <div style="font-size:13px;color:var(--text-secondary);">Submitted: <strong style="color:#16a34a;">${totalSubmitted}</strong></div>
        <div style="font-size:13px;color:var(--text-secondary);">Pending: <strong style="color:#f59e0b;">${totalPending}</strong></div>
        <div style="font-size:13px;color:var(--text-secondary);">Not Submitted (with hours): <strong style="color:#ef4444;">${totalNotSubmitted}</strong></div>
      </div>
      <div class="leave-table-scroll admin-table-scroll" style="margin-top:12px;">
        <table class="table leave-table">
          <thead>
            <tr>
              <th id="ts-mon-sort-emp" style="text-align:left;min-width:180px;cursor:pointer;user-select:none;" title="Click to sort by ID or Name">
                Employee
                <span style="display:inline-block;margin-left:8px;font-size:12px;color:var(--text-secondary);">
                  ${tsMonitorSort.key === 'employee_name' ? 'Name' : 'ID'} 
                  ${tsMonitorSort.dir === 'asc' ? '<i class="fa-solid fa-arrow-up"></i>' : '<i class="fa-solid fa-arrow-down"></i>'}
                </span>
              </th>
              ${weeks.map(w => `<th style="text-align:center;min-width:120px;">${formatWeekHeader(w)}</th>`).join('')}
            </tr>
          </thead>
          <tbody>
            ${employeeRows || '<tr><td colspan="' + (weeks.length + 1) + '" style="color:var(--text-secondary);">No employees found.</td></tr>'}
          </tbody>
        </table>
      </div>
    </section>
  `;
};

const loadAndRenderTimesheetMonitor = async (forceFetch = true) => {
  const container = document.getElementById('ts-monitor-container');
  if (!container) return;

  const wasSearchFocused = document.activeElement?.id === 'ts-mon-search';
  let cursorPosition = 0;
  if (wasSearchFocused) {
    cursorPosition = document.activeElement.selectionStart;
  }

  try {
    if (forceFetch || !_lastTsMonitorData) {
      _lastTsMonitorData = await fetchTimesheetMonitor(tsMonitorMonth, tsMonitorYear, _tsMonitorEmployees);
    }
    const data = _lastTsMonitorData;
    container.innerHTML = buildTimesheetMonitorCard(data);

    // Attach event listeners for search
    const searchInput = document.getElementById('ts-mon-search');
    if (searchInput) {
      if (wasSearchFocused) {
        setTimeout(() => {
          searchInput.focus();
          searchInput.setSelectionRange(cursorPosition, cursorPosition);
        }, 0);
      }
      
      searchInput.oninput = (e) => {
        tsMonitorSearch = e.target.value;
        loadAndRenderTimesheetMonitor(false);
      };
    }

    // Attach event listeners for sort
    const sortTh = document.getElementById('ts-mon-sort-emp');
    if (sortTh) {
      sortTh.onclick = () => {
        if (tsMonitorSort.key === 'employee_id') {
          if (tsMonitorSort.dir === 'asc') tsMonitorSort.dir = 'desc';
          else { tsMonitorSort.key = 'employee_name'; tsMonitorSort.dir = 'asc'; }
        } else {
          if (tsMonitorSort.dir === 'asc') tsMonitorSort.dir = 'desc';
          else { tsMonitorSort.key = 'employee_id'; tsMonitorSort.dir = 'asc'; }
        }
        loadAndRenderTimesheetMonitor(false);
      };
    }

    // Attach event listeners for month navigation
    const prevBtn = document.getElementById('ts-mon-prev');
    const nextBtn = document.getElementById('ts-mon-next');

    if (prevBtn) {
      prevBtn.onclick = () => {
        tsMonitorSearch = ''; // Reset search on month change if desired. Leaving it? The user didn't specify. Let's keep search across months.
        tsMonitorMonth--;
        if (tsMonitorMonth < 1) {
          tsMonitorMonth = 12;
          tsMonitorYear--;
        }
        container.innerHTML = `
          <section class="admin-card-hightech">
            <div class="skeleton skeleton-heading-md" style="margin:20px;"></div>
            <div class="skeleton skeleton-chart-line" style="margin:14px 20px;"></div>
          </section>`;
        loadAndRenderTimesheetMonitor(true);
      };
    }

    if (nextBtn) {
      nextBtn.onclick = () => {
        tsMonitorMonth++;
        if (tsMonitorMonth > 12) {
          tsMonitorMonth = 1;
          tsMonitorYear++;
        }
        container.innerHTML = `
          <section class="admin-card-hightech">
            <div class="skeleton skeleton-heading-md" style="margin:20px;"></div>
            <div class="skeleton skeleton-chart-line" style="margin:14px 20px;"></div>
          </section>`;
        loadAndRenderTimesheetMonitor(true);
      };
    }
  } catch (err) {
    console.warn('Error loading timesheet monitor:', err);
    container.innerHTML = `
      <section class="admin-card-hightech">
        <header class="card-heading">
          <div>
            <p class="eyebrow">Timesheet</p>
            <h3>Timesheet Submissions Monitor</h3>
          </div>
        </header>
        <p class="placeholder-text" style="padding: 20px; color: var(--danger);">Failed to load data. Please refresh.</p>
      </section>
    `;
  }
};

const loadAdminDashboardData = async () => {
  const [attendanceResult, activeTasksResult, leavesResult, employeesResult, loginEventsResult] = await Promise.allSettled([
    fetchAttendanceMonitoring(),
    fetchActiveTaskSnapshot(),
    fetchOnLeaveToday([], { includeUpcoming: true }),
    listActiveEmployees(),
    fetchLoginEvents(),
  ]);

  if (attendanceResult.status !== 'fulfilled') {
    throw attendanceResult.reason || new Error('Failed to load attendance monitoring');
  }

  if (activeTasksResult.status !== 'fulfilled') {
    throw activeTasksResult.reason || new Error('Failed to load active tasks');
  }

  const attendance = attendanceResult.value || {};
  const activeTasks = activeTasksResult.value || {};
  const leaveBundle = leavesResult.status === 'fulfilled' ? (leavesResult.value || {}) : {};
  const leaves = leaveBundle.leaves || [];
  const upcomingLeaves = leaveBundle.upcoming_leaves || [];
  const employees = employeesResult.status === 'fulfilled' ? (employeesResult.value || []) : [];
  const loginEvents = loginEventsResult.status === 'fulfilled' ? (loginEventsResult.value || {}) : {};

  // Store employees for the timesheet monitor card
  _tsMonitorEmployees = (employees || []).map(emp => ({
    employee_id: emp.employee_id || emp.id || '',
    name: emp.name || `${emp.first_name || ''} ${emp.last_name || ''}`.trim() || emp.employee_id || '',
  })).filter(e => e.employee_id);

  const employeeNameMap = new Map(
    (employees || []).map((emp) => {
      const id = normalizeEmpId(emp.employee_id || emp.id);
      const name = String(emp.name || `${emp.first_name || ''} ${emp.last_name || ''}`.trim() || id);
      return [id, name];
    })
  );

  const leaveRows = (leaves || []).map((leave) => {
    const id = normalizeEmpId(leave.employee_id);
    return {
      employee_id: id,
      employee_name: employeeNameMap.get(id) || id,
      leave_type: leave.leave_type || 'Leave',
      start_date: leave.start_date || '',
      end_date: leave.end_date || leave.start_date || '',
      row_kind: 'today',
    };
  });

  const activeTaskEmpIds = new Set(
    (activeTasks.items || activeTasks || []).map(t => normalizeEmpId(t.employee_id))
  );

  const idleEmployeeRows = (loginEvents.daily_summary || []).filter(row => {
    const id = normalizeEmpId(row.employee_id);
    return Boolean(row.check_in_time) && !row.check_out_time && !activeTaskEmpIds.has(id);
  }).map(row => {
    const id = normalizeEmpId(row.employee_id);
    return {
      employee_id: id,
      employee_name: employeeNameMap.get(id) || id,
      check_in_time: row.check_in_time || '',
    };
  });

  const upcomingLeaveRows = (upcomingLeaves || []).map((leave) => {
    const id = normalizeEmpId(leave.employee_id);
    const rawStart = String(leave.start_date || '').slice(0, 10);
    let daysLeft = '';
    if (rawStart) {
      const today = new Date();
      const start = new Date(`${rawStart}T00:00:00`);
      const todayOnly = new Date(today.getFullYear(), today.getMonth(), today.getDate());
      const diffMs = start.getTime() - todayOnly.getTime();
      daysLeft = Number.isNaN(diffMs) ? '' : String(Math.max(0, Math.ceil(diffMs / 86400000)));
    }
    return {
      employee_id: id,
      employee_name: employeeNameMap.get(id) || id,
      leave_type: leave.leave_type || 'Leave',
      start_date: leave.start_date || '',
      end_date: leave.end_date || leave.start_date || '',
      total_days: leave.total_days || '',
      days_until: leave.days_until,
      days_left: daysLeft,
      row_kind: 'upcoming',
    };
  });

  const loginActivityRows = (loginEvents.daily_summary || []).map((row) => {
    const id = normalizeEmpId(row.employee_id);
    return {
      employee_id: id,
      employee_name: employeeNameMap.get(id) || id,
      date: row.date || '',
      check_in_time: row.check_in_time || '',
      check_out_time: row.check_out_time || '',
      is_checked_in: Boolean(row.check_in_time) && !row.check_out_time,
    };
  });

  return {
    attendance,
    activeTasks: activeTasks.items || [],
    leaveRows,
    upcomingLeaveRows,
    loginActivityRows,
    idleEmployeeRows,
  };
};

const getVisibleActiveTasks = (activeTasks = []) =>
  (activeTasks || []).filter(
    (task) =>
      task.employee_id !== 'VTAB-0001' &&
      (task.employee_name || task.employee_id) !== 'Vtab Admin' &&
      task.employee_id !== 'EMP023' &&
      (task.employee_name || task.employee_id) !== 'EMP023'
  );

const buildLiveWorkView = ({ activeTasks = [], idleEmployeeRows = [] } = {}) => {
  const visibleActiveTasks = getVisibleActiveTasks(activeTasks);

  const activeTaskRows = visibleActiveTasks.length
    ? visibleActiveTasks
        .map(
          (task) => `
      <tr>
        <td>${escapeHtml(task.employee_name || task.employee_id)}</td>
        <td>${escapeHtml(task.task_name || task.task_id || task.task_guid)}</td>
        <td>${escapeHtml(task.project_name || task.project_id || '--')}</td>
        <td class="mono" data-elapsed data-started-at="${escapeHtml(task.started_at_utc || '')}"><i class="led-indicator led-running"></i> ${formatDuration(task.elapsed_seconds)}</td>
      </tr>
    `
        )
        .join('')
    : '<tr><td colspan="4" style="color: var(--text-secondary);">No active task sessions right now.</td></tr>';

  const idleRows = (idleEmployeeRows || []).length
    ? (idleEmployeeRows || [])
        .map(
          (row) => `
      <tr>
        <td>${escapeHtml(row.employee_name || row.employee_id)}</td>
        <td colspan="2" style="color:var(--text-secondary);"><i class="led-indicator led-idle"></i> Checked in — no task started</td>
        <td>${escapeHtml(formatCheckInTime(row.check_in_time))}</td>
      </tr>
    `
        )
        .join('')
    : '';

  const idleNoteHtml = (idleEmployeeRows || []).length
    ? `<div style="padding:6px 16px 10px;font-size:0.75rem;color:var(--text-secondary);"><i class="led-indicator led-idle" style="background:#f59e0b;box-shadow: 0 0 10px #f59e0b;"></i>${(idleEmployeeRows || []).length} employee${(idleEmployeeRows || []).length > 1 ? 's' : ''} checked in but no task started</div>`
    : '';

  return {
    activeTaskRows,
    idleRows,
    idleNoteHtml,
    activeTaskCount: visibleActiveTasks.length,
  };
};

const loadLiveWorkData = async () => {
  const [activeTasksResult, loginEventsResult] = await Promise.allSettled([
    fetchActiveTaskSnapshot(),
    fetchLoginEvents(),
  ]);

  if (activeTasksResult.status !== 'fulfilled') {
    throw activeTasksResult.reason || new Error('Failed to load active tasks');
  }

  const activeTasks = activeTasksResult.value || {};
  const loginEvents = loginEventsResult.status === 'fulfilled' ? (loginEventsResult.value || {}) : {};

  const activeTaskEmpIds = new Set(
    (activeTasks.items || activeTasks || []).map((task) => normalizeEmpId(task.employee_id))
  );

  const idleEmployeeRows = (loginEvents.daily_summary || [])
    .filter((row) => {
      const id = normalizeEmpId(row.employee_id);
      return Boolean(row.check_in_time) && !row.check_out_time && !activeTaskEmpIds.has(id);
    })
    .map((row) => {
      const id = normalizeEmpId(row.employee_id);
      return {
        employee_id: id,
        employee_name: String(row.employee_name || row.employee_id || id),
        check_in_time: row.check_in_time || '',
      };
    });

  return {
    activeTasks: activeTasks.items || [],
    idleEmployeeRows,
  };
};

const patchLiveWorkSection = (liveData = {}) => {
  const rowsBody = document.getElementById('admin-live-work-body');
  const idleNoteWrap = document.getElementById('admin-live-work-idle-note');
  const activeTaskCountEl = document.getElementById('admin-kpi-active-task-count');

  if (!rowsBody || !idleNoteWrap) return false;

  const live = buildLiveWorkView(liveData);
  rowsBody.innerHTML = `${live.activeTaskRows}${live.idleRows}`;
  idleNoteWrap.innerHTML = live.idleNoteHtml;
  if (activeTaskCountEl) {
    activeTaskCountEl.textContent = String(live.activeTaskCount);
  }
  return true;
};

const buildDashboardLayout = (data) => {
  const combinedLeaveRows = [
    ...(data.leaveRows || []),
    ...((data.upcomingLeaveRows || []).length ? [{ row_kind: 'separator' }] : []),
    ...(data.upcomingLeaveRows || []),
  ];

  const leaveTableRows = combinedLeaveRows.length
    ? combinedLeaveRows.map((row) => {
      if (row.row_kind === 'separator') {
        return `
      <tr>
        <td colspan="5" style="background: rgba(148, 163, 184, 0.08); color: var(--text-secondary); font-weight: 600;">Upcoming Approved Leaves This Month</td>
      </tr>
    `;
      }
      return `
      <tr>
        <td>${escapeHtml(row.employee_id)}</td>
        <td>${escapeHtml(row.employee_name)}</td>
        <td>${escapeHtml(row.leave_type)}</td>
        <td>${escapeHtml(row.start_date)}</td>
        <td>${escapeHtml(row.end_date)}</td>
      </tr>
    `;
    }).join('')
    : '<tr><td colspan="5" style="color: var(--text-secondary);">No employees are on leave today or upcoming.</td></tr>';

  const loginActivityRows = data.loginActivityRows.length
    ? data.loginActivityRows.map((row) => `
      <tr>
        <td>
          <div class="admin-employee-cell">
            <strong>${escapeHtml(row.employee_id)}</strong>
            <span>${escapeHtml(row.employee_name)}</span>
          </div>
        </td>
        <td>${escapeHtml(row.date || '--')}</td>
        <td>${escapeHtml(formatCheckInTime(row.check_in_time))}</td>
        <td><span class="status-badge compact ${row.is_checked_in ? 'present' : 'absent'}">${row.is_checked_in ? 'Checked In' : 'Offline'}</span></td>
        <td>${escapeHtml(formatCheckInTime(row.check_out_time))}</td>
      </tr>
    `).join('')
    : '<tr><td colspan="5" style="color: var(--text-secondary);">No login activity available for today.</td></tr>';

  const liveWork = buildLiveWorkView(data);

  return `
    <section class="admin-dashboard admin-dashboard-hightech">
      <div class="admin-kpis admin-kpis-hightech">
        <div class="hero-stat-hightech"><strong>${data.attendance.total_employees || 0}</strong><span>Total Employees</span></div>
        <div class="hero-stat-hightech"><strong>${data.attendance.checked_in_count || 0}</strong><span>Checked In</span></div>
        <div class="hero-stat-hightech"><strong>${data.attendance.not_checked_in_count || 0}</strong><span>Not Checked In</span></div>
        <div class="hero-stat-hightech"><strong id="admin-kpi-active-task-count">${liveWork.activeTaskCount}</strong><span>Active Tasks</span></div>
      </div>

      <div class="admin-dashboard-grid-hightech">
        <section class="admin-card-hightech col-span-3">
          <header class="card-heading">
            <div>
              <p class="eyebrow">Live Work</p>
              <h3>Active Tasks Across Organization</h3>
            </div>
            <span class="badge" style="background:rgba(56,189,248,0.2);color:#38bdf8;border:1px solid #38bdf8;">Auto refresh: 15s</span>
          </header>
          <div class="leave-table-scroll admin-table-scroll">
            <table class="table leave-table">
              <thead>
                <tr>
                  <th>Employee</th>
                  <th>Task</th>
                  <th>Project</th>
                  <th>Running</th>
                </tr>
              </thead>
              <tbody id="admin-live-work-body">
                ${liveWork.activeTaskRows}
                ${liveWork.idleRows}
              </tbody>
            </table>
          </div>
          <div id="admin-live-work-idle-note">${liveWork.idleNoteHtml}</div>
        </section>

        <section class="admin-card-hightech col-span-2">
          <header class="card-heading">
            <div>
              <p class="eyebrow">Attendance</p>
              <h3>Today's Overview</h3>
            </div>
          </header>
          <div style="display:flex;gap:2rem;align-items:center;flex-wrap:wrap;">
            <div style="flex:1;min-width:200px;display:flex;flex-direction:column;align-items:center;">
              ${buildStatusDonut(data.attendance.checked_in_count || 0, data.attendance.not_checked_in_count || 0)}
            </div>
            <div class="admin-monitoring-table-wrap admin-table-scroll" style="flex:2;min-width:300px;max-height:280px;overflow-y:auto;">
              <table class="table leave-table admin-monitoring-table">
                <thead>
                  <tr>
                    <th>Employee</th>
                    <th>Date</th>
                    <th>Check-In</th>
                    <th>Presence</th>
                    <th>Check-Out</th>
                  </tr>
                </thead>
                <tbody>
                  ${loginActivityRows}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        <section class="admin-card-hightech col-span-1" style="display:flex;flex-direction:column;">
          <header class="card-heading">
            <div>
              <p class="eyebrow">Leave</p>
              <h3>Leaves Snapshot</h3>
            </div>
          </header>
          <div class="leave-table-scroll admin-table-scroll" style="flex:1;max-height:280px;overflow-y:auto;">
            <table class="table leave-table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Name</th>
                  <th>Leave Type</th>
                  <th>Start</th>
                  <th>End</th>
                </tr>
              </thead>
              <tbody>
                ${leaveTableRows}
              </tbody>
            </table>
          </div>
        </section>

      </div>

      <div id="ts-monitor-container">
        <!-- Timesheet Monitor gets rendered here -->
      </div>
    </section>
  `;
};

const startElapsedTick = () => {
  if (adminDashboardTickId) {
    clearInterval(adminDashboardTickId);
    adminDashboardTickId = null;
  }

  adminDashboardTickId = setInterval(() => {
    if (!isAdminDashboardRoute()) {
      stopDashboardTimers();
      return;
    }
    const nowMs = Date.now();
    document.querySelectorAll('[data-elapsed][data-started-at]').forEach((el) => {
      const raw = el.getAttribute('data-started-at');
      if (!raw) return;
      const startedAt = Date.parse(raw);
      if (Number.isNaN(startedAt)) return;
      const secs = Math.floor((nowMs - startedAt) / 1000);
      el.textContent = formatDuration(secs);
    });
  }, 1000);
};

// Helper removed since we compute specific Mon-Sat range inline below

// ── Core export logic (accepts a resolved date range) ────────────────────────
const _doExportWsrForRange = async (startDate, endDate, label) => {
  const btn = document.getElementById('admin-export-wsr');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Exporting...';
  }

  try {
    const pad2 = (n) => String(n).padStart(2, '0');
    const BREAK_SECS = 3600;
    const STD_WORK_SECS = 9 * 3600;

    // Enumerate every date in the range
    const rangeDates = [];
    const cursor = new Date(startDate);
    const endObj = new Date(endDate);
    while (cursor <= endObj) {
      rangeDates.push(cursor.toISOString().slice(0, 10));
      cursor.setDate(cursor.getDate() + 1);
    }

    const logsRes = await fetch(`${BASE_URL}/api/time-tracker/logs?employee_id=ALL&start_date=${startDate}&end_date=${endDate}`);
    let allLogs = [];
    if (logsRes.ok) {
      const data = await logsRes.json();
      allLogs = data.logs || [];
    }

    const employeesList = _tsMonitorEmployees || [];
    const results = [];

    for (const emp of employeesList) {
      const upEmp = String(emp.employee_id || '').toUpperCase();
      let empTotalSecs = 0;
      let empProductiveSecs = 0;
      let empOtSecs = 0;
      let empBillableSecs = 0;
      let empNonBillableSecs = 0;

      for (const dateStr of rangeDates) {
        const parts = dateStr.split('-');
        const dateObj = new Date(parts[0], parseInt(parts[1], 10) - 1, parts[2]);
        const isSunday = dateObj.getDay() === 0;
        if (isSunday) continue;

        let rawSecs = 0;
        let dayBillableSecs = 0;
        let dayNonBillableSecs = 0;
        allLogs.forEach(l => {
          if (String(l.employee_id || '').toUpperCase() === upEmp && String(l.work_date || '').slice(0, 10) === dateStr) {
            const secs = Number(l.seconds || 0);
            rawSecs += secs;
            const bt = (l.billing_type || 'Billable').trim().toLowerCase();
            if (bt === 'non-billable' || bt === 'non billable') {
              dayNonBillableSecs += secs;
            } else {
              dayBillableSecs += secs;
            }
          }
        });

        const netSecs = Math.max(0, rawSecs - BREAK_SECS);
        const stdSecs = rawSecs > 0 ? Math.min(netSecs, STD_WORK_SECS) : 0;
        const otSecs = rawSecs > 0 ? Math.max(0, netSecs - STD_WORK_SECS) : 0;

        empProductiveSecs += stdSecs;
        empOtSecs += otSecs;
        empTotalSecs += (stdSecs + otSecs);
        empBillableSecs += dayBillableSecs;
        empNonBillableSecs += dayNonBillableSecs;
      }

      // Check INL holidays within the range
      let holidaysAvailed = 0;
      try {
        const leaves = await fetchEmployeeLeaves(upEmp);
        leaves.forEach(l => {
          if (String(l.status).toLowerCase() === 'approved' && l.leave_type === 'INL') {
            const leaveStart = String(l.start_date || '').slice(0, 10);
            if (leaveStart >= startDate && leaveStart <= endDate) {
              holidaysAvailed += Number(l.total_days || 1);
            }
          }
        });
      } catch (e) { /* non-critical */ }

      if (empTotalSecs > 0 || holidaysAvailed > 0) {
        results.push({
          name: emp.name,
          totalHours: (empTotalSecs / 3600).toFixed(2),
          billableHours: (empBillableSecs / 3600).toFixed(2),
          nonBillableHours: (empNonBillableSecs / 3600).toFixed(2),
          productiveHours: (empProductiveSecs / 3600).toFixed(2),
          nonProductiveHours: (empOtSecs / 3600).toFixed(2),
          holidaysAvailed
        });
      }
    }

    let csvContent = 'data:text/csv;charset=utf-8,';
    csvContent += 'Name,Total Hours,Billable Hours,Non-Billable Hours,Productive Hours,Non-Productive Hours,Holidays Availed\r\n';
    results.forEach(row => {
      csvContent += `"${row.name.replace(/"/g, '""')}",${row.totalHours},${row.billableHours},${row.nonBillableHours},${row.productiveHours},${row.nonProductiveHours},${row.holidaysAvailed}\r\n`;
    });

    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `WSR_Report_${label}_${startDate}_to_${endDate}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  } catch (error) {
    console.error('WSR Export failed', error);
    alert('Failed to export WSR report.');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<i class="fa-solid fa-download"></i> Export WSR report';
    }
  }
};

// ── Entry point: compute last Mon-Sat and export directly ──────────────────
const exportWsrReport = async () => {
  const today = new Date();
  const dayOfWeek = today.getDay(); // 0=Sun … 6=Sat
  
  // Find Monday of the *current* week
  const diffToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  const currentMonday = new Date(today);
  currentMonday.setDate(today.getDate() + diffToMonday);
  currentMonday.setHours(0, 0, 0, 0);

  // Last week's Monday is 7 days before current week's Monday
  const lastMonday = new Date(currentMonday);
  lastMonday.setDate(currentMonday.getDate() - 7);

  // Last week's Saturday is 5 days after last week's Monday
  const lastSaturday = new Date(lastMonday);
  lastSaturday.setDate(lastMonday.getDate() + 5);

  const pad2 = (n) => String(n).padStart(2, '0');
  const fmt = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

  await _doExportWsrForRange(fmt(lastMonday), fmt(lastSaturday), 'LastWeek_Mon_Sat');
};

const attachRefreshAction = () => {
  const refreshBtn = document.getElementById('admin-dashboard-refresh');
  const exportBtn = document.getElementById('admin-export-wsr');
  if (refreshBtn) {
    refreshBtn.onclick = async () => {
      refreshBtn.disabled = true;
      refreshBtn.innerHTML = '<i class="fa-solid fa-rotate fa-spin"></i> Refreshing';
      await refreshAndRender(false);
      refreshBtn.disabled = false;
      refreshBtn.innerHTML = '<i class="fa-solid fa-rotate"></i> Refresh';
    };
  }
  if (exportBtn) {
    exportBtn.onclick = exportWsrReport;
  }
};

const refreshAndRender = async (showSkeleton = true, scope = 'full') => {
  if (refreshInFlight) return;
  refreshInFlight = true;

  const appContent = document.getElementById('app-content');
  if (!appContent) {
    refreshInFlight = false;
    return;
  }

  try {
    if (scope === 'live' && !showSkeleton) {
      const liveData = await loadLiveWorkData();
      const patched = patchLiveWorkSection(liveData);
      if (patched) return;
    }

    if (showSkeleton) {
      appContent.innerHTML = getPageContentHTML('Admin Dashboard', buildSkeleton(), '<button id="admin-export-wsr" class="btn btn-primary" style="margin-right: 8px;"><i class="fa-solid fa-download"></i> Export WSR report</button><button id="admin-dashboard-refresh" class="btn btn-outline"><i class="fa-solid fa-rotate"></i> Refresh</button>');
    }

    const data = await loadAdminDashboardData();
    appContent.innerHTML = getPageContentHTML(
      'Admin Dashboard',
      buildDashboardLayout(data),
      '<button id="admin-export-wsr" class="btn btn-primary" style="margin-right: 8px;"><i class="fa-solid fa-download"></i> Export WSR report</button><button id="admin-dashboard-refresh" class="btn btn-outline"><i class="fa-solid fa-rotate"></i> Refresh</button>'
    );

    attachRefreshAction();
    startElapsedTick();

    // Async-load timesheet monitor card (non-blocking)
    loadAndRenderTimesheetMonitor();
  } catch (err) {
    console.error('Failed to render admin dashboard', err);
    appContent.innerHTML = getPageContentHTML('Admin Dashboard', `
      <div class="card error-card">
        <h3>Unable to load admin dashboard</h3>
        <p class="placeholder-text">${escapeHtml(err?.message || 'Unexpected error')}</p>
      </div>
    `, '<button id="admin-dashboard-refresh" class="btn btn-outline"><i class="fa-solid fa-rotate"></i> Retry</button>');
    attachRefreshAction();
  } finally {
    refreshInFlight = false;
  }
};

export const renderAdminDashboardPage = async () => {
  stopDashboardTimers();
  bindLiveRefreshHooks();

  const appContent = document.getElementById('app-content');
  if (!appContent) return;

  if (!canViewApplication('admin_dashboard')) {
    appContent.innerHTML = getPageContentHTML('Admin Dashboard', `
      <div class="card access-denied-card">
        <i class="fa-solid fa-lock access-denied-icon"></i>
        <h2>Access Denied</h2>
        <p>Only administrators can access this dashboard.</p>
      </div>
    `);
    return;
  }

  await refreshAndRender(true);

  adminDashboardPollId = setInterval(async () => {
    if (!isAdminDashboardRoute()) {
      stopDashboardTimers();
      return;
    }
    await refreshAndRender(false, 'live');
  }, 15000);
};
