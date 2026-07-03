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
let activeAdminTab = 'officehub'; // 'officehub' | 'faceauth'
let faceAuthIframeLoaded = false;

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

const getAvatarInitials = (name = '') => {
  const parts = name.trim().split(' ').filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  if (parts.length === 1 && parts[0]) return parts[0].slice(0, 2).toUpperCase();
  return '??';
};

const buildAvatar = (name) => {
  return `<div style="display:flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:50%;background:#eff6ff;color:#1d4ed8;font-size:10px;font-weight:500;flex-shrink:0;">${escapeHtml(getAvatarInitials(name))}</div>`;
};

const buildStatusBadge = (type, text) => {
  const bg = type === 'approved' ? '#f0fdf4' : type === 'warning' ? '#fffbeb' : '#f1f5f9';
  const color = type === 'approved' ? '#15803d' : type === 'warning' ? '#b45309' : '#475569';
  return `<span style="display:inline-block;padding:2px 8px;border-radius:9999px;font-size:11px;font-weight:500;background:${bg};color:${color};">${escapeHtml(text)}</span>`;
};

const buildStatusDot = (status) => {
  const color = status === 'green' ? '#10b981' : status === 'red' ? '#ef4444' : status === 'amber' ? '#f59e0b' : '#94a3b8';
  return `<div style="width:7px;height:7px;border-radius:50%;background:${color};flex-shrink:0;"></div>`;
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
  const circumference = 2 * Math.PI * 56; // Radius 56
  const offset = circumference - (checkedPct / 100) * circumference;
  
  return `
    <div style="display:flex;flex-direction:column;align-items:center;gap:24px;justify-content:center;height:100%;">
      <div style="position:relative;width:140px;height:140px;">
        <svg viewBox="0 0 140 140" style="width:100%;height:100%;transform:rotate(-90deg);">
          <circle cx="70" cy="70" r="56" fill="none" stroke="#f1f5f9" stroke-width="12"></circle>
          <circle cx="70" cy="70" r="56" fill="none" stroke="#3b82f6" stroke-width="12" 
            stroke-dasharray="${circumference}" 
            stroke-dashoffset="${offset}"
            stroke-linecap="round"
          ></circle>
        </svg>
        <div style="position:absolute;top:0;left:0;right:0;bottom:0;display:flex;align-items:center;justify-content:center;flex-direction:column;">
          <div style="font-size:28px;font-weight:600;color:var(--text-primary);line-height:1;margin-bottom:4px;">${checkedIn}<span style="font-size:16px;color:var(--text-secondary);font-weight:500;">/${total}</span></div>
          <div style="font-size:11px;color:var(--text-secondary);font-weight:500;text-transform:uppercase;letter-spacing:0.05em;">Checked In</div>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:16px;font-size:13px;color:var(--text-primary);font-weight:500;">
        <div style="display:flex;align-items:center;gap:6px;"><div style="width:8px;height:8px;border-radius:50%;background:#3b82f6;"></div> Checked In</div>
        <div style="display:flex;align-items:center;gap:6px;"><div style="width:8px;height:8px;border-radius:50%;background:#e2e8f0;"></div> Offline</div>
      </div>
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
        <table class="table leave-table" style="min-width: 900px; border-collapse: separate; border-spacing: 0;">
          <thead>
            <tr>
              <th id="ts-mon-sort-emp" style="position: sticky; top: 0; background: #fff; z-index: 10; border-bottom: 1px solid #e5e7eb; text-align:left;min-width:180px;cursor:pointer;user-select:none;" title="Click to sort by ID or Name">
                Employee
                <span style="display:inline-block;margin-left:8px;font-size:12px;color:var(--text-secondary);">
                  ${tsMonitorSort.key === 'employee_name' ? 'Name' : 'ID'} 
                  ${tsMonitorSort.dir === 'asc' ? '<i class="fa-solid fa-arrow-up"></i>' : '<i class="fa-solid fa-arrow-down"></i>'}
                </span>
              </th>
              ${weeks.map(w => `<th style="position: sticky; top: 0; background: #fff; z-index: 10; border-bottom: 1px solid #e5e7eb; text-align:center;min-width:120px;">${formatWeekHeader(w)}</th>`).join('')}
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

  const loginActivityRows = (loginEvents.daily_summary || [])
    .filter(row => employeeNameMap.has(normalizeEmpId(row.employee_id)))
    .map((row) => {
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
        <td>
          <div style="display:flex;align-items:center;gap:8px;">
            ${buildAvatar(task.employee_name || task.employee_id)}
            <span>${escapeHtml(task.employee_name || task.employee_id)}</span>
          </div>
        </td>
        <td style="color:var(--text-secondary); font-size:12.5px;">${escapeHtml(task.project_name || '--')}</td>
        <td>
          <div style="display:flex;align-items:center;gap:6px;">
            ${buildStatusDot('green')}
            <span>${escapeHtml(task.task_name || task.task_id || task.task_guid)}</span>
          </div>
        </td>
        <td class="mono" data-elapsed data-started-at="${escapeHtml(task.started_at_utc || '')}">${formatDuration(task.elapsed_seconds)}</td>
      </tr>
    `
        )
        .join('')
    : '<tr><td colspan="4" style="color: var(--text-secondary); text-align: center; padding: 12px;">No active task sessions right now.</td></tr>';

  const idleRows = (idleEmployeeRows || []).length
    ? (idleEmployeeRows || [])
        .map(
          (row) => `
      <tr>
        <td>
          <div style="display:flex;align-items:center;gap:8px;">
            ${buildAvatar(row.employee_name || row.employee_id)}
            <span>${escapeHtml(row.employee_name || row.employee_id)}</span>
          </div>
        </td>
        <td style="color:var(--text-secondary); font-size:12.5px;">--</td>
        <td style="color:var(--text-secondary);">
          <div style="display:flex;align-items:center;gap:6px;">
            ${buildStatusDot('gray')}
            <span>No task</span>
          </div>
        </td>
        <td style="color:var(--text-secondary);">${escapeHtml(formatCheckInTime(row.check_in_time))}</td>
      </tr>
    `
        )
        .join('')
    : '';

  const idleNoteHtml = (idleEmployeeRows || []).length
    ? `<div style="padding:12px;font-size:12px;color:var(--text-secondary);border-top:1px solid #f3f4f6;"><span style="display:inline-block;padding:2px 8px;border-radius:9999px;font-size:11px;font-weight:500;background:#fffbeb;color:#b45309;margin-right:8px;">${(idleEmployeeRows || []).length} Idle</span> employees checked in but no task started</div>`
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
    ...(data.upcomingLeaveRows || []),
  ];

  const leaveTableRows = combinedLeaveRows.length
    ? combinedLeaveRows.map((row) => {
      const isUpcoming = row.row_kind === 'upcoming';
      const dateDisplay = row.start_date === row.end_date ? escapeHtml(row.start_date) : `${escapeHtml(row.start_date)} to ${escapeHtml(row.end_date)}`;
      return `
      <tr>
        <td>
          <div style="display:flex;align-items:center;gap:8px;">
            ${buildAvatar(row.employee_name)}
            <div>
              <div>${escapeHtml(row.employee_name)}</div>
              <div style="font-size:11px;color:var(--text-secondary);">${escapeHtml(row.employee_id)}</div>
            </div>
          </div>
        </td>
        <td>${escapeHtml(row.leave_type)}</td>
        <td style="color:var(--text-secondary); white-space:nowrap;">${dateDisplay}</td>
        <td>${buildStatusBadge('approved', isUpcoming ? 'Upcoming' : 'On Leave')}</td>
      </tr>
    `;
    }).slice(0, 6).join('') // Max 6 rows visible
    : '<tr><td colspan="4" style="color: var(--text-secondary);text-align:center;padding:12px;">No employees are on leave today or upcoming.</td></tr>';

  const loginActivityTableRows = data.loginActivityRows.length
    ? data.loginActivityRows.map((row) => `
      <tr>
        <td>
          <div style="display:flex;align-items:center;gap:8px;white-space:nowrap;">
            ${buildAvatar(row.employee_name)}
            <span>${escapeHtml(row.employee_name)}</span>
          </div>
        </td>
        <td>${escapeHtml(row.employee_id)}</td>
        <td style="white-space:nowrap;">${row.is_checked_in ? escapeHtml(formatCheckInTime(row.check_in_time)) : '--'}</td>
        <td style="color:var(--text-secondary);white-space:nowrap;">${row.check_out_time ? escapeHtml(formatCheckInTime(row.check_out_time)) : '--'}</td>
        <td style="color:${row.is_checked_in ? '#10b981' : '#9ca3af'}; font-weight:500;">${row.is_checked_in ? 'Online' : 'Offline'}</td>
      </tr>
    `).join('')
    : '<tr><td colspan="5" style="text-align:center;color:var(--text-secondary);padding:1rem;">No login activity available for today.</td></tr>';

  const liveWork = buildLiveWorkView(data);

  // Stats for "At a Glance"
  const totalEmployees = data.attendance.total_employees || 0;
  const onTasksCount = liveWork.activeTaskCount;
  const idleCount = (data.idleEmployeeRows || []).length;
  const approvedLeaves = combinedLeaveRows.length;

  return `
    <style>
      .admin-layout-v2 {
        display: flex;
        flex-direction: column;
        gap: 20px;
        font-family: inherit;
        font-weight: 400;
        margin-bottom: 24px;
      }
      .admin-stat-row {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: 16px;
      }
      .admin-stat-tile {
        background: #f9fafb;
        border-radius: 12px;
        padding: 16px;
        display: flex;
        flex-direction: column;
      }
      .admin-stat-number {
        font-size: 22px;
        font-weight: 500;
        color: var(--text-primary);
        line-height: 1.2;
      }
      .admin-stat-label {
        font-size: 11px;
        color: var(--text-secondary);
        margin-top: 4px;
        text-transform: uppercase;
      }
      .admin-layout-grid {
        display: grid;
        grid-template-columns: 1.85fr 1fr;
        gap: 16px;
      }
      .admin-card-v2 {
        background: #ffffff;
        border: 1px solid #f3f4f6;
        border-radius: 12px;
        padding: 16px;
        display: flex;
        flex-direction: column;
        min-width: 0;
      }
      .admin-card-header {
        margin-bottom: 16px;
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
      }
      .admin-section-label {
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: #2563eb; /* brand blue */
        font-weight: 500;
        margin-bottom: 4px;
      }
      .admin-section-title {
        font-size: 15px;
        font-weight: 500;
        color: var(--text-primary);
        margin: 0;
      }
      .admin-table-v2 {
        width: 100%;
        border-collapse: collapse;
      }
      .admin-table-v2 th {
        font-size: 11px;
        text-transform: uppercase;
        color: var(--text-secondary);
        font-weight: 500;
        text-align: left;
        padding: 8px 12px;
        border-bottom: 1px solid #f3f4f6;
      }
      .admin-table-v2 td {
        font-size: 12.5px;
        padding: 8px 12px;
        height: 36px;
        color: var(--text-primary);
        border-bottom: 1px solid #f3f4f6;
        vertical-align: middle;
      }
      .admin-table-v2 tbody tr:hover {
        background-color: #f9fafb;
      }
      .admin-table-v2 tbody tr:last-child td {
        border-bottom: none;
      }
      .glance-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 12px 0;
        border-bottom: 1px solid #f3f4f6;
      }
      .glance-row:last-child {
        border-bottom: none;
      }
      .glance-label {
        font-size: 13px;
        color: var(--text-secondary);
      }
      .glance-value {
        font-size: 13px;
        font-weight: 500;
        color: var(--text-primary);
      }
      .auto-refresh-pill {
        display: inline-block;
        padding: 2px 8px;
        border-radius: 9999px;
        font-size: 11px;
        background: #eff6ff;
        color: #2563eb;
        font-weight: 500;
      }
    </style>
    
    <div class="admin-layout-v2">
      <!-- Row 1: Summary Stats -->
      <div class="admin-stat-row">
        <div class="admin-stat-tile">
          <div class="admin-stat-number">${data.attendance.checked_in_count || 0}</div>
          <div class="admin-stat-label">TOTAL CHECKED IN</div>
        </div>
        <div class="admin-stat-tile">
          <div class="admin-stat-number">${data.attendance.not_checked_in_count || 0}</div>
          <div class="admin-stat-label">OFFLINE / NOT CHECKED IN</div>
        </div>
        <div class="admin-stat-tile">
          <div class="admin-stat-number" id="admin-kpi-active-task-count">${onTasksCount}</div>
          <div class="admin-stat-label">EMPLOYEES ON ACTIVE TASKS</div>
        </div>
        <div class="admin-stat-tile">
          <div class="admin-stat-number">${idleCount}</div>
          <div class="admin-stat-label">CHECKED IN BUT NO TASK STARTED</div>
        </div>
      </div>

      <!-- Row 2: Live Work (Full Width) -->
      <div class="admin-card-v2">
        <div class="admin-card-header">
          <div>
            <div class="admin-section-label">Live Work</div>
            <h3 class="admin-section-title">Active Tasks Across Organization</h3>
          </div>
          <div class="auto-refresh-pill">Auto refresh: 15s</div>
        </div>
        <div style="flex:1;max-height:280px;overflow-y:auto;overflow-x:auto;">
          <table class="admin-table-v2" style="border-collapse: separate; border-spacing: 0;">
            <thead>
              <tr>
                <th style="position: sticky; top: 0; background: #fff; z-index: 10; border-bottom: 1px solid #e5e7eb;">Employee</th>
                <th style="position: sticky; top: 0; background: #fff; z-index: 10; border-bottom: 1px solid #e5e7eb;">Project</th>
                <th style="position: sticky; top: 0; background: #fff; z-index: 10; border-bottom: 1px solid #e5e7eb;">Task/Status</th>
                <th style="position: sticky; top: 0; background: #fff; z-index: 10; border-bottom: 1px solid #e5e7eb;">Running</th>
              </tr>
            </thead>
            <tbody id="admin-live-work-body">
              ${liveWork.activeTaskRows}
              ${liveWork.idleRows}
            </tbody>
          </table>
        </div>
        <div id="admin-live-work-idle-note">${liveWork.idleNoteHtml}</div>
      </div>

      <!-- Row 3: Attendance & Leave Snapshot -->
      <div class="admin-layout-grid">
        <div class="admin-card-v2" style="display:flex;flex-direction:column;padding:24px;">
          <div class="admin-card-header" style="margin-bottom:24px;">
            <div>
              <div class="admin-section-label">Attendance</div>
              <h3 class="admin-section-title">Today's Overview</h3>
            </div>
          </div>
          <div style="display:flex;gap:20px;flex:1;align-items:stretch;">
            <div style="flex:0 0 170px;display:flex;align-items:center;justify-content:center;">
              ${buildStatusDonut(data.attendance.checked_in_count || 0, data.attendance.not_checked_in_count || 0)}
            </div>
            <div style="flex:1;max-height:280px;overflow-y:auto;border:1px solid #f3f4f6;border-radius:12px;">
              <table class="admin-table-v2" style="margin:0;">
                <thead style="position:sticky;top:0;background:#f9fafb;z-index:1;">
                  <tr>
                    <th style="padding:10px 12px;white-space:nowrap;">Employee</th>
                    <th style="padding:10px 12px;">ID</th>
                    <th style="padding:10px 12px;white-space:nowrap;">Check-In</th>
                    <th style="padding:10px 12px;white-space:nowrap;">Check-Out</th>
                    <th style="padding:10px 12px;">Status</th>
                  </tr>
                </thead>
                <tbody>
                  ${loginActivityTableRows}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <div class="admin-card-v2">
          <div class="admin-card-header">
            <div>
              <div class="admin-section-label">Leave</div>
              <h3 class="admin-section-title">Leaves Snapshot</h3>
            </div>
          </div>
          <div style="flex:1;max-height:280px;overflow-y:auto;">
            <table class="admin-table-v2">
              <thead>
                <tr>
                  <th>Employee</th>
                  <th>Leave Type</th>
                  <th>Dates</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                ${leaveTableRows}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>

    <section class="admin-dashboard admin-dashboard-hightech">
      <div id="ts-monitor-container">
        <!-- Timesheet Monitor gets rendered here -->
      </div>
    </section>

    <!-- Backup Schedule Settings Card -->
    <div style="padding:0 0 24px 0;" id="backup-schedule-wrap">
      ${buildBackupScheduleCard()}
    </div>
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

        const ratio = rawSecs > 0 ? netSecs / rawSecs : 0;
        const adjBillableSecs = dayBillableSecs * ratio;
        const adjNonBillableSecs = dayNonBillableSecs * ratio;

        empProductiveSecs += stdSecs;
        empOtSecs += otSecs;
        empTotalSecs += (stdSecs + otSecs);
        empBillableSecs += adjBillableSecs;
        empNonBillableSecs += adjNonBillableSecs;
      }

      // Check all approved leaves within the range
      let holidaysAvailed = 0;
      try {
        const leaves = await fetchEmployeeLeaves(upEmp);
        leaves.forEach(l => {
          if (String(l.status).toLowerCase() === 'approved') {
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

// ── Backup: download last 3 months + purge older data from Supabase ──────────
const downloadAdminBackup = async () => {
  const btn = document.getElementById('admin-backup-btn');
  const _setBtnState = (html, disabled = true) => {
    if (btn) { btn.disabled = disabled; btn.innerHTML = html; }
  };

  _setBtnState('<i class="fa-solid fa-spinner fa-spin"></i> Backing up&hellip;');

  try {
    // ── Step 1: Download the ZIP ─────────────────────────────────────────────
    const res = await fetch(`${BASE_URL}/api/admin/backup`, { method: 'GET' });
    if (!res.ok) {
      let msg = `Server error ${res.status}`;
      try { const d = await res.json(); msg = d.error || msg; } catch (_) {}
      throw new Error(msg);
    }
    const blob = await res.blob();
    const contentDisposition = res.headers.get('Content-Disposition') || '';
    const filenameMatch = contentDisposition.match(/filename="?([^"]+)"?/);
    const filename = filenameMatch
      ? filenameMatch[1]
      : `OfficeTool_Backup_${new Date().toISOString().slice(0, 10)}.zip`;

    // Trigger browser save-file dialog
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(url), 10000);

    // ── Step 2: Purge old data from Supabase ─────────────────────────────────
    _setBtnState('<i class="fa-solid fa-spinner fa-spin"></i> Purging old data&hellip;');

    const purgeRes = await fetch(`${BASE_URL}/api/admin/purge-old-data`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    const purgeData = await purgeRes.json();

    if (!purgeRes.ok || !purgeData.success) {
      throw new Error(purgeData.error || `Purge failed (HTTP ${purgeRes.status})`);
    }

    // ── Step 3: Show success summary ─────────────────────────────────────────
    _setBtnState('<i class="fa-solid fa-circle-check"></i> Done!', false);
    setTimeout(() => _setBtnState('<i class="fa-solid fa-download"></i> Backup local', false), 3000);

    const { cutoff_date, deleted, total_deleted } = purgeData;
    const tableLines = Object.entries(deleted || {})
      .map(([tbl, cnt]) => `  • ${tbl}: ${typeof cnt === 'number' ? cnt + ' rows deleted' : cnt}`)
      .join('\n');
    alert(
      `✅ Backup complete!\n\n` +
      `📦 File saved: ${filename}\n\n` +
      `🗑️ Purged ${total_deleted} rows older than ${cutoff_date} from Supabase:\n` +
      `${tableLines}`
    );

  } catch (err) {
    console.error('Backup/Purge failed:', err);
    alert(`Backup or purge failed:\n${err.message || 'Unknown error'}`);
    _setBtnState('<i class="fa-solid fa-download"></i> Backup local', false);
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// AUTO-BACKUP SCHEDULER ENGINE
// ═══════════════════════════════════════════════════════════════════════════

const BACKUP_LS_KEY = 'officetool_last_backup_date';   // localStorage key

/** Show a slim, non-blocking toast at the bottom-right of the screen */
const showBackupToast = (msg, type = 'info', durationMs = 5000) => {
  const existing = document.getElementById('backup-toast');
  if (existing) existing.remove();

  const colors = {
    info:    { bg: '#1e3a5f', border: '#2563eb', icon: 'fa-circle-info',    text: '#93c5fd' },
    success: { bg: '#14532d', border: '#16a34a', icon: 'fa-circle-check',   text: '#86efac' },
    error:   { bg: '#7f1d1d', border: '#dc2626', icon: 'fa-circle-xmark',   text: '#fca5a5' },
    working: { bg: '#1e3a5f', border: '#7c3aed', icon: 'fa-spinner fa-spin', text: '#c4b5fd' },
  };
  const c = colors[type] || colors.info;

  const toast = document.createElement('div');
  toast.id = 'backup-toast';
  toast.style.cssText = [
    'position:fixed', 'bottom:24px', 'right:24px', 'z-index:99999',
    `background:${c.bg}`, `border:1px solid ${c.border}`, 'border-radius:12px',
    'padding:12px 18px', 'display:flex', 'align-items:center', 'gap:10px',
    'box-shadow:0 8px 32px rgba(0,0,0,0.4)', 'max-width:380px',
    'font-size:13px', 'font-weight:500', `color:${c.text}`,
    'transition:opacity 0.4s', 'opacity:1',
  ].join(';');
  toast.innerHTML = `<i class="fa-solid ${c.icon}" style="flex-shrink:0;font-size:15px;"></i><span>${msg}</span>`;
  document.body.appendChild(toast);

  if (durationMs > 0) {
    setTimeout(() => {
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 450);
    }, durationMs);
  }
  return toast;
};

/**
 * Determines whether a backup is due based on the stored config and the
 * last-backup date stored in localStorage on this machine.
 */
const isBackupDue = (cfg) => {
  if (!cfg || cfg.enabled === false) return false;

  const lastStr = localStorage.getItem(BACKUP_LS_KEY);
  const today   = new Date();
  today.setHours(0, 0, 0, 0);

  if (!lastStr) return true;   // Never backed up → run now

  const last = new Date(lastStr);
  last.setHours(0, 0, 0, 0);
  if (isNaN(last.getTime())) return true;

  const freq = cfg.frequency || 'monthly';

  if (freq === 'daily') {
    return today > last;
  }
  if (freq === 'weekly') {
    const diff = (today - last) / 86400000;
    return diff >= 7;
  }
  if (freq === 'fortnightly') {
    const diff = (today - last) / 86400000;
    return diff >= 14;
  }
  if (freq === 'monthly') {
    const dom = cfg.day_of_month || 1;
    // Due if we are on or past the target day and haven't backed up this month
    return (
      today.getDate() >= dom &&
      (last.getFullYear() < today.getFullYear() || last.getMonth() < today.getMonth())
    );
  }
  if (freq === 'quarterly') {
    const dom = cfg.day_of_month || 1;
    const monthsElapsed =
      (today.getFullYear() - last.getFullYear()) * 12 +
      (today.getMonth() - last.getMonth());
    return monthsElapsed >= 3 && today.getDate() >= dom;
  }
  return false;
};

/**
 * Runs the full backup+purge silently in the background.
 * Shows toast notifications at each stage. Never blocks the UI.
 */
const runAutoBackup = async (silent = true) => {
  const toast = showBackupToast(
    silent
      ? '<i class="fa-solid fa-database" style="margin-right:4px;"></i> Auto-backup running…'
      : 'Manual backup running…',
    'working',
    0
  );

  try {
    const res = await fetch(`${BASE_URL}/api/admin/trigger-backup-job`, { 
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${localStorage.getItem('authToken')}`
        }
    });
    
    if (!res.ok) {
      let m = `HTTP ${res.status}`;
      try { m = (await res.json()).error || m; } catch (_) {}
      throw new Error(m);
    }
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'Backup job failed');

    // Persist last-run date locally
    const todayStr = new Date().toISOString().slice(0, 10);
    localStorage.setItem(BACKUP_LS_KEY, todayStr);

    if (toast) toast.remove();
    showBackupToast('✅ Backup completed successfully', 'success', 4000);
    
    // Refresh the backup card to pull the latest backup history logs
    await checkAndRunAutoBackup();
  } catch (err) {
    console.error('[AUTO-BACKUP] Failed:', err);
    if (toast) toast.remove();
    showBackupToast(`❌ Backup Failed: ${err.message || 'unknown error'}`, 'error', 6000);
    await checkAndRunAutoBackup();
  }
};

/**
 * Called once when the admin dashboard loads.
 * Fetches the schedule config and silently runs backup if due.
 */
const checkAndRunAutoBackup = async () => {
  try {
    const res = await fetch(`${BASE_URL}/api/admin/backup-config`);
    if (!res.ok) return;
    const { config } = await res.json();
    
    // Re-render the card with the latest config
    if (config) {
      const wrap = document.getElementById('backup-schedule-wrap');
      if (wrap) {
        wrap.innerHTML = buildBackupScheduleCard(config);
        attachBackupScheduleHandlers();
      }
    }

    if (!config || config.enabled === false) return;
    // if (isBackupDue(config)) {
    //   // Tiny delay so the dashboard UI finishes painting first
    //   // setTimeout(() => runAutoBackup(true), 1500);
    // }
  } catch (e) {
    console.warn('[AUTO-BACKUP] Config fetch failed:', e);
  }
};

// ── Schedule settings card ────────────────────────────────────────────────────

const buildBackupScheduleCard = (cfg = {}) => {
  const freq      = cfg.frequency    || 'monthly';
  const dom       = cfg.day_of_month || 1;
  const enabled   = cfg.enabled !== false;
  const lastDate  = localStorage.getItem(BACKUP_LS_KEY) || cfg.last_backup_date || null;

  const nextLabel = (() => {
    if (!enabled) return 'Disabled';
    const today = new Date();
    if (freq === 'daily')       return 'Tomorrow';
    if (freq === 'weekly')      return `In 7 days`;
    if (freq === 'fortnightly') return `In 14 days`;
    if (freq === 'monthly') {
      const next = new Date(today.getFullYear(), today.getMonth(), dom);
      if (next <= today) next.setMonth(next.getMonth() + 1);
      return next.toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' });
    }
    if (freq === 'quarterly') {
      const next = new Date(today.getFullYear(), today.getMonth(), dom);
      if (next <= today) next.setMonth(next.getMonth() + 3);
      return next.toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' });
    }
    return '—';
  })();

  const lastLabel = lastDate
    ? new Date(lastDate).toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' })
    : 'Never';

  const opt = (val, label) =>
    `<option value="${val}" ${freq === val ? 'selected' : ''}>${label}</option>`;

  return `
    <div class="admin-card-v2" id="backup-schedule-card" style="margin-top:16px;">
      <div class="admin-card-header">
        <div>
          <div class="admin-section-label">Automated Backup</div>
          <h3 class="admin-section-title">Backup Schedule Settings</h3>
        </div>
        <label style="display:flex;align-items:center;gap:8px;font-size:13px;color:var(--text-secondary);cursor:pointer;">
          <div id="backup-toggle-wrap" style="position:relative;width:40px;height:22px;">
            <input type="checkbox" id="backup-enabled-toggle" ${enabled ? 'checked' : ''}
              style="opacity:0;width:0;height:0;position:absolute;"
            />
            <span id="backup-toggle-track" style="
              position:absolute;inset:0;border-radius:11px;
              background:${enabled ? '#2563eb' : '#d1d5db'};
              transition:background 0.2s;
            "></span>
            <span style="
              position:absolute;top:3px;left:${enabled ? '21px' : '3px'};
              width:16px;height:16px;border-radius:50%;background:#fff;
              box-shadow:0 1px 3px rgba(0,0,0,0.2);transition:left 0.2s;
              pointer-events:none;
            " id="backup-toggle-knob"></span>
          </div>
          ${enabled ? 'Enabled' : 'Disabled'}
        </label>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px;margin-bottom:20px;">
        <div style="background:#f8fafc;border-radius:10px;padding:14px;">
          <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.06em;color:#64748b;font-weight:500;margin-bottom:6px;">Status</div>
          <div style="font-size:13px;font-weight:600;color:${enabled ? '#16a34a' : '#dc2626'}">
            ${enabled ? '🟢 Active' : '🔴 Disabled'}
          </div>
        </div>
        <div style="background:#f8fafc;border-radius:10px;padding:14px;" id="backup-last-run-tile">
          <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.06em;color:#64748b;font-weight:500;margin-bottom:6px;">Last Backup</div>
          <div style="font-size:13px;font-weight:600;color:var(--text-primary);" id="backup-last-run-label">${lastLabel}</div>
        </div>
        <div style="background:#f8fafc;border-radius:10px;padding:14px;">
          <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.06em;color:#64748b;font-weight:500;margin-bottom:6px;">Next Backup</div>
          <div style="font-size:13px;font-weight:600;color:#2563eb;" id="backup-next-run-label">${nextLabel}</div>
        </div>
      </div>

      <div style="display:flex;align-items:flex-end;gap:16px;flex-wrap:wrap;margin-bottom:20px;">
        <div style="flex:1;min-width:180px;">
          <label style="display:block;font-size:12px;font-weight:500;color:var(--text-secondary);margin-bottom:6px;">Backup Frequency</label>
          <select id="backup-frequency-select" style="
            width:100%;padding:9px 12px;border:1px solid #e2e8f0;border-radius:8px;
            font-size:13px;background:#fff;color:var(--text-primary);cursor:pointer;
            outline:none;appearance:none;
          ">
            ${opt('daily',       'Daily')}
            ${opt('weekly',      'Every Week')}
            ${opt('fortnightly', 'Every 2 Weeks')}
            ${opt('monthly',     'Monthly (on a specific day)')}
            ${opt('quarterly',   'Every 3 Months')}
          </select>
        </div>
        <div id="backup-dom-wrap" style="min-width:160px;${['monthly','quarterly'].includes(freq) ? '' : 'display:none;'}">
          <label style="display:block;font-size:12px;font-weight:500;color:var(--text-secondary);margin-bottom:6px;">Day of Month</label>
          <select id="backup-dom-select" style="
            width:100%;padding:9px 12px;border:1px solid #e2e8f0;border-radius:8px;
            font-size:13px;background:#fff;color:var(--text-primary);cursor:pointer;
            outline:none;appearance:none;
          ">
            ${Array.from({length:28}, (_, i) => i+1).map(d =>
              `<option value="${d}" ${dom === d ? 'selected' : ''}>Day ${d}</option>`
            ).join('')}
          </select>
        </div>
        <button id="backup-schedule-save" class="btn btn-primary" style="height:38px;white-space:nowrap;">
          <i class="fa-solid fa-floppy-disk"></i> Save Schedule
        </button>
        <button id="backup-run-now-btn" class="btn btn-outline" style="height:38px;white-space:nowrap;">
          <i class="fa-solid fa-database"></i> Run Now
        </button>
        <button id="admin-backup-btn" class="btn btn-outline" style="height:38px;white-space:nowrap;margin-left:8px;">
          <i class="fa-solid fa-download"></i> Backup local
        </button>
      </div>

      <div style="margin-top:14px;padding:10px 14px;background:#eff6ff;border-radius:8px;font-size:12px;color:#1e40af;margin-bottom:20px;">
        <i class="fa-solid fa-shield-halved" style="margin-right:6px;"></i>
        Backups include the last 3 months of transactional data and are saved directly to your machine.
        Master records (employees, projects, assets, role settings) are <strong>never deleted</strong>.
      </div>
      
      <div style="border-top:1px solid #e2e8f0;padding-top:20px;">
        <h4 style="font-size:14px;font-weight:600;margin-bottom:12px;color:var(--text-primary);">Backup Execution Logs</h4>
        <div style="background:#fff;border:1px solid #e2e8f0;border-radius:8px;max-height:300px;overflow-y:auto;overflow-x:auto;">
          <table style="width:100%;border-collapse:separate;border-spacing:0;font-size:12px;">
            <thead>
              <tr style="background:#f8fafc;border-bottom:1px solid #e2e8f0;text-align:left;color:#64748b;">
                <th style="position:sticky;top:0;background:#f8fafc;z-index:10;border-bottom:1px solid #e2e8f0;padding:10px 12px;font-weight:600;">Timestamp</th>
                <th style="position:sticky;top:0;background:#f8fafc;z-index:10;border-bottom:1px solid #e2e8f0;padding:10px 12px;font-weight:600;">Status</th>
                <th style="position:sticky;top:0;background:#f8fafc;z-index:10;border-bottom:1px solid #e2e8f0;padding:10px 12px;font-weight:600;">Details</th>
              </tr>
            </thead>
            <tbody>
              ${(cfg.history && cfg.history.length > 0) ? cfg.history.map(log => `
                <tr style="border-bottom:1px solid #f1f5f9;">
                  <td style="padding:10px 12px;color:var(--text-primary);white-space:nowrap;">
                    ${new Date(log.timestamp).toLocaleString('en-IN', {day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit', hour12:true})}
                  </td>
                  <td style="padding:10px 12px;">
                    ${log.status === 'success' 
                      ? '<span style="display:inline-block;padding:2px 8px;border-radius:12px;background:#dcfce7;color:#166534;font-weight:500;">Success</span>'
                      : '<span style="display:inline-block;padding:2px 8px;border-radius:12px;background:#fee2e2;color:#991b1b;font-weight:500;">Failed</span>'
                    }
                  </td>
                  <td style="padding:10px 12px;color:var(--text-secondary);">
                    ${log.status === 'success' 
                      ? `Purged ${log.records_purged || 0} rows. <a href="${log.url}" target="_blank" style="color:#2563eb;text-decoration:none;"><i class="fa-solid fa-arrow-up-right-from-square"></i> OneDrive File</a>` 
                      : `<span style="color:#dc2626">${log.error || 'Unknown error'}</span>`
                    }
                  </td>
                </tr>
              `).join('') : `
                <tr>
                  <td colspan="3" style="padding:16px;text-align:center;color:#94a3b8;font-style:italic;">No backup logs recorded yet.</td>
                </tr>
              `}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `;
};

/** Update just the "Last Backup" label inside the card without a full re-render */
const _refreshBackupScheduleCardStatus = () => {
  const el = document.getElementById('backup-last-run-label');
  if (!el) return;
  const lastDate = localStorage.getItem(BACKUP_LS_KEY);
  el.textContent = lastDate
    ? new Date(lastDate).toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' })
    : 'Never';
};

/** Save new schedule to backend and update UI */
const saveBackupSchedule = async () => {
  const saveBtn   = document.getElementById('backup-schedule-save');
  const freqEl    = document.getElementById('backup-frequency-select');
  const domEl     = document.getElementById('backup-dom-select');
  const toggleEl  = document.getElementById('backup-enabled-toggle');

  if (!freqEl) return;
  const freq    = freqEl.value;
  const dom     = domEl ? parseInt(domEl.value, 10) : 1;
  const enabled = toggleEl ? toggleEl.checked : true;

  if (saveBtn) { saveBtn.disabled = true; saveBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving…'; }

  try {
    const res = await fetch(`${BASE_URL}/api/admin/backup-config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ frequency: freq, day_of_month: dom, enabled }),
    });
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error || 'Save failed');
    showBackupToast('✅ Backup schedule saved', 'success', 3500);
    
    // Re-render the card with the updated config from backend
    if (data.config) {
      const wrap = document.getElementById('backup-schedule-wrap');
      if (wrap) {
        wrap.innerHTML = buildBackupScheduleCard(data.config);
        attachBackupScheduleHandlers();
      }
    }
  } catch (err) {
    showBackupToast(`❌ Failed to save schedule: ${err.message}`, 'error', 5000);
  } finally {
    if (saveBtn) { saveBtn.disabled = false; saveBtn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Save Schedule'; }
  }
};

/** Attach all event handlers inside the backup schedule card */
const attachBackupScheduleHandlers = () => {
  // Frequency dropdown → show/hide day-of-month picker
  const freqEl = document.getElementById('backup-frequency-select');
  const domWrap = document.getElementById('backup-dom-wrap');
  if (freqEl && domWrap) {
    freqEl.onchange = () => {
      domWrap.style.display = ['monthly', 'quarterly'].includes(freqEl.value) ? '' : 'none';
    };
  }

  // Toggle switch behaviour
  const toggleEl = document.getElementById('backup-enabled-toggle');
  const track    = document.getElementById('backup-toggle-track');
  const knob     = document.getElementById('backup-toggle-knob');
  if (toggleEl && track && knob) {
    toggleEl.onchange = () => {
      const on = toggleEl.checked;
      track.style.background = on ? '#2563eb' : '#d1d5db';
      knob.style.left = on ? '21px' : '3px';
    };
  }

  // Save button
  const saveBtn = document.getElementById('backup-schedule-save');
  if (saveBtn) saveBtn.onclick = saveBackupSchedule;

  // Run-Now button
  const runNowBtn = document.getElementById('backup-run-now-btn');
  if (runNowBtn) {
    runNowBtn.onclick = () => {
      runNowBtn.disabled = true;
      runAutoBackup(false).finally(() => { runNowBtn.disabled = false; });
    };
  }

  // Backup local button
  const backupLocalBtn = document.getElementById('admin-backup-btn');
  if (backupLocalBtn) {
    backupLocalBtn.onclick = downloadAdminBackup;
  }
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
  const backupBtn = document.getElementById('admin-backup-btn');
  if (backupBtn) {
    backupBtn.onclick = downloadAdminBackup;
  }
  // Wire up backup schedule card handlers after each render
  attachBackupScheduleHandlers();
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

    // Check if URL hash has ?tab=faceauth
    const hashStr = window.location.hash || '';
    const hashQs = hashStr.includes('?') ? hashStr.split('?')[1] : '';
    const hashParams = new URLSearchParams(hashQs);
    if (hashParams.get('tab') === 'faceauth') {
      activeAdminTab = 'faceauth';
    }

    const tabBarHtml = `
      <div style="display:flex;border-bottom:1px solid #e5e7eb;padding:0 24px;margin-bottom:16px;">
        <button id="admin-tab-officehub" style="padding:10px 20px;font-size:14px;font-weight:500;border:none;border-bottom:2px solid ${activeAdminTab === 'officehub' ? '#2563eb' : 'transparent'};color:${activeAdminTab === 'officehub' ? '#2563eb' : '#9ca3af'};background:transparent;cursor:pointer;margin-bottom:-1px;transition:color 0.2s,border-color 0.2s;">OfficeHub</button>
        <button id="admin-tab-faceauth" style="padding:10px 20px;font-size:14px;font-weight:500;border:none;border-bottom:2px solid ${activeAdminTab === 'faceauth' ? '#2563eb' : 'transparent'};color:${activeAdminTab === 'faceauth' ? '#2563eb' : '#9ca3af'};background:transparent;cursor:pointer;margin-bottom:-1px;transition:color 0.2s,border-color 0.2s;">FaceAuth</button>
      </div>
    `;

    const dashboardContent = buildDashboardLayout(data);

    appContent.innerHTML = getPageContentHTML(
      'Admin Dashboard',
      `${tabBarHtml}
       <div id="officehub-content" style="display:${activeAdminTab === 'officehub' ? 'block' : 'none'};">${dashboardContent}</div>
       <iframe id="faceauth-iframe" title="FaceAuth Admin" allow="camera; microphone"
         style="display:${activeAdminTab === 'faceauth' ? 'block' : 'none'};width:100%;height:calc(100vh - 130px);border:none;"
       ></iframe>`,
      '<button id="admin-export-wsr" class="btn btn-primary" style="margin-right: 8px;"><i class="fa-solid fa-download"></i> Export WSR report</button><button id="admin-dashboard-refresh" class="btn btn-outline"><i class="fa-solid fa-rotate"></i> Refresh</button>'
    );

    attachRefreshAction();
    attachTabSwitcher();
    startElapsedTick();

    // If faceauth tab is active, load the iframe
    if (activeAdminTab === 'faceauth') {
      loadFaceAuthIframe();
    }

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

const switchAdminTab = (tab) => {
  activeAdminTab = tab;
  const ohContent = document.getElementById('officehub-content');
  const faIframe = document.getElementById('faceauth-iframe');
  const ohTab = document.getElementById('admin-tab-officehub');
  const faTab = document.getElementById('admin-tab-faceauth');

  if (ohContent) ohContent.style.display = tab === 'officehub' ? 'block' : 'none';
  if (faIframe) faIframe.style.display = tab === 'faceauth' ? 'block' : 'none';

  if (ohTab) {
    ohTab.style.borderBottomColor = tab === 'officehub' ? '#2563eb' : 'transparent';
    ohTab.style.color = tab === 'officehub' ? '#2563eb' : '#9ca3af';
  }
  if (faTab) {
    faTab.style.borderBottomColor = tab === 'faceauth' ? '#2563eb' : 'transparent';
    faTab.style.color = tab === 'faceauth' ? '#2563eb' : '#9ca3af';
  }

  if (tab === 'faceauth') {
    loadFaceAuthIframe();
  }
};

const loadFaceAuthIframe = async () => {
  const iframe = document.getElementById('faceauth-iframe');
  if (!iframe || faceAuthIframeLoaded) return;
  faceAuthIframeLoaded = true;

  try {
    const authToken = localStorage.getItem('authToken') || '';
    const res = await fetch(`${BASE_URL}/api/faceauth/admin-sso-token`, {
      headers: { 'Authorization': `Bearer ${authToken}` }
    });
    const data = await res.json();
    if (res.ok && data.success && data.sso_token && data.admin_url) {
      iframe.src = `${data.admin_url}?token=${encodeURIComponent(data.sso_token)}`;
    } else {
      iframe.src = 'https://biometrics.vtabsquare.com/admin/dashboard';
    }
  } catch (err) {
    console.error('[FaceAuth] SSO token fetch failed, falling back:', err);
    iframe.src = 'https://biometrics.vtabsquare.com/admin/dashboard';
  }
};

const attachTabSwitcher = () => {
  const ohTab = document.getElementById('admin-tab-officehub');
  const faTab = document.getElementById('admin-tab-faceauth');
  if (ohTab) ohTab.onclick = () => switchAdminTab('officehub');
  if (faTab) faTab.onclick = () => switchAdminTab('faceauth');
};

export const renderAdminDashboardPage = async () => {
  stopDashboardTimers();
  bindLiveRefreshHooks();
  faceAuthIframeLoaded = false;

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

  // Silently check and run auto-backup if it is due (non-blocking)
  checkAndRunAutoBackup();

  adminDashboardPollId = setInterval(async () => {
    if (!isAdminDashboardRoute()) {
      stopDashboardTimers();
      return;
    }
    await refreshAndRender(false, 'live');
  }, 15000);
};
