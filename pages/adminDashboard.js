import { getPageContentHTML } from '../utils.js';
import { API_BASE_URL } from '../config.js';
import { timedFetch } from '../features/timedFetch.js';
import { fetchOnLeaveToday } from '../features/leaveApi.js';
import { listAllEmployees } from '../features/employeeApi.js';
import { fetchLoginEvents } from '../features/loginSettingsApi.js';
import { isAdminUser } from '../utils/accessControl.js';
import { canViewApplication } from '../utils/roleSettings.js';
import { state } from '../state.js';

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
  const style = `background: conic-gradient(var(--success) 0% ${checkedPct}%, var(--danger) ${checkedPct}% 100%);`;
  return `
    <div class="admin-donut-wrap">
      <div class="admin-donut" style="${style}">
        <span>${checkedIn}/${total}</span>
      </div>
      <div class="admin-donut-legend">
        <span><i class="dot dot-present"></i> Checked In (${checkedIn})</span>
        <span><i class="dot dot-absent"></i> Not Checked In (${notCheckedIn})</span>
      </div>
    </div>
  `;
};

const buildProjectLoadBars = (items = []) => {
  if (!items.length) {
    return '<p class="placeholder-text">No active tasks right now.</p>';
  }

  const grouped = items.reduce((acc, row) => {
    const key = row.project_name || row.project_id || 'Unmapped Project';
    if (key !== 'Unmapped Project') {
      acc[key] = (acc[key] || 0) + 1;
    }
    return acc;
  }, {});

  const rows = Object.entries(grouped)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);

  const max = Math.max(...rows.map(([, count]) => count), 1);
  const chartHeight = 200;

  return `
    <div class="project-column-chart">
      <div class="chart-container" style="height: ${chartHeight}px; position: relative; display: flex; align-items: flex-end; gap: 12px; padding: 10px;">
        ${rows.map(([project, count]) => {
          const height = Math.round((count / max) * (chartHeight - 30));
          const pct = Math.round((count / max) * 100);
          const intensity = pct > 66 ? 'high' : pct > 33 ? 'medium' : 'low';
          return `
            <div class="chart-column" style="flex: 1; display: flex; flex-direction: column; align-items: center; min-width: 0;">
              <div class="column-bar task-load-bar-${intensity}" 
                   style="width: 100%; height: ${height}px; background: var(--${intensity === 'high' ? 'danger' : intensity === 'medium' ? 'warning' : 'success'}); 
                          border-radius: 4px 4px 0 0; position: relative; transition: all 0.3s ease;">
                <div class="column-value" style="position: absolute; top: -25px; left: 50%; transform: translateX(-50%); 
                            font-weight: 600; font-size: 0.8rem; color: var(--text-primary);">${count}</div>
              </div>
              <div class="column-label" style="margin-top: 8px; text-align: center; font-size: 0.75rem; 
                            color: var(--text-secondary); font-weight: 500; line-height: 1.2; 
                            max-width: 100%; overflow: hidden; text-overflow: ellipsis; 
                            display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;">
                ${escapeHtml(project)}
              </div>
            </div>
          `;
        }).join('')}
      </div>
      <div class="chart-legend" style="margin-top: 16px; display: flex; justify-content: center; gap: 20px; flex-wrap: wrap;">
        <div class="legend-item" style="display: flex; align-items: center; gap: 6px; font-size: 0.8rem; color: var(--text-secondary);">
          <div class="legend-dot" style="width: 12px; height: 12px; background: var(--success); border-radius: 2px;"></div>
          <span>Low (1-3)</span>
        </div>
        <div class="legend-item" style="display: flex; align-items: center; gap: 6px; font-size: 0.8rem; color: var(--text-secondary);">
          <div class="legend-dot" style="width: 12px; height: 12px; background: var(--warning); border-radius: 2px;"></div>
          <span>Medium (4-6)</span>
        </div>
        <div class="legend-item" style="display: flex; align-items: center; gap: 6px; font-size: 0.8rem; color: var(--text-secondary);">
          <div class="legend-dot" style="width: 12px; height: 12px; background: var(--danger); border-radius: 2px;"></div>
          <span>High (7+)</span>
        </div>
      </div>
    </div>
  `;
};

const buildSkeleton = () => `
  <section class="admin-dashboard">
    <div class="dashboard-grid admin-dashboard-grid">
      ${Array.from({ length: 4 }).map(() => `
        <section class="card admin-card">
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
      <section class="card admin-card admin-card-span-full">
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
    const s = (status || '').toLowerCase();
    let cls = 'ts-mon-badge-none';
    let label = status || 'Not Submitted';
    if (s === 'accepted') cls = 'ts-mon-badge-accepted';
    else if (s === 'rejected') cls = 'ts-mon-badge-rejected';
    else if (s === 'pending') cls = 'ts-mon-badge-pending';
    else if (s === 'not submitted') cls = 'ts-mon-badge-none';
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
    <section class="card admin-card admin-card-span-full" id="ts-monitor-card">
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
          <section class="card admin-card admin-card-span-full">
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
          <section class="card admin-card admin-card-span-full">
            <div class="skeleton skeleton-heading-md" style="margin:20px;"></div>
            <div class="skeleton skeleton-chart-line" style="margin:14px 20px;"></div>
          </section>`;
        loadAndRenderTimesheetMonitor(true);
      };
    }
  } catch (err) {
    console.warn('Error loading timesheet monitor:', err);
    container.innerHTML = `
      <section class="card admin-card admin-card-span-full">
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
    listAllEmployees(),
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
        <td class="mono" data-elapsed data-started-at="${escapeHtml(task.started_at_utc || '')}">${formatDuration(task.elapsed_seconds)}</td>
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
        <td colspan="2" style="color:var(--text-secondary);">Checked in — no task started</td>
        <td>${escapeHtml(formatCheckInTime(row.check_in_time))}</td>
      </tr>
    `
        )
        .join('')
    : '';

  const idleNoteHtml = (idleEmployeeRows || []).length
    ? `<div style="padding:6px 16px 10px;font-size:0.75rem;color:var(--text-secondary);"><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#f59e0b;margin-right:5px;"></span>${(idleEmployeeRows || []).length} employee${(idleEmployeeRows || []).length > 1 ? 's' : ''} checked in but no task started</div>`
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
      if (row.row_kind === 'upcoming') {
        return `
      <tr>
        <td>${escapeHtml(row.employee_id)}</td>
        <td>${escapeHtml(row.employee_name)}</td>
        <td>${escapeHtml(row.leave_type)}</td>
        <td>${escapeHtml(row.start_date)}</td>
        <td>${escapeHtml(row.end_date)}</td>
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
    : '<tr><td colspan="5" style="color: var(--text-secondary);">No employees are on leave today.</td></tr>';

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
    <section class="admin-dashboard">
      <div class="admin-kpis">
        <div class="hero-stat"><strong>${data.attendance.total_employees || 0}</strong><span>Total Employees</span></div>
        <div class="hero-stat"><strong>${data.attendance.checked_in_count || 0}</strong><span>Checked In</span></div>
        <div class="hero-stat"><strong>${data.attendance.not_checked_in_count || 0}</strong><span>Not Checked In</span></div>
        <div class="hero-stat"><strong id="admin-kpi-active-task-count">${liveWork.activeTaskCount}</strong><span>Active Tasks</span></div>
      </div>

      <div class="dashboard-grid admin-dashboard-grid">
        <section class="card admin-card admin-card-span-2">
          <header class="card-heading">
            <div>
              <p class="eyebrow">Live Work</p>
              <h3>Active Tasks Across Organization</h3>
            </div>
            <span class="badge">Auto refresh: 15s</span>
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

        <section class="card admin-card">
          <header class="card-heading">
            <div>
              <p class="eyebrow">Leave</p>
              <h3>On Leave Today</h3>
            </div>
            <span class="badge">Filter: Today</span>
          </header>
          <div class="leave-table-scroll admin-table-scroll">
            <table class="table leave-table">
              <thead>
                <tr>
                  <th>Employee ID</th>
                  <th>Name</th>
                  <th>Leave Type</th>
                  <th>Start</th>
                  <th>End</th>
                </tr>
              </thead>
              <tbody>
                ${(data.leaveRows || []).map((row) => `
                  <tr>
                    <td>${escapeHtml(row.employee_id)}</td>
                    <td>${escapeHtml(row.employee_name)}</td>
                    <td>${escapeHtml(row.leave_type)}</td>
                    <td>${escapeHtml(row.start_date)}</td>
                    <td>${escapeHtml(row.end_date)}</td>
                  </tr>
                `).join('') || '<tr><td colspan="5" style="color: var(--text-secondary);">No employees are on leave today.</td></tr>'}
              </tbody>
            </table>
          </div>
        </section>

        <section class="card admin-card">
          <header class="card-heading">
            <div>
              <p class="eyebrow">Leave</p>
              <h3>Upcoming Leaves This Month</h3>
            </div>
            <span class="badge">This month</span>
          </header>
          <div class="leave-table-scroll admin-table-scroll">
            <table class="table leave-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Days Left</th>
                </tr>
              </thead>
              <tbody>
                ${(data.upcomingLeaveRows || []).map((row) => `
                  <tr>
                    <td>${escapeHtml(row.employee_name)}</td>
                    <td>${escapeHtml(row.days_left || '--')}</td>
                  </tr>
                `).join('') || '<tr><td colspan="2" style="color: var(--text-secondary);">No upcoming approved leaves for this month.</td></tr>'}
              </tbody>
            </table>
          </div>
        </section>

        <section class="card admin-card">
          <header class="card-heading">
            <div>
              <p class="eyebrow">Attendance</p>
              <h3>Employee Monitoring</h3>
            </div>
            <span class="badge">Today</span>
          </header>
          ${buildStatusDonut(data.attendance.checked_in_count || 0, data.attendance.not_checked_in_count || 0)}
          <div class="admin-monitoring-table-wrap admin-table-scroll">
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
        </section>

        <section class="card admin-card">
          <header class="card-heading">
            <div>
              <p class="eyebrow">Task Load</p>
              <h3>Active Tasks by Project</h3>
            </div>
          </header>
          ${buildProjectLoadBars(data.activeTasks)}
        </section>
      </div>

      <div id="ts-monitor-container">
        <section class="card admin-card admin-card-span-full">
          <div class="skeleton skeleton-heading-md" style="margin:20px;"></div>
          <div class="skeleton skeleton-chart-line" style="margin:14px 20px;"></div>
        </section>
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

const attachRefreshAction = () => {
  const refreshBtn = document.getElementById('admin-dashboard-refresh');
  if (!refreshBtn) return;
  refreshBtn.onclick = async () => {
    refreshBtn.disabled = true;
    refreshBtn.innerHTML = '<i class="fa-solid fa-rotate fa-spin"></i> Refreshing';
    await refreshAndRender(false);
    refreshBtn.disabled = false;
    refreshBtn.innerHTML = '<i class="fa-solid fa-rotate"></i> Refresh';
  };
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
      appContent.innerHTML = getPageContentHTML('Admin Dashboard', buildSkeleton(), '<button id="admin-dashboard-refresh" class="btn btn-outline"><i class="fa-solid fa-rotate"></i> Refresh</button>');
    }

    const data = await loadAdminDashboardData();
    appContent.innerHTML = getPageContentHTML(
      'Admin Dashboard',
      buildDashboardLayout(data),
      '<button id="admin-dashboard-refresh" class="btn btn-outline"><i class="fa-solid fa-rotate"></i> Refresh</button>'
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
