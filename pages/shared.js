// shared.js - Shared Inbox page
import { state } from '../state.js';
import { isAdminUser, isManagerOrAdmin } from '../utils/accessControl.js';
import { getPageContentHTML } from '../utils.js';
import { renderModal, closeModal } from '../components/modal.js';
import { fetchEmployeeLeaves, approveLeave, rejectLeave } from '../features/leaveApi.js';
import { showToast } from '../components/toast.js';
import { listClients, createClient, updateClient, deleteClient, getNextClientId } from '../features/clientApi.js';
import { fetchPendingLeaves } from '../features/leaveApi.js';
import { notifyEmployeeLeaveApproval, notifyEmployeeLeaveRejection, updateNotificationBadge, notifyEmployeeCompOffGranted, notifyEmployeeCompOffRejected } from '../features/notificationApi.js';
import { fetchCompOffRequests, approveCompOffRequest, rejectCompOffRequest } from '../features/compOffApi.js';
import { listEmployees } from '../features/employeeApi.js';
import { isCheckedIn } from '../features/attendanceRenderer.js';
import { apiBase } from '../config.js';
import { cachedFetch, TTL } from '../features/cache.js';
import { runWithSubmissionLoading } from '../utils/submissionLoading.js';

let currentInboxTab = 'awaiting';
let currentInboxCategory = 'leaves';
let _resolvedEmpIdCache = '';
let _resolvedEmpIdPromise = null;

const canManageMyTimesheetRows = () => {
    return true;
};

const renderMyTsRow = (days, idx = 0) => {
    const dayInputs = days.map(function (d, i) { return '<div class="ts-cell"><input class="ts-input ts-hhmm" data-row="' + idx + '" data-col="' + i + '" placeholder="HH:MM" /></div>'; }).join('');
    return `
      <div class="ts-cell">
        <select class="ts-input ts-project">
          <option value="">Select project</option>
          <option>Project Python Development</option>
          <option>Internal</option>
        </select>
      </div>
      <div class="ts-cell">
        <select class="ts-input ts-task">
          <option value="">Select task</option>
          <option>Python Training</option>
          <option>Development</option>
        </select>
      </div>
      <div class="ts-cell">
        <select class="ts-input ts-billing">
          <option>Billable</option>
          <option selected>Non-billable</option>
        </select>
      </div>
      ${dayInputs}
      <div class="ts-cell ts-total" data-row-total="${idx}">00:00</div>
    `;
};

const parseHHMM = (s) => {
    if (!s) return 0;
    const m = String(s).trim().match(/^(\d{1,2})(?::(\d{1,2}))?$/);
    if (!m) return 0;
    const h = parseInt(m[1] || '0', 10);
    const mm = parseInt(m[2] || '0', 10);
    if (mm >= 60) return 0;
    return h * 60 + mm;
};
const fmtHHMM = (mins) => {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
};

const recalcMyTsTotals = () => {
    const rows = Array.from(document.querySelectorAll('.ts-hhmm'))
        .reduce((acc, el) => {
            const r = el.getAttribute('data-row');
            const v = parseHHMM(el.value);
            acc[r] = (acc[r] || 0) + v;
            return acc;
        }, {});
    let totalLogged = 0;
    Object.keys(rows).forEach(r => {
        totalLogged += rows[r] || 0;
        const tgt = document.querySelector(`[data-row-total="${r}"]`);
        if (tgt) tgt.textContent = fmtHHMM(rows[r] || 0);
    });
    const totalBillable = totalLogged; // placeholder; billing split not implemented
    const tl = document.getElementById('ts-total-logged');
    const tb = document.getElementById('ts-total-billable');
    if (tl) tl.textContent = `${fmtHHMM(totalLogged)}`;
    if (tb) tb.textContent = `${fmtHHMM(totalBillable)}`;
};

const attachMyTsEvents = () => {
    const debounce = (fn, t = 200) => { let id; return (...a) => { clearTimeout(id); id = setTimeout(() => fn(...a), t); }; };
    document.querySelectorAll('.ts-hhmm').forEach((inp) => {
        inp.addEventListener('input', debounce(() => recalcMyTsTotals(), 100));
        inp.addEventListener('blur', () => recalcMyTsTotals());
    });
    const add = document.getElementById('ts-add');
    if (add) add.addEventListener('click', () => {
        const grid = document.querySelector('.ts-grid');
        if (!grid) return;
        const rows = document.querySelectorAll('[data-row-total]');
        const idx = rows.length;
        const weekStart = window.__myTsDate;
        const days = Array.from({ length: 7 }, (_, i) => new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + i));
        const wrap = document.createElement('div');
        wrap.className = 'ts-row';
        wrap.innerHTML = renderMyTsRow(days, idx);
        grid.appendChild(wrap);
        setTimeout(() => attachMyTsEvents(), 0);
    });
    const prev = document.getElementById('ts-prev');
    const next = document.getElementById('ts-next');
    if (prev) prev.onclick = () => { const d = new Date(window.__myTsDate); d.setDate(d.getDate() - 7); window.__myTsDate = d; renderMyTimesheetPage(); };
    if (next) next.onclick = () => { const d = new Date(window.__myTsDate); d.setDate(d.getDate() + 7); window.__myTsDate = d; renderMyTimesheetPage(); };
};

const initials = (name) => (name || '').split(' ').filter(Boolean).slice(0, 2).map(s => s[0].toUpperCase()).join('') || 'NA';
const badgeColor = (seed) => {
    const colors = ['#3498db', '#9b59b6', '#e67e22', '#1abc9c', '#e74c3c', '#2ecc71', '#34495e'];
    let h = 0; for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
    return colors[h % colors.length];
};
const teamRow = (emp, days, logs) => {
    // Helper to format seconds as HH:MM
    const formatTime = (secs) => {
        if (!secs) return '00:00';
        const h = Math.floor(secs / 3600);
        const m = Math.floor((secs % 3600) / 60);
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    };

    const upEmp = (emp.id || '').toUpperCase();
    const manualFlags = [];
    const dayHours = days.map(d => {
        const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; // YYYY-MM-DD (local)
        // Use local date for comparison
        const today = new Date();
        const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

        // Only process dates that are today or in the past (string comparison)
        if (dateStr > todayStr) {
            manualFlags.push(false);
            return 0;
        }

        let totalSecs = 0;
        let isManual = false;
        (logs || []).forEach(l => {
            const logEmpId = (l.employee_id || '').toUpperCase();
            const logDate = (l.work_date || '').slice(0, 10); // Ensure YYYY-MM-DD format
            if (logEmpId === upEmp && logDate === dateStr) {
                const secs = Number(l.seconds || 0);
                totalSecs += secs;
                if (l.manual) isManual = true;
            }
        });
        manualFlags.push(isManual);
        return totalSecs;
    });

    // Calculate total for the month
    const totalSecs = dayHours.reduce((sum, h) => sum + h, 0);

    // Debug logging for employees with logged time
    if (totalSecs > 0) {
        console.log(`Team Timesheet - ${emp.name} (${emp.id}): ${formatTime(totalSecs)} total`);
        console.log(`  Day hours:`, dayHours.map((h, i) => {
            const d = days[i];
            const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
            return `${ds}=${formatTime(h)}`;
        }).filter((_, i) => dayHours[i] > 0));
    }

    const left = `
      <div class="tt-cell tt-sticky" style="display:flex; align-items:center; justify-content:flex-start; gap:10px;">
        <span class="emp-badge" style="background:${badgeColor(emp.id)}">${initials(emp.name)}</span>
        <div>
          <div style="font-weight:600; color: var(--text-primary, #1f2937);">${emp.name}</div>
          <div style="color: var(--text-secondary, #6b7280); font-size:12px;">${emp.id}</div>
        </div>
      </div>`;
    const total = `<div class="tt-cell tt-total" style="text-align:center; font-weight:600;">${formatTime(totalSecs)}</div>`;
    const cells = dayHours.map((h, i) => {
        const d = days[i];
        const isSunday = d.getDay() === 0;
        const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        const today = new Date();
        const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

        // Hard guard: never render time for future days
        const isFuture = ds > todayStr;
        if (isSunday) {
            return `<div class="tt-cell day-off"><span>DO</span></div>`;
        }
        if (!isFuture && h > 0) {
            const icon = manualFlags[i]
                ? '<i class="fa-solid fa-users" style="font-size:10px; color:#eaf2ff; position:absolute; top:4px; right:4px;" title="Manually edited by admin"></i>'
                : '<i class="fa-regular fa-clock" style="font-size:10px; color:#eaf2ff; position:absolute; top:4px; right:4px;" title="Automatic capture (play/stop)"></i>';
            return `<div class="tt-cell worked" data-emp="${emp.id}" data-date="${ds}" style="position:relative;"><span style="font-weight:700; font-size:13px;">${formatTime(h)}</span>${icon}</div>`;
        }
        return `<div class="tt-cell empty"></div>`;
    }).join('');
    return `<div class="tt-row">${left}${total}${cells}</div>`;
};
const nameFilter = (arr, q) => {
    const s = String(q || '').trim().toLowerCase();
    if (!s) return arr;
    return arr.filter(x => x.id.toLowerCase().includes(s) || (x.name || '').toLowerCase().includes(s));
};
const canEditTeamTimesheet = () => {
    try {
        return isAdminUser();
    } catch {
        return false;
    }
};

const formatTeamTimesheetDuration = (secs) => {
    if (!secs) return '00:00';
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
};

const escapeTeamTimesheetCell = (value) => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const exportTeamTimesheetToExcel = () => {
    const exportState = window.__teamTsExportState;
    if (!exportState || !Array.isArray(exportState.items) || !Array.isArray(exportState.days)) {
        showToast('No data available to export', 'warning');
        return;
    }

    const { month, days, items, logs } = exportState;
    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

    // OT constants
    const BREAK_SECS = 3600;          // 1-hour fixed break deducted per working day
    const STD_WORK_SECS = 9 * 3600;   // 9-hour standard working day

    // Build headers: each date column is immediately followed by its "Mon OT" column
    const headerCells = [
        '<th>Employee Name</th>',
        '<th>Employee ID</th>',
        '<th>Total</th>',
        ...days.flatMap((d) => {
            const dayLabel = d.toLocaleDateString(undefined, { weekday: 'short', day: '2-digit', month: 'short' });
            const otLabel = d.toLocaleDateString(undefined, { weekday: 'short' }) + ' OT';
            return [
                `<th>${escapeTeamTimesheetCell(dayLabel)}</th>`,
                `<th>${escapeTeamTimesheetCell(otLabel)}</th>`
            ];
        })
    ].join('');

    const bodyRows = items.map((emp) => {
        const upEmp = String(emp.id || '').toUpperCase();

        // Build per-day pairs: { rawValue, stdValue (HH:MM), otValue (HH:MM) }
        const dayPairs = days.map((d) => {
            const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
            const isSunday = d.getDay() === 0;
            const isFuture = dateStr > todayStr;

            if (isSunday) return { rawValue: 'DO', stdValue: '00:00', otValue: '00:00' };
            if (isFuture) return { rawValue: '', stdValue: '00:00', otValue: '00:00' };

            // Sum raw seconds for this employee on this day
            let rawSecs = 0;
            (logs || []).forEach((l) => {
                const logEmpId = String(l.employee_id || '').toUpperCase();
                const logDate = String(l.work_date || '').slice(0, 10);
                if (logEmpId === upEmp && logDate === dateStr) {
                    rawSecs += Number(l.seconds || 0);
                }
            });

            // Standard and OT computed inside the per-day loop, not after summing
            const netSecs = Math.max(0, rawSecs - BREAK_SECS); // deduct break; floor at 0
            const stdSecs = rawSecs > 0 ? Math.min(netSecs, STD_WORK_SECS) : 0;
            const otSecs = rawSecs > 0 ? Math.max(0, netSecs - STD_WORK_SECS) : 0;

            return {
                rawValue: rawSecs > 0 ? formatTeamTimesheetDuration(rawSecs) : '',
                stdValue: rawSecs > 0 ? formatTeamTimesheetDuration(stdSecs) : '00:00',
                otValue: formatTeamTimesheetDuration(otSecs)   // always HH:MM, min 00:00
            };
        });

        // --- existing total (unchanged) ---
        const totalSecs = dayPairs.reduce((acc, { rawValue }) => {
            if (!rawValue || rawValue === 'DO') return acc;
            const m = String(rawValue).match(/^(\d{2}):(\d{2})$/);
            if (!m) return acc;
            return acc + (parseInt(m[1], 10) * 3600) + (parseInt(m[2], 10) * 60);
        }, 0);

        const cells = [
            `<td>${escapeTeamTimesheetCell(emp.name || '')}</td>`,
            `<td>${escapeTeamTimesheetCell(emp.id || '')}</td>`,
            `<td>${escapeTeamTimesheetCell(formatTeamTimesheetDuration(totalSecs))}</td>`,
            // Interleave: standard value then its OT column, per-day
            ...dayPairs.flatMap(({ stdValue, otValue }) => [
                `<td>${escapeTeamTimesheetCell(stdValue)}</td>`,
                `<td>${escapeTeamTimesheetCell(otValue)}</td>`
            ])
        ].join('');

        return `<tr>${cells}</tr>`;
    }).join('');

    const monthLabel = month instanceof Date
        ? month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
        : '';

    const html = `
        <html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">
          <head>
            <meta charset="UTF-8" />
            <style>
              table { border-collapse: collapse; font-family: Arial, sans-serif; }
              th, td { border: 1px solid #d1d5db; padding: 6px 8px; font-size: 12px; }
              th { background: #eef2ff; font-weight: 700; }
            </style>
          </head>
          <body>
            <h3>My Team Timesheet - ${escapeTeamTimesheetCell(monthLabel)}</h3>
            <table>
              <thead><tr>${headerCells}</tr></thead>
              <tbody>${bodyRows}</tbody>
            </table>
          </body>
        </html>`;

    const blob = new Blob([`\ufeff${html}`], { type: 'application/vnd.ms-excel;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    const fileDate = month instanceof Date
        ? `${month.getFullYear()}_${String(month.getMonth() + 1).padStart(2, '0')}`
        : new Date().toISOString().slice(0, 7).replace('-', '_');

    link.href = url;
    link.download = `my_team_timesheet_${fileDate}.xls`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
};

const attachTeamTsEvents = () => {

    const prev = document.getElementById('tt-prev');
    const next = document.getElementById('tt-next');
    if (prev) prev.onclick = () => { const d = new Date(window.__teamTsMonth || new Date()); d.setMonth(d.getMonth() - 1); window.__teamTsMonth = d; renderTeamTimesheetPage(); };
    if (next) next.onclick = () => { const d = new Date(window.__teamTsMonth || new Date()); d.setMonth(d.getMonth() + 1); window.__teamTsMonth = d; renderTeamTimesheetPage(); };
    const search = document.getElementById('tt-search');
    if (search) {
        let id; 
        search.addEventListener('input', (e) => { 
            clearTimeout(id); 
            const v = e.target.value;
            const cursorPosition = e.target.selectionStart;
            id = setTimeout(() => { 
                window.__ttSearch = v; 
                renderTeamTimesheetPage().then(() => {
                    // Restore focus and cursor position after re-render
                    const newSearch = document.getElementById('tt-search');
                    if (newSearch) {
                        newSearch.focus();
                        newSearch.setSelectionRange(cursorPosition, cursorPosition);
                    }
                });
            }, 250); 
        });
    }
    const exportBtn = document.getElementById('tt-export-excel');
    if (exportBtn) {
        exportBtn.onclick = () => exportTeamTimesheetToExcel();
    }
    if (canEditTeamTimesheet()) {
        document.querySelectorAll('.tt-cell.worked').forEach(cell => {
            cell.addEventListener('click', () => {

                const empId = cell.getAttribute('data-emp');
                const dateStr = cell.getAttribute('data-date');
                if (!empId || !dateStr) return;
                openTeamTsEditModal(empId, dateStr).catch(err => console.error('Team TS edit modal error', err));
            });
        });
    }
};

const resolveCurrentEmployeeId = async () => {
    // Return cached result if available
    if (_resolvedEmpIdCache) return _resolvedEmpIdCache;
    // Deduplicate concurrent calls
    if (_resolvedEmpIdPromise) return _resolvedEmpIdPromise;
    _resolvedEmpIdPromise = (async () => {
        let empId = String(state.user?.id || '').trim().toUpperCase();
        const userName = state.user?.name;
        try {
            const allEmployees = await listEmployees(1, 5000);
            if (empId && empId.startsWith('EMP')) {
                const matchId = (allEmployees.items || []).find(e => (e.employee_id || '').toUpperCase() === empId);
                if (matchId) {
                    _resolvedEmpIdCache = empId;
                    return empId;
                }
            }
            if (userName) {
                const match = (allEmployees.items || []).find(e => {
                    const empFullName = `${e.first_name || ''} ${e.last_name || ''}`.trim().toLowerCase();
                    return empFullName === userName.toLowerCase().trim();
                });
                if (match && match.employee_id) {
                    empId = match.employee_id.trim().toUpperCase();
                    state.user.id = empId;
                    _resolvedEmpIdCache = empId;
                    return empId;
                }
            }
        } catch { }
        if (empId) _resolvedEmpIdCache = empId;
        return empId;
    })();
    try {
        const result = await _resolvedEmpIdPromise;
        return result;
    } finally {
        _resolvedEmpIdPromise = null;
    }
};

export const renderTimeTrackerPage = () => {
    const content = `<div class="card"><p class="placeholder-text">Time Tracker page is under construction.</p></div>`;
    document.getElementById('app-content').innerHTML = getPageContentHTML('My Team Timesheet', content);
};

// Time Tracker subpages (placeholders)
export const renderMyTasksPage = async () => {
    const user = state?.user || window.state?.user || {};
    let empId = String((user.id || user.employee_id || user.employeeId || '')).trim();
    const empName = String((user.name || user.fullName || user.username || '')).trim();
    const email = String((user.email || user.mail || '')).trim();

    console.log('My Tasks - User:', user);
    console.log('My Tasks - Employee ID:', empId);
    if (!empId) {
        try { empId = await resolveCurrentEmployeeId(); } catch { }
        if (empId) { try { state.user = { ...(state.user || {}), id: empId }; } catch { } }
    }
    const isPrivileged = !!user.is_admin || ['EMP001'].includes((empId || '').toUpperCase()) || /\b(bala|vignesh)\b/i.test(empName || email);

    // Projects cache for client column
    let projectsIdx = {};
    try {
        const raw = localStorage.getItem('tt_projects_v1');
        const arr = raw ? JSON.parse(raw) : [];
        (arr || []).forEach(p => { projectsIdx[(p.id || p.crc6f_projectid)] = p; });
    } catch { }

    const API = `${apiBase}/api`;
    let tasks = [];
    let search = '';

    // Initial lightweight skeleton while tasks and indexes are loading
    try {
        const skeleton = `
            <div class="card">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.75rem;">
                    <div class="skeleton skeleton-heading-md"></div>
                    <div class="skeleton skeleton-pill" style="width:140px; height:32px;"></div>
                </div>
                <div class="skeleton skeleton-chart-line"></div>
            </div>
        `;
        const app = document.getElementById('app-content');
        if (app) app.innerHTML = getPageContentHTML('My Tasks', skeleton);
    } catch { }

    const loadTasks = async () => {
        const params = new URLSearchParams();
        // Use /my-tasks so backend matches by employee id, name, or email depending on what is stored.
        if (empId) params.set('user_id', String(empId).trim());
        if (empName) params.set('user_name', String(empName).trim());
        if (email) params.set('user_email', String(email).trim());
        params.set('role', isPrivileged ? 'l3' : 'l1');
        const res = await fetch(`${API}/my-tasks?${params.toString()}`);
        const data = await res.json().catch(() => ({ success: false }));
        let fetched = (res.ok && data.success ? (data.tasks || []) : []);
        // Merge manual tasks stored locally so they show up in My Tasks
        try {
            const key = 'tt_manual_tasks_v1';
            const local = JSON.parse(localStorage.getItem(key) || '[]');
            const localOnlyTasks = (Array.isArray(local) ? local : []).filter(t => {
                const guid = String(t?.guid || t?.task_guid || t?.id || '').trim().toLowerCase();
                const taskId = String(t?.task_id || '').trim().toUpperCase();
                return t?.local_only === true || guid.startsWith('man-') || taskId.startsWith('MAN-');
            });
            const empKey = String(empId || '').toUpperCase();
            const normalizeStatus = (v) => {
                const s = String(v || '').trim();
                if (!s) return '';
                const low = s.toLowerCase();

                if (low === 'canceled' || low === 'cancelled') return 'Cancelled';
                if (low === 'inactive') return 'Inactive';
                if (low === 'deleted') return 'Deleted';
                return s;
            };

            const projectShouldHideTasks = (statusVal) => {
                const low = String(statusVal || '').trim().toLowerCase();
                return low === 'cancelled' || low === 'canceled' || low === 'completed';
            };

            // Clean up stale manual tasks (so deleted project/task doesn't keep showing in My Tasks)
            // - If assigned to this employee and project is missing from projects cache -> remove
            // - If assigned to this employee and status is Deleted -> remove
            let cleaned = [...localOnlyTasks];
            cleaned = cleaned.filter(t => {
                const assigned = String(t?.assigned_to || '').toUpperCase();
                if (assigned !== empKey) return true; // keep other users' manual tasks
                const st = normalizeStatus(t?.task_status);
                if (st.toLowerCase() === 'deleted') return false;

                const pid = String(t?.project_id || '').trim();
                if (pid && projectsIdx) {
                    const project = projectsIdx[pid];
                    if (!project) return false;
                    const projectStatus = project?.status || project?.crc6f_projectstatus || '';
                    if (projectShouldHideTasks(projectStatus)) return false;
                }
                return true;
            });
            try { localStorage.setItem(key, JSON.stringify(cleaned)); } catch { }

            const mine = (cleaned || []).filter(t => String(t.assigned_to || '').toUpperCase() === empKey);
            const normalized = mine.map(t => ({
                guid: t.guid || t.task_guid || t.id || `man-${t.task_id || Date.now()}`,
                task_id: t.task_id || '',
                task_name: t.task_name || 'Manual Task',
                project_id: t.project_id || '',
                task_status: normalizeStatus(t.task_status || 'New') || 'New',
                task_priority: t.task_priority || 'Normal',
                due_date: t.due_date || ''
            }));
            // Deduplicate by guid
            const merged = [...fetched, ...normalized];
            const uniq = merged.filter((v, i, a) => a.findIndex(x => String(x.guid || '') === String(v.guid || '')) === i);
            fetched = uniq;
        } catch { }

        tasks = fetched.filter(t => {
            if (!search) return true;
            const hay = `${t.task_id || ''} ${t.task_name || ''} ${t.task_status || ''} ${t.project_id || ''}`.toLowerCase();
            return hay.includes(search.toLowerCase());
        });
    };

    const fmt = (secs) => {
        const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60), s = secs % 60; return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    };

    const ACTIVE_KEY = (id) => `tt_active_${id}`;
    const todayStr = () => { const t = new Date(); return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`; };
    const PER_TASK_KEY = (emp, guid, date) => `tt_accum_${String(emp || '').toUpperCase()}_${guid}_${date}`;
    const getActive = () => { try { return JSON.parse(localStorage.getItem(ACTIVE_KEY(empId)) || 'null'); } catch { return null; } };
    const setActive = (obj) => { try { localStorage.setItem(ACTIVE_KEY(empId), JSON.stringify(obj)); } catch { } };
    const clearActive = () => { try { localStorage.removeItem(ACTIVE_KEY(empId)); } catch { } };

    const getPersistedSecs = (guid) => { try { return Number(localStorage.getItem(PER_TASK_KEY(empId, guid, todayStr())) || '0') || 0; } catch { return 0; } };
    const setPersistedSecs = (guid, secs) => { try { localStorage.setItem(PER_TASK_KEY(empId, guid, todayStr()), String(Math.max(0, secs | 0))); } catch { } };

    const postTimesheetLog = async ({ seconds, task, started_at = null, ended_at = null }) => {
        const safeSeconds = Math.max(0, Number(seconds || 0) | 0);
        if (safeSeconds <= 0) return true;
        console.log('[MY_TASKS] postTimesheetLog called with:', { seconds, task, started_at, ended_at });
        const body = {
            employee_id: empId,
            project_id: task.project_id,
            task_guid: task.guid,
            task_id: task.task_id,
            task_name: task.task_name,
            seconds: safeSeconds,
            work_date: todayStr(), // legacy fallback
            description: '',
            session_start_ms: started_at || null,
            session_end_ms: ended_at || Date.now(),
            tz_offset_minutes: new Date().getTimezoneOffset()
        };
        const logEndpoints = [`${API}/time-tracker/task-log`, `${API}/time-entries/log`];
        console.log('[MY_TASKS] Request body:', body);
        let lastError = '';
        for (const endpoint of logEndpoints) {
            try {
                console.log('[MY_TASKS] Posting to:', endpoint);
                const res = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
                console.log('[MY_TASKS] Response status:', res.status);
                const result = await res.json().catch(() => ({ success: false }));
                console.log('[MY_TASKS] Response data:', result);

                if (res.ok && result.success !== false) {
                    try { sessionStorage.setItem('tt_last_log', JSON.stringify(body)); } catch { }
                    if (window.location.hash === '#/time-my-timesheet') { try { await renderMyTimesheetPage(); } catch { } }
                    return true;
                }

                lastError = result.error || String(res.status || 'Request failed');
                if (res.status === 404) continue;
            } catch (err) {
                lastError = String(err?.message || err || 'Network error');
                console.error('[MY_TASKS] Timesheet upsert network error:', err);
            }
        }
        console.error('[MY_TASKS] Timesheet upsert failed:', lastError || 'No supported endpoint succeeded');
        return false;
    };

    const activeDateKey = (active) => {
        if (!active) return '';
        if (active.session_date) return String(active.session_date);
        const started = Number(active.started_at || 0);
        if (!started) return '';
        const dt = new Date(started);
        if (Number.isNaN(dt.getTime())) return '';
        return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
    };

    const syncActiveTimerFromBackend = async () => {
        try {
            const res = await fetch(`${API}/time-entries/active/${empId}`);
            const result = await res.json().catch(() => ({ success: false }));
            
            if (!result.success || !result.active_timer) {
                return;
            }

            const backendTimer = result.active_timer;
            const localActive = getActive();
            
            // If backend has an active timer but local doesn't match, sync it
            if (backendTimer && backendTimer.task_guid) {
                const backendTaskGuid = backendTimer.task_guid;
                const startTime = new Date(backendTimer.start).getTime();
                
                // Check if local timer matches backend
                if (!localActive || localActive.task_guid !== backendTaskGuid) {
                    // Find the task in our tasks list to get full details
                    const matchingTask = tasks.find(t => t.guid === backendTaskGuid);
                    
                    if (matchingTask) {
                        console.log('[MY_TASKS] Syncing active timer from backend:', backendTimer);
                        const now = Date.now();
                        const elapsed = Math.floor((now - startTime) / 1000);
                        
                        setActive({
                            task_guid: backendTaskGuid,
                            task_id: matchingTask.task_id,
                            task_name: matchingTask.task_name,
                            project_id: matchingTask.project_id,
                            started_at: startTime,
                            accumulated: Math.max(0, elapsed),
                            paused: false,
                            session_date: todayStr()
                        });
                    }
                }
            } else if (!backendTimer && localActive && !localActive.paused) {
                // Backend has no active timer but local does (not paused) - clear local
                console.log('[MY_TASKS] Clearing local timer - not found on backend');
                clearActive();
            }
        } catch (err) {
            console.warn('[MY_TASKS] Failed to sync active timer from backend:', err);
        }
    };

    const normalizeActiveTimer = async () => {
        const active = getActive();
        if (!active || !active.task_guid) return;
        const today = todayStr();
        const activeDay = activeDateKey(active);
        if (!activeDay || activeDay === today) return;

        // Stale paused timers should never carry over days.
        if (active.paused) {
            clearActive();
            return;
        }

        const startedAt = Number(active.started_at || 0);
        if (!startedAt) {
            clearActive();
            return;
        }

        const startDt = new Date(startedAt);
        if (Number.isNaN(startDt.getTime())) {
            clearActive();
            return;
        }

        // Close stale running session at end of its original local day.
        const endOfStartDay = new Date(startDt);
        endOfStartDay.setHours(23, 59, 59, 999);
        const endedAt = Math.max(startedAt, endOfStartDay.getTime());
        const elapsed = Math.max(1, Math.floor((endedAt - startedAt) / 1000));
        const task = {
            guid: active.task_guid,
            task_id: active.task_id,
            task_name: active.task_name,
            project_id: active.project_id,
        };

        try {
            await postTimesheetLog({
                seconds: elapsed,
                task,
                started_at: startedAt,
                ended_at: endedAt,
            });
        } catch (err) {
            console.warn('[MY_TASKS] Failed stale timer auto-log:', err);
        }

        try {
            await stopTaskTimer(task);
        } catch { }

        clearActive();
    };

    const startTaskTimer = async (task) => {
        try {
            const res = await fetch(`${API}/time-entries/start`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    task_guid: task.guid,
                    user_id: empId
                })
            });
            const result = await res.json().catch(() => ({ success: false }));
            if (result.success) {
                console.log('[MY_TASKS] Task timer started on backend:', result);
                return true;
            } else {
                console.error('[MY_TASKS] Failed to start task timer:', result.error);
                return false;
            }
        } catch (err) {
            console.error('[MY_TASKS] Error starting task timer:', err);
            return false;
        }
    };

    const stopTaskTimer = async (task) => {
        try {
            const res = await fetch(`${API}/time-entries/stop`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    task_guid: task.guid,
                    user_id: empId
                })
            });
            const result = await res.json().catch(() => ({ success: false }));
            if (result.success) {
                console.log('[MY_TASKS] Task timer stopped on backend:', result);
                return true;
            } else {
                console.error('[MY_TASKS] Failed to stop task timer:', result.error);
                return false;
            }
        } catch (err) {
            console.error('[MY_TASKS] Error stopping task timer:', err);
            return false;
        }
    };

    const updateTaskStatus = async (task, newStatus) => {
        try {
            const target = String(newStatus || '').trim();
            if (!target) return;
            const current = String(task.task_status || '').trim().toLowerCase();
            if (current === target.toLowerCase()) return;

            const guidStr = String(task.guid || '');
            if (guidStr.startsWith('man-')) {
                task.task_status = target;
                try {
                    const key = 'tt_manual_tasks_v1';
                    const cur = JSON.parse(localStorage.getItem(key) || '[]');
                    const idx = cur.findIndex(x => String(x.guid || x.task_guid || x.id) === guidStr);
                    if (idx >= 0) {
                        cur[idx].task_status = target;
                        localStorage.setItem(key, JSON.stringify(cur));
                    }
                } catch { }
                return;
            }

            if (!guidStr) return;

            const res = await fetch(`${API}/tasks/${guidStr}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ task_status: target })
            });
            const data = await res.json().catch(() => ({ success: false }));
            if (!res.ok || data.success === false) {
                console.error('Task status update failed:', data.error || res.status);
                return;
            }
            task.task_status = target;
        } catch (err) {
            console.error('Task status update error:', err);
        }
    };

    const toggleTimer = async (t) => {
        const cur = getActive();
        // If timer is running for this task, pause it
        if (cur && cur.task_guid === t.guid && !cur.paused) {
            const elapsed = Math.floor((Date.now() - Number(cur.started_at)) / 1000);
            const totalAccumulated = (cur.accumulated || 0) + elapsed;
            setActive({ ...cur, accumulated: totalAccumulated, paused: true, started_at: null });
            setPersistedSecs(t.guid, totalAccumulated);
            await postTimesheetLog({ seconds: elapsed, task: t, started_at: cur.started_at, ended_at: Date.now() });
            await stopTaskTimer(t);
            render();
            return;
        }

        // If another task is running, stop it first
        if (cur && cur.task_guid && cur.task_guid !== t.guid && !cur.paused) {
            // Auto-pause current and upsert
            const elapsed = Math.floor((Date.now() - Number(cur.started_at)) / 1000);
            const totalAccumulated = (cur.accumulated || 0) + elapsed;
            // Persist for the old task
            setPersistedSecs(cur.task_guid, totalAccumulated);
            await postTimesheetLog({
                seconds: elapsed,
                task: { guid: cur.task_guid, task_id: cur.task_id, task_name: cur.task_name, project_id: cur.project_id },
                started_at: cur.started_at,
                ended_at: Date.now()
            });
            await stopTaskTimer({ guid: cur.task_guid });
            // Clear active
            clearActive();
        }
        // Start or resume this task
        if (cur && cur.task_guid === t.guid && cur.paused) {
            // Resume from paused state
            const now = Date.now();
            setActive({ ...cur, started_at: now, paused: false, session_date: todayStr() });
            await startTaskTimer(t);
        } else {
            // Start fresh
            // Seed with persisted seconds for today so it continues from stored value
            const persisted = getPersistedSecs(t.guid);
            const now = Date.now();
            setActive({ task_guid: t.guid, task_id: t.task_id, task_name: t.task_name, project_id: t.project_id, started_at: now, accumulated: persisted, paused: false, session_date: todayStr() });
            await startTaskTimer(t);
        }
        await updateTaskStatus(t, 'In Progress');
        render();
    };

    const stopLocalTimer = async (t) => {
        const cur = getActive();
        if (!cur || cur.task_guid !== t.guid) return;

        // Calculate total seconds (accumulated + current session if running)
        let segmentSeconds = 0;
        let segmentStartedAt = null;
        if (!cur.paused && cur.started_at) {
            segmentStartedAt = cur.started_at;
            segmentSeconds = Math.floor((Date.now() - Number(cur.started_at)) / 1000);
        }
        const totalSeconds = Math.max(0, (cur.accumulated || 0) + segmentSeconds);

        // persist and upsert
        setPersistedSecs(t.guid, totalSeconds);
        const ok = await postTimesheetLog({ seconds: segmentSeconds, task: t, started_at: segmentStartedAt, ended_at: Date.now() });
        await stopTaskTimer(t);
        if (ok) {
            clearActive();
        }
    };

    let timerInterval = null;
    let checkInStateInterval = null;

    const updateTimers = () => {
        const active = getActive();
        if (!active) {
            document.querySelectorAll('tr[data-guid] .tt-time').forEach(cell => {
                const tr = cell.closest('tr');
                const guid = tr?.getAttribute('data-guid');
                if (!guid) return;
                const secs = getPersistedSecs(guid);
                cell.innerHTML = secs > 0
                    ? `<span class="running" style="color:#f39c12; font-weight:600;">${fmt(secs)}</span>`
                    : '-';
            });
            if (timerInterval) {
                clearInterval(timerInterval);
                timerInterval = null;
            }
            return;
        }

        document.querySelectorAll('tr[data-guid] .tt-time').forEach(cell => {
            const tr = cell.closest('tr');
            const guid = tr?.getAttribute('data-guid');
            if (guid === active.task_guid) {
                let totalSecs = active.accumulated || 0;
                if (!active.paused && active.started_at) {
                    totalSecs += Math.floor((Date.now() - Number(active.started_at)) / 1000);
                }
                const color = active.paused ? '#f39c12' : '#d63031';
                cell.innerHTML = `<span class="running" style="color:${color}; font-weight:600;">${fmt(totalSecs)}</span>`;
            }
        });
    };

    const updatePlayButtonStates = () => {
        const checkedIn = isCheckedIn();
        const active = getActive();

        document.querySelectorAll('tr[data-guid] .action-btn.toggle-timer').forEach(btn => {
            const tr = btn.closest('tr');
            const guid = tr?.getAttribute('data-guid');
            const t = tasks.find(x => x.guid === guid);
            if (!t) return;
            
            const isRunning = active && active.task_guid === t.guid && !active.paused;
            const isPaused = active && active.task_guid === t.guid && active.paused;
            
            // Enable button if checked in OR if this task is already running/paused
            const shouldEnable = checkedIn || isRunning || isPaused;
            
            if (shouldEnable) {
                btn.removeAttribute('disabled');
                btn.classList.remove('disabled');
                const title = isRunning ? 'Pause' : (isPaused ? 'Resume' : 'Start');
                btn.setAttribute('title', title);
            } else {
                btn.setAttribute('disabled', 'disabled');
                btn.classList.add('disabled');
                btn.setAttribute('title', 'Please check in first to start task timer');
            }
        });
    };

    const render = async () => {
        await normalizeActiveTimer();
        await loadTasks();
        await syncActiveTimerFromBackend();
        const active = getActive();
        const checkedIn = isCheckedIn();
        const rows = tasks.map(t => {
            const proj = projectsIdx[t.project_id] || {};
            const clientName = proj.client || '';
            const projectName = proj.name || (t.project_id || '');
            const isRunning = active && active.task_guid === t.guid && !active.paused;
            const isPaused = active && active.task_guid === t.guid && active.paused;

            let runSecs = getPersistedSecs(t.guid);
            if (active && active.task_guid === t.guid) {
                runSecs = (active.accumulated || 0);
                if (!active.paused && active.started_at) {
                    runSecs += Math.floor((Date.now() - Number(active.started_at)) / 1000);
                }
            }
            const color = isPaused ? '#f39c12' : '#d63031';
            const timeText = (isRunning || isPaused || runSecs > 0) ? `<span class="running" style="color:${color}; font-weight:600;">${fmt(runSecs)}</span>` : '-';
            const toggleIcon = isRunning ? 'fa-pause' : 'fa-play';
            const toggleTitle = isRunning ? 'Pause' : (isPaused ? 'Resume' : 'Start');
            const canNavigate = !!t.project_id;
            
            // Determine if button should be enabled
            const shouldEnable = checkedIn || isRunning || isPaused;
            const disabledAttr = shouldEnable ? '' : 'disabled';
            const disabledClass = shouldEnable ? '' : 'disabled';
            const buttonTitle = shouldEnable ? toggleTitle : 'Please check in first to start task timer';
            const taskIdNormalized = String(t.task_id || '').trim().toUpperCase();
            const taskTypeNormalized = String(t.task_type || t.type || '').trim().toLowerCase();
            const isBugTask = taskTypeNormalized === 'bug' || taskIdNormalized.startsWith('BUG');
            const workItemIcon = isBugTask
                ? '<i class="fa-solid fa-bug" title="Bug" style="color:#dc2626;"></i>'
                : '<i class="fa-regular fa-calendar"></i>';

            const taskLabel = `
              <div style="display:flex; align-items:center; gap:10px;">
                ${workItemIcon}
                <div>
                  ${canNavigate
                    ? `<button type="button"
                               class="task-link"
                               data-project="${encodeURIComponent(t.project_id)}"
                               ${t.board_id ? `data-board="${encodeURIComponent(t.board_id)}"` : ''}
                               title="Open project page">
                          ${t.task_name || ''}
                       </button>`
                    : `<div style="font-weight:600;">${t.task_name || ''}</div>`}
                  <div style="color:#64748b; font-size:12px;">${t.task_id || ''}</div>
                </div>
              </div>`;
            return `
            <tr data-guid="${t.guid}" ${canNavigate ? `data-project="${encodeURIComponent(t.project_id)}" ${t.board_id ? `data-board="${encodeURIComponent(t.board_id)}"` : ''} class="task-row-clickable"` : ''}>
              <td class="actions-cell" style="width:50px; text-align:left;">
                <button class="action-btn toggle-timer ${disabledClass}" title="${buttonTitle}" ${disabledAttr}><i class="fa-solid ${toggleIcon}"></i></button>
              </td>

              <td>${taskLabel}</td>
              <td>${projectName}</td>
              <td>${clientName}</td>
              <td><span class="status-badge ${String(t.task_status || '').toLowerCase()}">${t.task_status || ''}</span></td>
              <td>
                ${t.due_date || '-'}
                ${(() => {
                  if (!t.due_date) return '';
                  const now = new Date();
                  const taskStatus = (t.task_status || '').toLowerCase();
                  if (['completed', 'cancelled', 'canceled'].includes(taskStatus)) return '';
                  
                  let isOverdue = false;
                  if (t.due_time) {
                    // Check date + time
                    const dueDatetime = new Date(`${t.due_date}T${t.due_time}`);
                    isOverdue = dueDatetime < now;
                  } else {
                    // Check date only
                    const today = new Date();
                    today.setHours(0, 0, 0, 0);
                    const dueDate = new Date(t.due_date);
                    dueDate.setHours(0, 0, 0, 0);
                    isOverdue = dueDate < today;
                  }
                  
                  return isOverdue ? '<span class="overdue-badge" style="margin-left:8px; padding:2px 8px; background:#ff4757; color:white; border-radius:4px; font-size:11px; font-weight:600;">OVERDUE</span>' : '';
                })()}
              </td>
              <td>
                ${t.due_time ? `<span style="color:#4338ca; font-weight:500;"><i class="fa-solid fa-clock" style="font-size:10px; margin-right:4px;"></i>${t.due_time}</span>` : '-'}
              </td>
              <td>${t.task_priority || '-'}</td>

              <td class="tt-time" style="color:#d63031; font-weight:600;">${timeText}</td>
            </tr>`;
        }).join('');

        const controls = `
            <div class="mt-controls">
            <input id="mt-search" placeholder="Search tasks" />
            <button id="mt-refresh" class="icon-btn"><i class="fa-solid fa-rotate"></i></button>
            <button class="icon-btn"><i class="fa-solid fa-chevron-left"></i></button>
            <button class="icon-btn"><i class="fa-solid fa-chevron-right"></i></button>
            </div>
            `;


        const content = `
                        <div class="mytasks-card">
                        <div class="mytasks-header">
                            <div></div>
                            ${controls}
                        </div>

                        <div class="table-container">
                            <table class="table">
                            <thead>
                                <tr>
                                <th style="width:50px;">Run</th>
                                <th>Work item id & name</th>
                                <th>Project</th>
                                <th>Client</th>
                                <th>Status</th>
                                <th>Due date</th>
                                <th>Due Time</th>
                                <th>Priority</th>
                                <th>Time spent</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${rows ||
            `<tr><td colspan="8" class="placeholder-text">No tasks</td></tr>`
            }
                            </tbody>
                            </table>
                        </div>
                        </div>
                        `;


        
        // Add overdue badge styles
        const style = document.createElement('style');
        style.textContent = `
            .overdue-badge {
                animation: pulse-red 2s infinite;
            }
            @keyframes pulse-red {
                0%, 100% { opacity: 1; }
                50% { opacity: 0.7; }
            }
            .status-badge.overdue {
                background-color: #ff4757 !important;
                color: white !important;
            }
        `;
        document.head.appendChild(style);
        
        document.getElementById('app-content').innerHTML = getPageContentHTML('My Tasks', content);

        // events
        const searchEl = document.getElementById('mt-search');
        if (searchEl) {
            searchEl.value = search;
            searchEl.addEventListener('input', (e) => { search = e.target.value || ''; render(); });
        }
        const refreshBtn = document.getElementById('mt-refresh');
        refreshBtn && refreshBtn.addEventListener('click', () => render());

        document.querySelectorAll('tr[data-guid] .action-btn.toggle-timer').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const tr = e.currentTarget.closest('tr');
                const guid = tr?.getAttribute('data-guid');
                const t = tasks.find(x => x.guid === guid);
                if (!t) return;
                
                // Double-check at click time as backup validation
                const active = getActive();
                const isRunning = active && active.task_guid === t.guid && !active.paused;
                const isPaused = active && active.task_guid === t.guid && active.paused;
                
                // Allow pause/resume if already running, but require check-in to start new timer
                if (!isCheckedIn() && !isRunning && !isPaused) {
                    alert('⚠️ Please check in first before starting a task timer.');
                    return;
                }
                
                // Always toggle (start/pause/resume) - never save or navigate
                toggleTimer(t);
            });
        });
        
        // Update button states initially
        updatePlayButtonStates();
        
        // Set up a periodic check to update button states when check-in status changes
        // This handles the case where user checks in/out while on My Tasks page
        if (checkInStateInterval) clearInterval(checkInStateInterval);
        checkInStateInterval = setInterval(() => {
            updatePlayButtonStates();
        }, 1000);

        document.querySelectorAll('.task-link').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const projectId = e.currentTarget.getAttribute('data-project');
                const boardId = e.currentTarget.getAttribute('data-board');
                if (!projectId) return;
                const boardPart = boardId ? `&tab=crm&board=${boardId}` : '';
                const tabPart = boardId ? '' : '&tab=crm';
                window.location.hash = `#/time-projects?id=${projectId}${tabPart}${boardPart}`;
            });
        });

        document.querySelectorAll('tr.task-row-clickable').forEach(tr => {
            tr.style.cursor = 'pointer';
            tr.addEventListener('click', () => {
                const projectId = tr.getAttribute('data-project');
                const boardId = tr.getAttribute('data-board');
                if (!projectId) return;
                const boardPart = boardId ? `&tab=crm&board=${boardId}` : '';
                const tabPart = boardId ? '' : '&tab=crm';
                window.location.hash = `#/time-projects?id=${projectId}${tabPart}${boardPart}`;
            });
        });


        // Start timer interval if there's an active timer (running or paused)
        if (timerInterval) clearInterval(timerInterval);
        if (active && active.task_guid) {
            timerInterval = setInterval(updateTimers, 1000);
            updateTimers(); // Update immediately
        }
    };

    await render();
};

export const renderMyTimesheetPage = async () => {
    const API = `${apiBase}/api`;
    const user = state?.user || window.state?.user || {};
    let empId = String((user.id || user.employee_id || user.employeeId || '')).trim();
    let userNameLc = String((user.name || user.fullName || user.username || '')).trim().toLowerCase();
    if (!empId) {
        try { empId = await resolveCurrentEmployeeId(); } catch { }
        if (empId) { try { state.user = { ...(state.user || {}), id: empId }; } catch { } }
    }

    console.log('My Timesheet - User:', user);
    console.log('My Timesheet - Employee ID:', empId);

    // Week navigation helpers
    const startOfWeek = (d) => { const x = new Date(d); const day = x.getDay(); const diff = (day === 0 ? -6 : 1) - day; x.setDate(x.getDate() + diff); x.setHours(0, 0, 0, 0); return x; };
    const endOfWeek = (d) => { const x = startOfWeek(d); x.setDate(x.getDate() + 6); x.setHours(23, 59, 59, 999); return x; };
    const fmt = (dt) => {
        const d = (dt instanceof Date) ? dt : new Date(dt);
        if (Number.isNaN(d.getTime())) return '';
        const yyyy = d.getFullYear();
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        return `${yyyy}-${mm}-${dd}`;
    };

    // Initialize anchor from last log or current date
    let anchor = (() => {
        try {
            const last = JSON.parse(sessionStorage.getItem('tt_last_log') || 'null');
            if (last && last.work_date) return new Date(last.work_date);
        } catch { }
        return new Date();
    })();

    // Load projects and tasks for dropdowns (cached for speed)
    let projects = [];
    let tasks = [];
    let myActiveTasks = []; // Tasks from "My Tasks" page (active assignments)
    
    try {
        const cachedProj = sessionStorage.getItem('ts_projects_cache');
        if (cachedProj) { projects = JSON.parse(cachedProj); } 
    } catch { }
    try {
        const cachedTasks = sessionStorage.getItem('ts_tasks_cache');
        if (cachedTasks) { tasks = JSON.parse(cachedTasks); }
    } catch { }

    // Fetch in parallel if not cached
    if (!projects.length || !tasks.length) {
        const [projRes, taskRes] = await Promise.allSettled([
            fetch(`${API}/projects`).then(r => r.json()),
            fetch(`${API}/tasks`).then(r => r.json())
        ]);
        if (projRes.status === 'fulfilled' && projRes.value?.success) {
            projects = projRes.value.projects || [];
            try { sessionStorage.setItem('ts_projects_cache', JSON.stringify(projects)); } catch { }
        }
        if (taskRes.status === 'fulfilled' && taskRes.value?.success) {
            tasks = taskRes.value.tasks || [];
            try { sessionStorage.setItem('ts_tasks_cache', JSON.stringify(tasks)); } catch { }
        }
    }
    
    // Fetch active tasks from "My Tasks" API (these are the tasks user is currently working on)
    const fetchMyActiveTasks = async () => {
        try {
            const params = new URLSearchParams();
            if (empId) params.set('user_id', String(empId).trim());
            if (user.name) params.set('user_name', String(user.name).trim());
            if (user.email) params.set('user_email', String(user.email || '').trim());
            params.set('role', user.is_admin ? 'l3' : 'l1');
            
            const res = await fetch(`${API}/my-tasks?${params.toString()}`);
            const data = await res.json().catch(() => ({ success: false }));
            
            if (res.ok && data.success) {
                myActiveTasks = (data.tasks || []).filter(t => {
                    // Only include tasks with active statuses
                    const status = String(t.task_status || '').toLowerCase();
                    return status === 'in progress' || status === 'hold' || status === 'new' || status === 'open';
                });
                console.log('[TIMESHEET] Fetched active tasks from My Tasks:', myActiveTasks.length);
            }
        } catch (e) {
            console.warn('[TIMESHEET] Failed to fetch My Tasks:', e);
        }
    };
    
    await fetchMyActiveTasks();

    const refreshProjectTaskSources = async () => {
        const [projRes, taskRes] = await Promise.allSettled([
            fetch(`${API}/projects`, { cache: 'no-store' }).then(r => r.json()),
            fetch(`${API}/tasks`, { cache: 'no-store' }).then(r => r.json())
        ]);

        if (projRes.status === 'fulfilled' && projRes.value?.success && Array.isArray(projRes.value.projects)) {
            projects = projRes.value.projects;
            try { sessionStorage.setItem('ts_projects_cache', JSON.stringify(projects)); } catch { }
        }
        if (taskRes.status === 'fulfilled' && taskRes.value?.success && Array.isArray(taskRes.value.tasks)) {
            tasks = taskRes.value.tasks;
            try { sessionStorage.setItem('ts_tasks_cache', JSON.stringify(tasks)); } catch { }
        }

        return { projects, tasks };
    };

    // State for grid rows (derived from logs) and manual rows (user-added)
    let gridRows = [];
    let manualRows = [];
    let submissionStatusMsg = '';
    let submissionStatusTimer = null;
    let currentWeekSubmissionStatus = '';

    const parseLocalYmd = (value) => {
        const raw = String(value || '').trim().slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
        const [yyyy, mm, dd] = raw.split('-').map(Number);
        const d = new Date(yyyy, mm - 1, dd);
        return Number.isNaN(d.getTime()) ? null : d;
    };

    const getWeekSubmissionStatus = async (weekStartDate) => {
        if (!empId) return '';
        try {
            const params = new URLSearchParams({ employee_id: empId });
            const res = await fetch(`${API}/time-tracker/timesheet/submissions?${params.toString()}`, { cache: 'no-store' });
            const data = await res.json().catch(() => ({ success: false }));
            if (!res.ok || !data.success) return '';
            const targetWeekStart = fmt(weekStartDate);
            const statusPriority = { accepted: 3, pending: 2, rejected: 1 };
            let bestStatus = '';
            let bestPriority = 0;
            (data.items || []).forEach((item) => {
                const parsedDate = parseLocalYmd(item.date);
                if (!parsedDate) return;
                const itemWeekStart = fmt(startOfWeek(parsedDate));
                if (itemWeekStart !== targetWeekStart) return;
                const status = String(item.status || '').trim().toLowerCase();
                const priority = statusPriority[status] || 0;
                if (priority > bestPriority) {
                    bestPriority = priority;
                    bestStatus = status;
                }
            });
            return bestStatus;
        } catch (err) {
            console.warn('Failed to fetch timesheet submission status', err);
            return '';
        }
    };

    // Skeleton shell while logs and configuration are loading
    try {
        const skeleton = `
            <div class="card" style="padding: 0;">
                <div style="padding: 16px 20px; border-bottom: 1px solid #e5e7eb;">
                    <div class="skeleton skeleton-heading-md" style="width: 180px;"></div>
                    <div class="skeleton skeleton-text" style="margin-top: 0.4rem; width: 260px;"></div>
                </div>
                <div style="padding: 14px 20px; border-bottom: 1px solid #e5e7eb; display:flex; gap:24px;">
                    <div class="skeleton skeleton-text" style="width: 120px;"></div>
                    <div class="skeleton skeleton-text" style="width: 120px;"></div>
                </div>
                <div style="padding: 16px 20px;">
                    <div class="skeleton skeleton-chart-line"></div>
                </div>
            </div>
        `;
        const app = document.getElementById('app-content');
        if (app) app.innerHTML = getPageContentHTML('', skeleton);
    } catch { }

    const load = async (s, e) => {
        const url = `${API}/time-tracker/logs?employee_id=${encodeURIComponent(empId)}&start_date=${fmt(s)}&end_date=${fmt(e)}`;
        console.log('Fetching logs from:', url);
        const res = await fetch(url);
        console.log('Fetch response status:', res.status);
        const data = await res.json().catch(() => ({ success: false }));
        console.log('Fetch response data:', data);
        return (res.ok && data.success) ? (data.logs || []) : [];
    };

    const GLOBAL_MANUAL_LOG_KEY = 'tt_manual_logs_v1';

    const parseToSeconds = (val) => {
        const s = String(val || '').trim();
        if (!s) return 0;
        const parts = s.split(':').map(x => parseInt(x, 10));
        if (parts.some(isNaN)) return 0;
        let h = 0, m = 0, sec = 0;
        if (parts.length === 3) { [h, m, sec] = parts; }
        else if (parts.length === 2) { [h, m] = parts; }
        else { h = parts[0]; }
        if (m >= 60 || sec >= 60) return 0;
        return (h * 3600) + (m * 60) + (sec || 0);
    };

    const formatSeconds = (secs) => {
        if (secs === null || secs === undefined) return '';
        const h = Math.floor(secs / 3600);
        const m = Math.floor((secs % 3600) / 60);
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    };

    const taskIdByGuid = new Map();

    const seedTaskIdentityMap = (rows = []) => {
        (rows || []).forEach((row) => {
            const guid = String(row?.task_guid || row?.taskGuid || '').trim();
            const taskId = String(row?.task_id || row?.taskId || '').trim();
            if (guid && taskId) {
                taskIdByGuid.set(guid.toUpperCase(), taskId);
            }
        });
    };

    const taskIdentityFor = (row) => {
        const guid = String(row?.task_guid || row?.taskGuid || '').trim();
        const taskId = String(row?.task_id || row?.taskId || '').trim();
        if (guid && taskId) {
            taskIdByGuid.set(guid.toUpperCase(), taskId);
        }
        const mappedTaskId = guid ? (taskIdByGuid.get(guid.toUpperCase()) || '') : '';
        return String(
            taskId ||
            mappedTaskId ||
            guid ||
            ''
        ).trim();
    };

    const rowKeyFor = (row) => `${row?.project_id || row?.projectId || ''}|${taskIdentityFor(row)}`;

    const render = async () => {
        const s = startOfWeek(anchor);
        const e = endOfWeek(anchor);
        const initialHash = window.location.hash;
        let logs = await load(s, e);
        // If the user has navigated away while logs were loading, abort rendering
        if (initialHash !== '#/time-my-timesheet' || window.location.hash !== '#/time-my-timesheet') {
            return;
        }

        // Filter out future dates (use local date, not UTC)
        const today = new Date();
        const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
        console.log('My Timesheet - Today (local):', todayStr);
        logs = logs.filter(log => {
            const logDate = (log.work_date || '').slice(0, 10);
            return logDate <= todayStr;
        });

        currentWeekSubmissionStatus = await getWeekSubmissionStatus(s);
        const isWeekPending = currentWeekSubmissionStatus === 'pending';
        const isWeekAccepted = currentWeekSubmissionStatus === 'accepted';
        const isSubmitLocked = isWeekPending || isWeekAccepted;

        taskIdByGuid.clear();
        seedTaskIdentityMap(tasks);
        seedTaskIdentityMap(logs);

        // manual rows: load from sessionStorage per week range
        const weekKey = `ts_manual_${fmt(s)}_${fmt(e)}`;
        try { manualRows = JSON.parse(sessionStorage.getItem(weekKey) || '[]'); } catch { manualRows = []; }
        if (!Array.isArray(manualRows)) manualRows = [];
        manualRows = manualRows.map(r => ({
            ...r,
            project_name: r.project_name || r.projectId || '',
            task_name: r.task_name || r.taskName || r.task_id || 'Manual Task'
        }));

        // manual overrides map (per week)
        const overridesKey = `${weekKey}_overrides`;
        let overrides = {};
        try { overrides = JSON.parse(sessionStorage.getItem(overridesKey) || '{}'); } catch { overrides = {}; }

        const hiddenRowsKey = `${weekKey}_hidden_rows`;
        let hiddenRowKeys = [];
        try { hiddenRowKeys = JSON.parse(sessionStorage.getItem(hiddenRowsKey) || '[]'); } catch { hiddenRowKeys = []; }
        const hiddenRowSet = new Set((hiddenRowKeys || []).map(String));

        const loadOverrides = () => {
            try { return JSON.parse(sessionStorage.getItem(overridesKey) || '{}'); } catch { return {}; }
        };

        const saveOverrides = (map) => {
            try { sessionStorage.setItem(overridesKey, JSON.stringify(map)); } catch { }
        };

        const showTimesheetSubmissionSummary = (entriesList = []) => {
            if (!Array.isArray(entriesList) || !entriesList.length) return;
            const totalSeconds = entriesList.reduce((sum, entry) => sum + Number(entry.seconds || 0), 0);
            const totalHours = (totalSeconds / 3600).toFixed(2);
            const rowsHtml = entriesList.map(entry => {
                const hours = (Number(entry.seconds || 0) / 3600).toFixed(2);
                return `
                    <tr>
                        <td>${entry.date || '-'}</td>
                        <td>${entry.project_name || entry.project_id || '-'}</td>
                        <td>${entry.task_name || entry.task_id || '-'}</td>
                        <td style="text-align:right; font-weight:600;">${hours}</td>
                    </tr>
                `;
            }).join('');

            const body = `
                <div style="padding: 8px 0;">
                    <p style="margin-bottom: 12px; color:#475569;">
                        Your timesheet has been submitted and is pending admin approval. Track the status in <strong>Inbox → Timesheet</strong>.
                    </p>
                    <div style="max-height: 320px; overflow:auto; border:1px solid #e2e8f0; border-radius:12px;">
                        <table style="width:100%; border-collapse:collapse; font-size:13px;">
                            <thead style="background:#f8fafc;">
                                <tr>
                                    <th style="text-align:left; padding:10px;">Date</th>
                                    <th style="text-align:left; padding:10px;">Project</th>
                                    <th style="text-align:left; padding:10px;">Task</th>
                                    <th style="text-align:right; padding:10px;">Hours</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${rowsHtml}
                            </tbody>
                            <tfoot>
                                <tr style="background:#f1f5f9;">
                                    <td colspan="3" style="padding:10px; font-weight:700;">Total hours</td>
                                    <td style="padding:10px; text-align:right; font-weight:700;">${totalHours}</td>
                                </tr>
                            </tfoot>
                        </table>
                    </div>
                </div>
            `;

            renderModal('Timesheet submitted', body, [
                { id: 'ts-summary-close-btn', text: 'Close', className: 'btn btn-secondary', type: 'button' },
                { id: 'ts-summary-inbox-btn', text: 'View Inbox', className: 'btn btn-primary', type: 'button' },
            ]);

            setTimeout(() => {
                document.getElementById('ts-summary-close-btn')?.addEventListener('click', () => closeModal());
                document.getElementById('ts-summary-inbox-btn')?.addEventListener('click', () => {
                    closeModal();
                    currentInboxCategory = 'timesheet';
                    currentInboxTab = 'requests';
                    window.location.hash = '#/inbox';
                });
            }, 30);
        };

        // Build days array for column headers
        const days = Array.from({ length: 7 }, (_, i) => {
            const d = new Date(s);
            d.setDate(s.getDate() + i);
            return d;
        });

        console.log('My Timesheet - Week:', fmt(s), 'to', fmt(e));
        console.log('My Timesheet - Today:', todayStr);
        console.log('My Timesheet - Loaded logs (after filtering):', logs);
        console.log('My Timesheet - Days in week:', days.map(d => d.toISOString().slice(0, 10)));

        const taskMetaByIdentity = new Map();
        (tasks || []).forEach(t => {
            const projectId = String(t?.project_id || t?.projectId || t?.project || '').trim();
            const taskGuid = String(t?.guid || t?.task_guid || '').trim();
            const taskId = String(t?.task_id || t?.taskId || '').trim();
            const taskName = String(t?.task_name || t?.taskName || '').trim();
            const boardId = String(t?.board_id || t?.boardId || '').trim();
            if (!projectId) return;
            if (taskGuid) taskMetaByIdentity.set(`${projectId}|${taskGuid}`, { board_id: boardId, task_id: taskId, task_name: taskName });
            if (taskId) taskMetaByIdentity.set(`${projectId}|${taskId}`, { board_id: boardId, task_id: taskId, task_name: taskName });
        });

        // Group logs by project/task
        const grouped = {};
        logs.forEach(l => {
            const taskIdentity = taskIdentityFor(l);
            const key = `${l.project_id || ''}|${taskIdentity}`;
            const taskGuidKey = `${l.project_id || ''}|${String(l.task_guid || '').trim()}`;
            const taskIdKey = `${l.project_id || ''}|${String(l.task_id || '').trim()}`;
            const matchedMeta = taskMetaByIdentity.get(taskGuidKey) || taskMetaByIdentity.get(taskIdKey) || taskMetaByIdentity.get(key) || {};

            if (!grouped[key]) {
                grouped[key] = {
                    project_id: l.project_id,
                    task_guid: l.task_guid || '',
                    task_id: l.task_id || matchedMeta.task_id || '',
                    task_name: l.task_name || matchedMeta.task_name || '',
                    board_id: matchedMeta.board_id || '',
                    billing: 'Non-billable',
                    hours: Array(7).fill(0),
                    manualFlags: Array(7).fill(false),
                    dayLogIds: Array(7).fill(''),

                    _logRefs: []
                };
            }

            if (!grouped[key].board_id && matchedMeta.board_id) {
                grouped[key].board_id = matchedMeta.board_id;
            }
            if (!grouped[key].task_name && (l.task_name || matchedMeta.task_name)) {
                grouped[key].task_name = l.task_name || matchedMeta.task_name;
            }
            if (!grouped[key].task_id && (l.task_id || matchedMeta.task_id)) {
                grouped[key].task_id = l.task_id || matchedMeta.task_id;
            }
            if (l.id) grouped[key]._logRefs.push(String(l.id));

            const logDate = (l.work_date || '').slice(0, 10);
            if (logDate <= todayStr) {
                for (let i = 0; i < 7; i++) {
                    const dayDate = new Date(s);
                    dayDate.setDate(s.getDate() + i);
                    const dayDateStr = `${dayDate.getFullYear()}-${String(dayDate.getMonth() + 1).padStart(2, '0')}-${String(dayDate.getDate()).padStart(2, '0')}`;
                    if (logDate === dayDateStr) {
                        const seconds = Number(l.seconds || 0);
                        const existingSecs = grouped[key].hours[i] || 0;
                        grouped[key].hours[i] = existingSecs + seconds;
                        if (l.id && !grouped[key].dayLogIds[i]) grouped[key].dayLogIds[i] = String(l.id);
                        if (l.manual) grouped[key].manualFlags[i] = true;
                        break;
                    }
                }
            }
        });

        const allGroupedRows = Object.values(grouped);
        gridRows = allGroupedRows.filter(row => {
            const hasLoggedTime = (row.hours || []).some(h => Number(h) > 0);
            return hasLoggedTime;
        });

        console.log('[TIMESHEET] Filtered grid rows:', gridRows.length, 'from', allGroupedRows.length, 'total');

        // Append any manual rows that don't already exist by key
        if (Array.isArray(manualRows) && manualRows.length) {
            const existingKeys = new Set((gridRows || []).map(r => rowKeyFor(r)));
            const toAppend = manualRows.filter(r => {
                const key = rowKeyFor(r);
                if (hiddenRowSet.has(key)) return false;
                return !existingKeys.has(key);
            });

            gridRows = gridRows.concat(toAppend);
        }
        console.log('My Timesheet - Grid rows:', gridRows);

        if (gridRows.length === 0) {
            // Show a single placeholder manual row if nothing exists
            manualRows = [{ id: Date.now(), _manual: true, project_id: '', project_name: 'Manual row', task_guid: '', task_id: '', task_name: 'Manual task', billing: 'Non-billable', hours: Array(7).fill(0) }];
            gridRows = manualRows.slice();
            try { sessionStorage.setItem(weekKey, JSON.stringify(manualRows)); } catch { }
        }

        // Calculate totals in seconds (exclude future days)
        const computeDisplayTotal = () => {
            let total = 0;
            gridRows.forEach(r => {
                const key = rowKeyFor(r);
                const ov = (overrides || {})[key] || [];
                for (let i = 0; i < 7; i++) {
                    const d = new Date(s); d.setDate(s.getDate() + i);
                    const dStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
                    if (dStr > todayStr) continue; // skip future days
                    const sec = Number(ov[i] ?? r.hours[i] ?? 0);
                    total += sec;
                }
            });
            return total;
        };
        const totalLoggedSecs = computeDisplayTotal();
        const totalBillableSecs = 0; // Calculate based on billing type if needed

        // Format helper for display
        const formatTimeDisplay = (secs) => {
            const h = Math.floor(secs / 3600);
            const m = Math.floor((secs % 3600) / 60);
            return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
        };

        const weekOfMonth = Math.floor((s.getDate() - 1) / 7) + 1;
        const weekLabel = `${s.getDate()} ${s.toLocaleDateString('en-US', { month: 'long' })} ${s.getFullYear()} - ${e.getDate()} ${e.toLocaleDateString('en-US', { month: 'long' })} ${e.getFullYear()} (Week ${weekOfMonth})`;

        // Helper to format seconds as HH:MM
        const formatTime = (secs) => {
            if (!secs) return '';
            const h = Math.floor(secs / 3600);
            const m = Math.floor((secs % 3600) / 60);
            return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
        };

        // Build grid rows HTML
        const rowsHtml = gridRows.map((row, idx) => {
            const key = rowKeyFor(row);
            const ov = (overrides || {})[key] || [];
            const dayInputs = row.hours.map((h, dayIdx) => {
                const dayDate = new Date(s);
                dayDate.setDate(s.getDate() + dayIdx);
                const dayDateStr = `${dayDate.getFullYear()}-${String(dayDate.getMonth() + 1).padStart(2, '0')}-${String(dayDate.getDate()).padStart(2, '0')}`;
                // Use local date for today comparison (todayStr defined above)
                const isToday = dayDateStr === todayStr;
                const isSunday = dayDate.getDay() === 0;
                const classes = ['day-col', isToday ? 'ts-cell-today' : '', isSunday ? 'day-off' : ''].filter(Boolean).join(' ');
                const isFuture = dayDateStr > todayStr;
                const secRaw = Number(ov[dayIdx] ?? h ?? 0);
                const sec = isFuture ? 0 : secRaw; // hide any future-dated values
                const isManual = (row.manualFlags && row.manualFlags[dayIdx]) || (ov[dayIdx] !== undefined && ov[dayIdx] !== null);
                const displayVal = sec ? formatTime(sec) : '';

                const placeholderVal = isSunday ? 'Day off' : '00:00';
                const icon = isFuture ? '' : (isManual ? `<i class="fa-solid fa-users" style="font-size:11px; color:#60a5fa; margin-left:4px;" title="Manually edited by admin"></i>` : (sec > 0 ? `<i class="fa-regular fa-clock" style="font-size:11px; color:#10b981; margin-left:4px;" title="Automatic capture (play/stop)"></i>` : ''));
                return `
                    <td class="${classes}">
                        <div style="display:flex; align-items:center; justify-content:center; gap:2px;">
                            <input type="text" 
                                   class="ts-hour-input ${isManual ? 'manual' : ''}" 
                                   data-row="${idx}" 
                                   data-day="${dayIdx}" 
                                   data-key="${key}"
                                   value="${displayVal}" 
                                   placeholder="${placeholderVal}" 
                                   ${(isSunday || isFuture) ? 'disabled' : ''} 
                                   readonly />
                            ${icon}
                        </div>
                    </td>`;
            }).join('');

            const totalSecs = row.hours.reduce((sum, h, i) => {
                const d = new Date(s); d.setDate(s.getDate() + i);
                const dStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
                if (dStr > todayStr) return sum; // exclude future
                return sum + Number((ov[i] ?? h) || 0);
            }, 0);
            const rowTotal = formatTime(totalSecs);

            // Find project name
            const project = projects.find(p => (p.crc6f_projectid || p.id) === row.project_id);
            const projectName = project ? (project.crc6f_projectname || project.name || row.project_id) : (row.project_name || row.project_id || 'Manual row');

            // Task column: show task id + task name where available
            const taskId = String(row.task_id || '').trim();
            const taskName = String(row.task_name || '').trim();
            const taskDisplay = (taskId && taskName)
                ? `${taskId} - ${taskName}`
                : (taskId || taskName || 'Manual Task');

            const rowProjectId = row.project_id || row.projectId || row.project;
            const rowBoardId = row.board_id || row.boardId || '';
            return `
                <tr data-row-id="${row.id || idx}" ${row._manual ? 'data-manual="1"' : ''} ${rowProjectId ? `data-project="${encodeURIComponent(rowProjectId)}" ${rowBoardId ? `data-board="${encodeURIComponent(rowBoardId)}"` : ''} class="ts-row-clickable"` : ''}>
                    <td>
                        <div style="padding: 8px; font-weight: 500; color: #334155 !important;">${projectName}</div>
                    </td>
                    <td>
                        <div style="padding: 8px; color: #334155 !important;">${taskDisplay}</div>
                    </td>
                    <td>
                        <select class="ts-select ts-billing" data-row="${idx}">
                            <option value="Non-billable" ${row.billing === 'Non-billable' ? 'selected' : ''}>Non-billable</option>
                            <option value="Billable" ${row.billing === 'Billable' ? 'selected' : ''}>Billable</option>
                        </select>
                    </td>
                    ${dayInputs}
                    <td class="ts-total">${rowTotal}</td>
                    <td class="ts-actions">
                        ${rowKeyFor(row) !== '|' ? `<button class="icon-btn ts-delete-row" data-row="${idx}" title="Delete row"><i class="fa-regular fa-trash-can"></i></button>` : ''}
                    </td>
                </tr>`;
        }).join('');

        const statusBanner = submissionStatusMsg ? `
            <div class="ts-status-banner success">
                <i class="fa-solid fa-circle-check"></i>
                <span>${submissionStatusMsg}</span>
            </div>
        ` : '';

        const content = `
        <style>
            :root { --ts-blue: #1e88e5; --ts-blue-light:#e3f2fd; --ts-gray:#f3f4f6; }
            .ts-header { background: var(--ts-blue); color:#fff; padding:16px 20px; border-radius:12px 12px 0 0; box-shadow:0 2px 6px rgba(0,0,0,0.08); display:flex; align-items:center; justify-content:space-between; gap:16px; flex-wrap:wrap; }
            .ts-header h2 { margin:0; font-size: 18px; font-weight:700; opacity:.95; }
            .ts-week-nav { display: flex; gap: 12px; align-items: center; justify-content: center; }
            .ts-week-nav button { background: rgba(255,255,255,0.2); border: none; color: #fff; padding: 8px 12px; border-radius: 999px; cursor: pointer; box-shadow: inset 0 0 0 1px rgba(255,255,255,0.25); }
            .ts-week-nav button:hover { background: rgba(255,255,255,0.3); }
            .ts-summary { padding: 12px 20px; background: var(--surface-alt, #f8f9fb); display: flex; gap: 32px; font-size: 14px; color: var(--text-secondary, #666); border-bottom:1px solid var(--border-color, #eef2f7); }
            .ts-summary strong { color: var(--text-primary, #333); }
            .ts-status-banner { margin: 0 20px 12px; padding: 10px 16px; border-radius: 12px; font-size: 14px; font-weight: 600; display:flex; align-items:center; gap:10px; }
            .ts-status-banner.success { background:#ecfdf3; color:#166534; border:1px solid #bbf7d0; }
            .ts-table-wrapper { overflow-x: auto; }
            .ts-table { width: 100%; border-collapse: separate; border-spacing:0; background:#fff; border-radius: 0 0 12px 12px; box-shadow: 0 2px 10px rgba(0,0,0,0.04); }
            .ts-table th { background: var(--surface-alt, #fafbfd); padding: 12px 8px; text-align: center; font-size: 12px; text-transform: uppercase; color: var(--text-secondary, #666); border-bottom: 2px solid var(--border-color, #e8edf3); }
            .ts-table th:first-child { text-align: left; min-width: 200px; }
            .ts-table th:nth-child(2) { text-align: left; min-width: 180px; }
            .ts-table th:nth-child(3) { text-align: left; min-width: 140px; }
            .ts-table td { padding: 10px; border-bottom: 1px solid var(--border-color, #f1f5f9); text-align: center; color: #475569; }
            .ts-table tr:last-child td { border-bottom: none; }
            .ts-table td:first-child, .ts-table td:nth-child(2), .ts-table td:nth-child(3) { text-align: left; }
            .ts-table td div { color: #334155 !important; font-weight: 500; }
            .ts-select {
                width: 100%;
                padding: 8px 10px;
                border: 1px solid #d7dce4;
                border-radius: 10px;
                font-size: 13px;
                background: #ffffff;
                color: #1f2937;
                box-shadow: 0 1px 2px rgba(15,23,42,0.04);
                transition: border-color 0.15s ease, box-shadow 0.15s ease;
            }
            .ts-select:focus-visible {
                outline: none;
                border-color: #818cf8;
                box-shadow: 0 0 0 2px rgba(129,140,248,0.25);
            }
            .ts-hour-input {
                width: 80px;
                padding: 8px 10px;
                border: 1px solid #d7dce4;
                border-radius: 10px;
                text-align: center;
                font-size: 13px;
                background: #ffffff;
                color: #0f172a;
                box-shadow: inset 0 -2px 0 rgba(148,163,184,0.15);
                transition: border-color 0.15s ease, box-shadow 0.15s ease;
            }
            .ts-hour-input:focus-visible {
                outline: none;
                border-color: #818cf8;
                box-shadow: 0 0 0 2px rgba(129,140,248,0.25);
            }
            .ts-hour-input::placeholder { color: #94a3b8; }
            .ts-hour-input.manual {
                border-color:#818cf8;
                background:#eef2ff;
                color: #1e1b4b;
                box-shadow: inset 0 -2px 0 rgba(99,102,241,0.2);
            }
            .day-col:nth-child(odd) { background: transparent; }
            .ts-cell-today { background: #eef2ff !important; }
            .day-off { background: transparent !important; }
            .day-off .ts-hour-input {
                background: #f1f5f9;
                border-color: #e2e8f0;
                color: #94a3b8;
                box-shadow: none;
            }
            .ts-total { font-weight: 700; color: #0f172a; }
            .ts-actions { text-align: center; }
            .ts-actions .icon-btn { width:36px; height:36px; border-radius:50%; display:inline-flex; align-items:center; justify-content:center; background:#f8fafc; border:1px solid #e2e8f0; }
            .ts-footer { padding: 16px 20px; display: flex; justify-content: space-between; align-items: center; border-top: 1px solid #e5e7eb; }
            .ts-add-btn { background: #fff; border: 1px solid var(--ts-blue); color: var(--ts-blue); padding: 10px 16px; border-radius: 999px; cursor: pointer; display: flex; align-items: center; gap: 8px; box-shadow: 0 2px 6px rgba(0,0,0,0.06); }
            .ts-add-btn:hover { background: var(--ts-blue); color: #fff; }
            .ts-action-btns { display: flex; gap: 12px; justify-content:flex-end; }
            .ts-action-btns .btn { border-radius:10px; box-shadow: inset 0 0 0 1px rgba(255,255,255,0.25); }
        </style>
        <div class="card" style="padding: 0; border-radius: 10px;">
            <div class="ts-header">
                <div></div>
                <div class="ts-week-nav">
                    <button id="ts-prev-week"><i class="fa-solid fa-chevron-left"></i></button>
                    <span id="ts-week-label" style="font-weight: 500; min-width: 280px; text-align: center;">${weekLabel}</span>
                    <button id="ts-next-week"><i class="fa-solid fa-chevron-right"></i></button>
                </div>
                <div class="ts-action-btns">
                    <button id="ts-submit" class="btn" style="background: #fff; color: var(--primary-color); border: none; padding: 8px 20px;">SUBMIT</button>
                </div>
            </div>
            ${statusBanner}
            <div class="ts-summary">
                <div>Total logged: <strong>${formatTimeDisplay(totalLoggedSecs)}</strong></div>
                <div>Total billable: <strong>${formatTimeDisplay(totalBillableSecs)}</strong></div>
            </div>
            <div class="ts-table-wrapper">
                <table class="ts-table">
                    <thead>
                        <tr>
                            <th>Project</th>
                            <th>Task</th>
                            <th>Billing</th>
                            ${days.map(d => `<th>${d.toLocaleDateString('en-US', { weekday: 'short' })}<br><span style="font-size: 11px; color: #999;">${d.toLocaleDateString('en-US', { month: 'short', day: '2-digit' })}</span></th>`).join('')}
                            <th>Total</th>
                            <th></th>
                        </tr>
                    </thead>
                    <tbody id="ts-tbody">
                        ${rowsHtml}
                    </tbody>
                </table>
            </div>
            <div class="ts-footer">
                <button id="ts-add-row" class="ts-add-btn">
                    <i class="fa-solid fa-plus"></i>
                    <span>Add row</span>
                </button>
            </div>
        </div>`;

        document.getElementById('app-content').innerHTML = getPageContentHTML('My Timesheet', content);

        // Event handlers
        document.getElementById('ts-prev-week').onclick = () => {
            anchor = new Date(s.getTime() - 7 * 86400000);
            render();
        };
        document.getElementById('ts-next-week').onclick = () => {
            anchor = new Date(s.getTime() + 7 * 86400000);
            render();
        };

        document.getElementById('ts-add-row').onclick = async () => {
            const addBtn = document.getElementById('ts-add-row');
            if (addBtn) {
                addBtn.disabled = true;
                addBtn.style.opacity = '0.7';
            }

            const latest = await refreshProjectTaskSources().catch(() => ({ projects, tasks }));
            const modalProjects = Array.isArray(latest?.projects) ? latest.projects : (projects || []);
            const modalTasks = Array.isArray(latest?.tasks) ? latest.tasks : (tasks || []);

            if (addBtn) {
                addBtn.disabled = false;
                addBtn.style.opacity = '';
            }

            const projOpts = ['<option value="">Select project</option>'].concat(modalProjects.map(p => `<option value="${p.crc6f_projectid || p.id}">${p.crc6f_projectname || p.name || p.crc6f_projectid || p.id}</option>`)).join('');
            const taskOpts = ['<option value="">Select task</option>'].concat(modalTasks.map(t => `<option value="${t.guid}">${t.task_name || t.task_id}</option>`)).join('');
            const body = `
              <div id="myts-add-row-form" class="leave-form timesheet-edit-form">
                <div class="form-section">
                  <div class="form-section-header">
                    <div>
                      <p class="form-eyebrow">Timesheet entry</p>
                      <h3>Add timesheet row</h3>
                    </div>
                    <p class="form-section-copy">Select project, task, and billing type for the new row.</p>
                  </div>
                  <div class="form-grid two-col">
                    <div class="form-field with-icon">
                      <label class="form-label" for="mr-project">Project</label>
                      <div class="input-wrapper">
                        <i class="fa-solid fa-folder-tree"></i>
                        <select class="input-control" id="mr-project">${projOpts}</select>
                      </div>
                    </div>
                    <div class="form-field with-icon">
                      <label class="form-label" for="mr-task">Task</label>
                      <div class="input-wrapper">
                        <i class="fa-solid fa-list-check"></i>
                        <select class="input-control" id="mr-task">${taskOpts}</select>
                      </div>
                    </div>
                    <div class="form-field with-icon">
                      <label class="form-label" for="mr-billing">Billing</label>
                      <div class="input-wrapper">
                        <i class="fa-solid fa-file-invoice-dollar"></i>
                        <select class="input-control" id="mr-billing">
                          <option value="Non-billable" selected>Non-billable</option>
                          <option value="Billable">Billable</option>
                        </select>
                      </div>
                    </div>
                  </div>
                </div>
              </div>`;
            renderModal('Add timesheet row', body, 'ts-manual-submit');
            setTimeout(() => {
                const form = document.getElementById('modal-form');
                if (!form) return;

                const projectSel = document.getElementById('mr-project');
                const taskSel = document.getElementById('mr-task');
                const normalizeProjectId = (val) => String(val || '').trim().toUpperCase();

                const rebuildTaskOptions = () => {
                    if (!taskSel) return;
                    const selectedProjectId = normalizeProjectId(projectSel?.value || '');
                    const currentTaskValue = String(taskSel.value || '').trim();
                    const filteredTasks = (modalTasks || []).filter((t) => {
                        if (!selectedProjectId) return true;
                        const taskProjectId = normalizeProjectId(t?.project_id || t?.crc6f_projectid || t?.projectId || '');
                        return taskProjectId === selectedProjectId;
                    });

                    taskSel.innerHTML = ['<option value="">Select task</option>']
                        .concat(filteredTasks.map(t => `<option value="${t.guid}">${t.task_name || t.task_id}</option>`))
                        .join('');

                    if (currentTaskValue && filteredTasks.some(t => String(t?.guid || '').trim() === currentTaskValue)) {
                        taskSel.value = currentTaskValue;
                    }
                };

                if (projectSel && taskSel) {
                    projectSel.addEventListener('change', rebuildTaskOptions);
                    rebuildTaskOptions();
                }

                form.addEventListener('submit', (ev) => {
                    ev.preventDefault();
                    const pid = document.getElementById('mr-project')?.value || '';
                    const tg = document.getElementById('mr-task')?.value || '';
                    const bill = document.getElementById('mr-billing')?.value || 'Non-billable';

                    const selProject = modalProjects.find(p => (p.crc6f_projectid || p.id) === pid) || {};
                    const projectName = selProject.crc6f_projectname || selProject.name || pid || 'Manual project';
                    const selTask = modalTasks.find(t => String(t.guid) === String(tg)) || {};
                    // Generate local GUID/task if not chosen from list
                    const genGuid = () => (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : `man-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
                    const guid = tg || genGuid();
                    const taskId = selTask.task_id || `MAN-${String(Date.now()).slice(-6)}`;
                    const taskName = selTask.task_name || selTask.name || taskId;
                    const isLocalOnlyTask = !tg;
                    const newRow = {
                        id: Date.now(), _manual: true,
                        project_id: pid,
                        project_name: projectName,
                        task_guid: guid,
                        task_id: taskId,
                        task_name: taskName,
                        billing: bill,
                        hours: Array(7).fill(0)
                    };
                    const newRowKey = rowKeyFor(newRow);
                    const duplicateExists = (gridRows || []).some(r => rowKeyFor(r) === newRowKey)
                        || (manualRows || []).some(r => rowKeyFor(r) === newRowKey);
                    if (duplicateExists) {
                        showToast('This task row already exists');
                        closeModal();
                        return;
                    }
                    manualRows.push(newRow);
                    try {
                        const key = rowKeyFor(newRow);

                        const next = new Set(hiddenRowSet);
                        next.delete(key);
                        sessionStorage.setItem(hiddenRowsKey, JSON.stringify(Array.from(next)));
                    } catch { }
                    try { sessionStorage.setItem(weekKey, JSON.stringify(manualRows)); } catch { }
                    // Persist a local task so it appears in My Tasks
                    try {
                        const key = 'tt_manual_tasks_v1';
                        const cur = JSON.parse(localStorage.getItem(key) || '[]');
                        const emp = String(empId || '').toUpperCase();
                        if (isLocalOnlyTask) {
                            const rec = { guid, task_id: taskId, task_name: taskName, project_id: pid, project_name: projectName, assigned_to: emp, task_status: 'New', task_priority: 'Normal', due_date: '', local_only: true };
                            if (!cur.find(t => String(t.guid) === String(guid))) cur.push(rec);
                        }
                        localStorage.setItem(key, JSON.stringify(cur));
                    } catch { }
                    closeModal();
                    render();
                });
            }, 30);
        };

        document.querySelectorAll('.ts-delete-row').forEach(btn => {
            btn.onclick = async (e) => {
                e.preventDefault();
                e.stopPropagation();
                const rowIdx = parseInt(e.currentTarget.getAttribute('data-row'));
                const row = gridRows[rowIdx];
                if (!row) return;
                if (confirm('Delete this row?')) {
                    const rowKey = rowKeyFor(row);
                    const nextHidden = new Set(hiddenRowSet);

                    // Important: deleting from My Timesheet should only remove time rows/logs,
                    // not delete the task itself from Projects/Kanban.

                    // Re-compute week dates to ensure they are valid for delete payload
                    const s = startOfWeek(anchor);
                    const e = endOfWeek(anchor);

                    // 1) Manual row cleanup
                    if (row._manual) {
                        manualRows = manualRows.filter(r => r.id !== row.id && rowKeyFor(r) !== rowKey);
                        try { sessionStorage.setItem(weekKey, JSON.stringify(manualRows)); } catch { }
                    }

                    // 2) Remove any override edits for this row key
                    try {
                        const ovMap = loadOverrides();
                        if (Object.prototype.hasOwnProperty.call(ovMap, rowKey)) {
                            delete ovMap[rowKey];
                            // Remove the entire key array if it's now empty
                            if (ovMap[rowKey].every(val => val === undefined || val === null)) {
                                delete ovMap[rowKey];
                            }
                            saveOverrides(ovMap);
                        }
                    } catch { }

                    // 3) Backend row deletion for persisted logs
                    const hasPersisted = (row._logRefs && row._logRefs.length) || (row.hours || []).some(v => Number(v || 0) > 0);
                    if (hasPersisted && (row.task_guid || row.task_id)) {
                        const startStr = fmt(s);
                        const endStr = fmt(e);
                        if (!startStr || !endStr) {
                            console.warn('[TS_DELETE] Invalid date range for row delete; skipping backend call', { startStr, endStr, row });
                        } else {
                            try {
                                const payload = {
                                    employee_id: String(empId || '').toUpperCase(),

                                    project_id: row.project_id || '',
                                    task_guid: row.task_guid || '',
                                    task_id: row.task_id || '',
                                    start_date: startStr,
                                    end_date: endStr,
                                };
                                const resp = await fetch(`${API}/time-tracker/logs/row`, {
                                    method: 'DELETE',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify(payload),
                                });
                                let data = {};
                                if (typeof resp?.json === 'function') {
                                    data = await resp.json().catch(() => ({}));
                                } else if (resp && typeof resp === 'object') {
                                    data = resp;
                                }
                                const rowDeleteOk = (typeof resp?.ok === 'boolean') ? resp.ok : !!data?.success;
                                if (!rowDeleteOk || data?.success === false) {
                                    console.warn('Timesheet row delete API did not confirm success', data);
                                }
                            } catch (err) {
                                console.error('Timesheet row delete failed', err);
                            }
                        }
                    }

                    // 4) Keep this row hidden for current week so auto-sync doesn't re-add it immediately
                    nextHidden.add(rowKey);
                    try { sessionStorage.setItem(hiddenRowsKey, JSON.stringify(Array.from(nextHidden))); } catch { }
                    render();
                }
            };
        });

        const submitBtn = document.getElementById('ts-submit');
        if (submitBtn) {
            if (isSubmitLocked) {
                submitBtn.disabled = true;
                submitBtn.textContent = isWeekAccepted ? 'APPROVED' : 'PENDING';
                submitBtn.title = isWeekAccepted ? 'This week has already been approved.' : 'This week is pending admin approval.';
                submitBtn.style.opacity = '0.65';
                submitBtn.style.cursor = 'not-allowed';
            } else if (currentWeekSubmissionStatus === 'rejected') {
                submitBtn.disabled = false;
                submitBtn.textContent = 'SUBMIT';
                submitBtn.title = 'This week was rejected. Update it and resubmit.';
            }
            submitBtn.onclick = async () => {
                const normalizedWeekStatus = String(currentWeekSubmissionStatus || '').toLowerCase();
                if (normalizedWeekStatus === 'pending') {
                    showToast('This week\'s timesheet is already pending approval.');
                    return;
                }
                if (normalizedWeekStatus === 'accepted') {
                    showToast('This week\'s timesheet has already been approved.');
                    return;
                }
                await runWithSubmissionLoading(async () => {
                    const s = startOfWeek(anchor);
                    const e = endOfWeek(anchor);
                    const weekKey = `ts_manual_${fmt(s)}_${fmt(e)}`;
                    const overridesKey = `${weekKey}_overrides`;
                    let overridesMap = {};
                    try { overridesMap = JSON.parse(sessionStorage.getItem(overridesKey) || '{}'); } catch { overridesMap = {}; }

                    const today = new Date();
                    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

                    const entries = [];
                    const ensureSeconds = (v) => {
                        if (v === null || v === undefined) return 0;
                        const n = Number(v);
                        return Number.isFinite(n) ? n : 0;
                    };

                    gridRows.forEach(row => {
                        const key = rowKeyFor(row);
                        const ov = overridesMap[key] || [];
                        for (let i = 0; i < 7; i++) {
                            const d = new Date(s); d.setDate(s.getDate() + i);
                            const yyyy = d.getFullYear();
                            const mm = String(d.getMonth() + 1).padStart(2, '0');
                            const dd = String(d.getDate()).padStart(2, '0');
                            const workDate = `${yyyy}-${mm}-${dd}`;
                            if (workDate > todayStr) continue;
                            const baseSecs = ensureSeconds(row.hours[i]);
                            const overrideSecs = (ov[i] === null || ov[i] === undefined) ? null : ensureSeconds(ov[i]);
                            const secs = overrideSecs !== null ? overrideSecs : baseSecs;
                            if (!secs) continue;

                            const project = projects.find(p => (p.crc6f_projectid || p.id) === row.project_id) || {};
                            const projectId = row.project_id || project.crc6f_projectid || project.id || '';
                            const projectName = project.crc6f_projectname || project.name || row.project_name || projectId;

                            entries.push({
                                date: workDate,
                                project_id: projectId,
                                project_name: projectName || '',
                                task_id: row.task_id || '',
                                task_guid: row.task_guid || '',
                                task_name: row.task_name || '',
                                seconds: secs,
                                hours_worked: Math.round((secs / 3600) * 100) / 100,
                                description: ''
                            });
                        }
                    });

                    if (!entries.length) {
                        showToast('No time entries to submit for this week.');
                        return;
                    }

                    const fullName = `${user.first_name || user.firstName || ''} ${user.last_name || user.lastName || ''}`.trim();
                    const employeeName = fullName || user.name || user.displayName || '';

                    const payload = {
                        employee_id: empId,
                        employee_name: employeeName,
                        entries
                    };

                    try {
                        const res = await fetch(`${API}/time-tracker/timesheet/submit`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(payload)
                        });
                        const data = await res.json().catch(() => ({}));
                        if (!res.ok || !data.success) {
                            showToast(`Failed to submit timesheet: ${data.error || res.status}`);
                            return;
                        }
                        currentWeekSubmissionStatus = 'pending';
                        try { sessionStorage.removeItem(weekKey); } catch { }
                        try { sessionStorage.removeItem(overridesKey); } catch { }
                        if (submissionStatusTimer) {
                            clearTimeout(submissionStatusTimer);
                            submissionStatusTimer = null;
                        }
                        submissionStatusMsg = 'Timesheet submitted.';
                        submissionStatusTimer = setTimeout(() => {
                            submissionStatusMsg = '';
                            if (window.location.hash === '#/time-my-timesheet') {
                                try { render(); } catch { }
                            }
                        }, 5000);

                        showTimesheetSubmissionSummary(entries);
                        try { await updateNotificationBadge(); } catch (e) { console.warn('Notification badge update failed', e); }
                        await render();
                    } catch (err) {
                        console.error('Timesheet submit failed', err);
                        showToast('Failed to submit timesheet. Please try again.');
                    }
                }, 'Submitting timesheet...');
            };
        }

        // Enable edit via modal on double-click; save to backend and refresh
        const parseHHMM = (v) => {
            const s = String(v || '').trim();
            if (!s) return 0;
            const m = s.match(/^([0-9]{1,2}):([0-5][0-9])$/);
            if (!m) return null;
            const h = parseInt(m[1], 10);
            const mm = parseInt(m[2], 10);
            return (h * 3600) + (mm * 60);
        };

        const resolveRole = () => {
            const u = state?.user || window.state?.user || {};
            const isAdmin = !!u.is_admin || String(u.id || '').toUpperCase() === 'EMP001';
            const roleStr = String(u.role || '').toLowerCase();
            const isManager = !!u.is_manager || roleStr === 'l2' || String(u.designation || '').toLowerCase().includes('manager');
            return isAdmin ? 'l3' : (isManager ? 'l2' : 'l2');
        };

        const saveCell = async (rowIdx, dayIdx, seconds) => {
            const row = gridRows[rowIdx];
            if (!row) return;
            const dayDate = new Date(startOfWeek(anchor));
            dayDate.setDate(startOfWeek(anchor).getDate() + dayIdx);
            const yyyy = dayDate.getFullYear();
            const mm = String(dayDate.getMonth() + 1).padStart(2, '0');
            const dd = String(dayDate.getDate()).padStart(2, '0');
            const workDate = `${yyyy}-${mm}-${dd}`;
            const today = new Date();
            const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
            if (workDate > todayStr) return;

            let resolvedEmpId = String(empId || '').toUpperCase();
            if (!resolvedEmpId) {
                try {
                    resolvedEmpId = String(await resolveCurrentEmployeeId() || '').toUpperCase();
                    if (resolvedEmpId) empId = resolvedEmpId;
                } catch { }
            }
            if (!resolvedEmpId) {
                showToast('Unable to resolve employee ID. Please refresh and try again.');
                return;
            }

            const dayLogId = String(row?.dayLogIds?.[dayIdx] || '').trim();

            const payload = {
                employee_id: resolvedEmpId,
                project_id: row.project_id || '',
                task_guid: row.task_guid || '',
                task_id: row.task_id || '',
                task_name: row.task_name || '',
                seconds: Number(seconds || 0),
                work_date: workDate,
                description: '',
                role: resolveRole(),
                editor_id: resolvedEmpId,
                dv_id: dayLogId,
                manual: true,
            };

            try {
                const res = await fetch(`${API}/time-tracker/logs/exact`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok || !data.success) {
                    showToast(data.error || 'Failed to save time');
                    return;
                }
                const savedDvId = String(data?.log?.dv_id || '').trim();
                if (savedDvId) {
                    if (!Array.isArray(row.dayLogIds)) row.dayLogIds = Array(7).fill('');
                    row.dayLogIds[dayIdx] = savedDvId;
                }
                // Clear the override for this specific cell to force refresh from backend
                const ovMap = loadOverrides();
                const key = rowKeyFor(row);

                if (ovMap[key] && ovMap[key][dayIdx] !== undefined) {
                    delete ovMap[key][dayIdx];
                    // Remove the entire key array if it's now empty
                    if (ovMap[key].every(val => val === undefined || val === null)) {
                        delete ovMap[key];
                    }
                    saveOverrides(ovMap);
                }
                await render();
            } catch (err) {
                console.error('Cell save failed', err);
                showToast('Failed to save time');
            }
        };

        const openCellEditModal = (rowIdx, dayIdx) => {
            const row = gridRows[rowIdx];
            if (!row) return;
            const dayDate = new Date(startOfWeek(anchor));
            dayDate.setDate(startOfWeek(anchor).getDate() + dayIdx);
            const yyyy = dayDate.getFullYear();
            const mm = String(dayDate.getMonth() + 1).padStart(2, '0');
            const dd = String(dayDate.getDate()).padStart(2, '0');
            const workDate = `${yyyy}-${mm}-${dd}`;
            const today = new Date();
            const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
            if (workDate > todayStr) {
                showToast('Cannot edit future dates');
                return;
            }

            const key = rowKeyFor(row);
            const ovMap = loadOverrides();
            const arr = ovMap[key] || [];
            const currentSeconds = Number(arr[dayIdx] ?? row.hours?.[dayIdx] ?? 0);
            const currentHHMM = formatSeconds(currentSeconds) || '';

            const body = `
                <div class="leave-form timesheet-edit-form">
                    <div class="form-section">
                        <div class="form-section-header">
                            <div>
                                <p class="form-eyebrow">Timesheet entry</p>
                                <h3>Update logged hours</h3>
                            </div>
                            <p class="form-section-copy">Review the selected row details and adjust the duration.</p>
                        </div>

                        <div class="form-grid two-col">
                            <div class="form-field">
                                <label class="form-label">Date</label>
                                <div class="input-control">${workDate}</div>
                            </div>
                            <div class="form-field">
                                <label class="form-label">Project</label>
                                <div class="input-control">${row.project_id || row.project_name || '-'}</div>
                            </div>
                            <div class="form-field">
                                <label class="form-label">Task</label>
                                <div class="input-control">${row.task_id || row.task_name || '-'}</div>
                            </div>
                            <div class="form-field with-icon">
                                <label class="form-label" for="ts-edit-time">Time (HH:MM)</label>
                                <div class="input-wrapper">
                                    <i class="fa-regular fa-clock"></i>
                                    <input class="input-control" id="ts-edit-time" type="text" placeholder="HH:MM" value="${currentHHMM}" />
                                </div>
                                <p class="helper-text">Use HH:MM format (example: 01:30).</p>
                            </div>
                        </div>
                    </div>
                </div>`;

            renderModal('Edit time entry', body, [
                { id: 'ts-edit-cancel', text: 'Cancel', className: 'btn btn-secondary', type: 'button' },
                { id: 'ts-edit-save', text: 'Save', className: 'btn btn-primary', type: 'button' }
            ]);

            setTimeout(() => {
                const cancelBtn = document.getElementById('ts-edit-cancel');
                const saveBtn = document.getElementById('ts-edit-save');
                const input = document.getElementById('ts-edit-time');
                input?.focus();
                input?.select();

                cancelBtn?.addEventListener('click', () => closeModal());
                saveBtn?.addEventListener('click', async () => {
                    const secs = parseHHMM(input?.value || '');
                    if (secs === null) {
                        showToast('Enter time as HH:MM');
                        return;
                    }
                    closeModal();
                    await saveCell(rowIdx, dayIdx, secs);
                });
            }, 20);
        };

        document.querySelectorAll('.ts-hour-input').forEach(inp => {
            inp.addEventListener('dblclick', () => {
                if (inp.hasAttribute('disabled')) return;
                const rowIdx = parseInt(inp.getAttribute('data-row'), 10);
                const dayIdx = parseInt(inp.getAttribute('data-day'), 10);
                openCellEditModal(rowIdx, dayIdx);
            });
        });

        // Make entire timesheet rows navigate to their project page (ignore clicks on form controls)
        document.querySelectorAll('tr.ts-row-clickable').forEach(tr => {
            tr.style.cursor = 'pointer';
            tr.addEventListener('click', (e) => {
                if (e.target?.closest('.ts-delete-row, .icon-btn, .ts-hour-input, .ts-billing')) return;
                const tag = (e.target && e.target.tagName) || '';
                const skipTags = ['INPUT', 'SELECT', 'TEXTAREA', 'OPTION', 'BUTTON', 'LABEL'];
                if (skipTags.includes(tag)) return;
                const projectId = tr.getAttribute('data-project');

                const boardId = tr.getAttribute('data-board');
                if (!projectId) return;
                const boardPart = boardId ? `&tab=crm&board=${boardId}` : '';
                const tabPart = boardId ? '' : '&tab=crm';
                window.location.hash = `#/time-projects?id=${projectId}${tabPart}${boardPart}`;
            });
        });

        const addRowBtn = document.getElementById('ts-add-row');
        if (addRowBtn) {
            if (canManageMyTimesheetRows()) {
                addRowBtn.removeAttribute('disabled');
                addRowBtn.style.opacity = '';

                addRowBtn.style.cursor = '';
            } else {
                addRowBtn.setAttribute('disabled', 'disabled');
                addRowBtn.style.opacity = '0.6';
                addRowBtn.style.cursor = 'not-allowed';
            }
        }
    };

    await render();
};

export const renderTeamTimesheetPage = async () => {
    const API = `${apiBase}/api`;

    // Skeleton grid while employees and logs are loading
    try {
        const skeleton = `
            <div class="card" style="padding:0;">
                <div style="padding: 14px 16px; border-bottom: 1px solid #e5e7eb; display:flex; justify-content:space-between; align-items:center; gap:16px;">
                    <div class="skeleton skeleton-heading-md" style="width: 200px;"></div>
                    <div class="skeleton skeleton-pill" style="width: 180px; height: 32px;"></div>
                </div>
                <div style="padding: 16px 16px 20px;">
                    <div class="skeleton skeleton-chart-line"></div>
                </div>
            </div>
        `;
        const app = document.getElementById('app-content');
        if (app) app.innerHTML = getPageContentHTML('My team timesheet', skeleton);
    } catch { }

    try {
        const base = window.__teamTsMonth || new Date();
        const month = new Date(base.getFullYear(), base.getMonth(), 1);
        window.__teamTsMonth = new Date(month);
        const year = month.getFullYear();
        const m = month.getMonth();
        const daysInMonth = new Date(year, m + 1, 0).getDate();
        const days = Array.from({ length: daysInMonth }, (_, i) => new Date(year, m, i + 1));

        // Fetch all employees and resolve current user in parallel
        const [all, currentEmpId] = await Promise.all([
            cachedFetch('tt_team_employees', () => listEmployees(1, 5000), TTL.LONG),
            resolveCurrentEmployeeId().then(id => id || String(state.user?.id || '').toUpperCase())
        ]);
        const allItems = (all.items || []).map(e => ({
            id: (e.employee_id || '').toUpperCase(),
            name: `${e.first_name || ''} ${e.last_name || ''}`.trim() || (e.employee_id || '')
        }));
        const isAdmin = isAdminUser();
        let items = allItems;

        // Fetch timesheet logs for the month (use local dates, not UTC)
        const pad2 = (n) => String(n).padStart(2, '0');
        const startDate = `${year}-${pad2(m + 1)}-${pad2(1)}`;
        const endDate = `${year}-${pad2(m + 1)}-${pad2(daysInMonth)}`;

        console.log(`Team Timesheet - Fetching logs for month: ${startDate} to ${endDate}`);
        console.log(`Team Timesheet - Employees:`, items.map(e => `${e.name} (${e.id})`));

        // Fetch logs for all employees in the month
        let allLogs = [];
        // Use local date for comparison
        const today = new Date();
        const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
        console.log('Team Timesheet - Today (local):', todayStr);
        try {
            // For now, fetch all logs and filter client-side
            // In production, backend should support fetching all employees' logs
            const response = await fetch(`${API}/time-tracker/logs?employee_id=ALL&start_date=${startDate}&end_date=${endDate}`);
            console.log(`Team Timesheet - Fetch response status: ${response.status}`);
            if (response.ok) {
                const data = await response.json();
                // Filter out logs with future dates
                allLogs = (data.logs || []).filter(log => {
                    const logDate = (log.work_date || '').slice(0, 10);
                    return logDate <= todayStr;
                });
                console.log(`Team Timesheet - Fetched ${allLogs.length} logs`);
                // Log unique employee IDs in the logs
                const uniqueEmpIds = [...new Set(allLogs.map(l => l.employee_id))];
                console.log(`Team Timesheet - Employee IDs in logs:`, uniqueEmpIds);
            } else {
                // Fallback: fetch logs for each scoped employee (slower but works)
                for (const emp of items) {
                    try {
                        const res = await fetch(`${API}/time-tracker/logs?employee_id=${encodeURIComponent(emp.id)}&start_date=${startDate}&end_date=${endDate}`);
                        if (res.ok) {
                            const data = await res.json();
                            // Filter out logs with future dates
                            const validLogs = (data.logs || []).filter(log => {
                                const logDate = (log.work_date || '').slice(0, 10);
                                return logDate <= todayStr;
                            });
                            allLogs = allLogs.concat(validLogs);
                        }
                    } catch (e) {
                        console.error(`Failed to fetch logs for ${emp.id}:`, e);
                    }
                }
            }

            // Do not filter employees by logs; show everyone. Values will appear only for employees who have logs.
        } catch (e) {
            console.error('Failed to fetch team logs:', e);
        }

        console.log(`Team Timesheet - Loaded ${allLogs.length} logs`);

        const nav = `
          <div style="display:flex; align-items:center; gap:10px;">
            <button id="tt-prev" class="icon-btn"><i class="fa-solid fa-chevron-left"></i></button>
            <div id="tt-month" style="font-weight:600;">${month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</div>
            <button id="tt-next" class="icon-btn"><i class="fa-solid fa-chevron-right"></i></button>
          </div>`;
        const searchValue = window.__ttSearch || '';
        const controls = `
          <div class="tt-search-shell">
            <div class="inline-search" style="max-width:320px; width:100%;">
              <i class="fa-solid fa-search"></i>
              <input id="tt-search" type="text" placeholder="Search by employee name or ID" value="${searchValue}" />
            </div>
            <button id="tt-export-excel" class="btn btn-secondary" style="white-space:nowrap;">
              <i class="fa-solid fa-file-excel"></i> Export Excel
            </button>
          </div>`;
        const head = `
          <div class="tt-head" style="display:grid; grid-template-columns: 260px 120px repeat(${days.length}, 90px);">
            <div class="th" style="position:sticky; left:0; background: var(--surface-alt, #fafafa); padding:10px; font-weight:600; border-right:1px solid #eee; z-index:2; color: var(--text-primary, #1f2937);">Employee name, Emp Id</div>
            <div class="th" style="padding:10px; font-weight:600; border-right:1px solid #eee; color: var(--text-primary, #1f2937);">Total</div>
            ${days.map(function (d) { return '<div class="th" style="padding:10px; font-weight:600; text-align:center; border-right:1px solid #eee; color: var(--text-primary, #1f2937);">' + d.toLocaleDateString(undefined, { weekday: 'short' }) + '<br><span style="color: var(--text-secondary, #9ca3af);">' + d.toLocaleDateString(undefined, { month: 'short', day: '2-digit' }) + '</span></div>'; }).join('')}
          </div>`;

        const filteredItems = nameFilter(items, window.__ttSearch || '');
        window.__teamTsExportState = {
            month: new Date(month),
            days,
            items: filteredItems,
            logs: allLogs
        };
        const rows = filteredItems.map(emp => teamRow(emp, days, allLogs)).join('');
        const content = `
          <style>
            :root { --tt-blue:#1e88e5; }
            .tt-header { background: var(--tt-blue); color:#fff; padding:14px 16px; border-radius:12px 12px 0 0; box-shadow:0 2px 6px rgba(0,0,0,0.08); display:flex; align-items:center; justify-content:space-between; gap:16px; flex-wrap:wrap; }
            .tt-header .center { display:flex; align-items:center; justify-content:flex-start; gap:12px; }
            .tt-header .icon-btn { background:rgba(255,255,255,0.2); color:#fff; border:none; width:36px; height:36px; border-radius:50%; display:inline-flex; align-items:center; justify-content:center; }
            .tt-header .controls { display:flex; justify-content:flex-end; align-items:center; flex:1; }
            .tt-search-shell { width:100%; display:flex; justify-content:flex-end; }
            .tt-header .controls .tt-search-input { 
              display:flex; 
              align-items:center; 
              gap:8px; 
              padding:8px 12px; 
              border-radius:999px; 
              background: var(--surface-color, #ffffff); 
              border:1px solid var(--border-color, rgba(15,23,42,0.06)); 
              box-shadow:0 4px 10px rgba(15,23,42,0.12); 
              width:100%; 
              max-width:320px; 
            }
            .tt-header .controls .tt-search-input i { color: var(--text-muted, #9ca3af); font-size:0.85rem; }
            .tt-header .controls .tt-search-input input { 
              border:none; 
              outline:none; 
              width:100%; 
              background:transparent; 
              color: var(--text-primary, #111827); 
              font-size:0.9rem; 
            }
            .tt-header .controls .tt-search-input input::placeholder { color: var(--text-muted, #9ca3af); }
            .tt-wrap { overflow:auto; }
            .tt-head { background: var(--surface-alt, #fafbfd); border-bottom:1px solid var(--border-color, #e8edf3); box-sizing:border-box; }
            .tt-head .th { color: var(--text-primary, #1f2937); }
            .tt-row { display:grid; grid-template-columns: 260px 120px repeat(${days.length}, 90px); background: var(--surface-color, #fff); box-sizing:border-box; }
            .tt-cell { border-top:1px solid var(--border-color, #f1f5f9); border-right:1px solid var(--border-color, #eef2f7); padding:10px; display:flex; align-items:center; justify-content:center; gap:6px; min-height:44px; box-sizing:border-box; }
            .tt-cell:nth-child(2n+3) { background: var(--surface-hover, #fafafa); }
            .tt-sticky { position:sticky; left:0; background: var(--surface-color, #fff); z-index:1; justify-content:flex-start; text-align:left; padding-left:12px; }
            .tt-sticky > div { display:flex; flex-direction:column; line-height:1.1; }
            .emp-badge { width:34px; height:34px; border-radius:50%; display:inline-flex; align-items:center; justify-content:center; color:#fff; font-weight:700; margin-right:10px; box-shadow: inset 0 0 0 2px rgba(255,255,255,0.25); }
            .tt-cell.worked { background:#60a5fa; color:#fff; border-color:transparent; border-radius:10px; position:relative; display:flex; align-items:center; justify-content:center; }
            .tt-cell.worked span { font-weight:700; letter-spacing:.2px; }
            .tt-cell.day-off { background: var(--surface-hover, #e5e7eb); color: var(--text-primary, #374151); font-weight:600; border-radius:10px; }
            .tt-cell.empty { background: var(--surface-alt, #f8fafc); border-radius:10px; }
            .tt-total { font-weight:700; color: var(--text-primary, #111827); }
            .tt-footnote { color: var(--text-secondary, #6b7280); font-size:12px; padding:10px 14px; }
            /* Alternate background for day headers to align with columns */
            .tt-head .th:nth-child(2n+3) { background: var(--surface-hover, #f6f7fb); }
          </style>
          <div class="card" style="padding:0;">
            <div class="tt-header">
              <div></div>
              <div class="center">${nav}</div>
              <div class="controls">${controls}</div>
            </div>
            <div class="tt-wrap">
              ${head}
              ${rows || `<div class="placeholder-text" style="padding:24px;">No employees found</div>`}
            </div>
            <div class="tt-footnote">Approved timesheet entries alone are recorded in My Team Timesheet.</div>
          </div>
        `;
        document.getElementById('app-content').innerHTML = getPageContentHTML('My Team Timesheet', content);
        setTimeout(() => attachTeamTsEvents(), 0);
    } catch (err) {
        console.error('Team timesheet error:', err);
        const content = `<div class="card"><p class="placeholder-text">Failed to load team timesheet.</p></div>`;
        document.getElementById('app-content').innerHTML = getPageContentHTML('My Team Timesheet', content);
    }
};

let _clientsFilters = { search: '', country: '', company: '', sort: 'recent' };
let _clientsCache = { items: [], countries: [], companies: [], page: 1, pageSize: 25, total: 0 };

export const renderTTClientsPage = async () => {
    try {
        const params = {
            search: _clientsFilters.search,
            country: _clientsFilters.country,
            company: _clientsFilters.company,
            sort: _clientsFilters.sort,
            page: 1,
            pageSize: 5000
        };
        const data = await listClients(params);
        const items = data.clients || [];
        _clientsCache.items = items;
        _clientsCache.total = data.total || items.length;
        _clientsCache.page = data.page || 1;
        _clientsCache.pageSize = data.pageSize || 25;
        _clientsCache.countries = Array.from(new Set(items.map(x => (x.crc6f_country || '').trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b));
        _clientsCache.companies = Array.from(new Set(items.map(x => (x.crc6f_companyname || '').trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b));

        const controls = `
          <div class="tm-like-controls" style="display:flex; gap:12px; flex-wrap:wrap; justify-content:flex-end;">
            <button id="clients-add" class="btn btn-primary"><i class="fa-solid fa-user-plus"></i> Add Client</button>
            <button id="clients-refresh" class="btn btn-secondary"><i class="fa-solid fa-rotate"></i> Refresh</button>
          </div>`;

        const safe = (v) => (v || '');
        const rows = items.map(r => `
            <tr>
                <td>${safe(r.crc6f_clientid)}</td>
                <td>${safe(r.crc6f_clientname)}</td>
                <td>${safe(r.crc6f_companyname)}</td>
                <td>${safe(r.crc6f_email)}</td>
                <td>${safe(r.crc6f_phone)}</td>
                <td>${safe(r.crc6f_country)}</td>
                <td class="actions-cell" style="text-align:center;">
                    <button class="icon-btn client-edit" title="Edit" data-id="${r.crc6f_hr_clientsid}"><i class="fa-solid fa-pen-to-square"></i></button>
                    <button class="icon-btn client-delete" title="Delete" data-id="${r.crc6f_hr_clientsid}" data-clientid="${r.crc6f_clientid}"><i class="fa-solid fa-trash"></i></button>
                </td>
            </tr>
        `).join('');

        const filtersHtml = `
          <div class="clients-filters" style="display:grid; grid-template-columns:repeat(auto-fit, minmax(220px, 1fr)); gap:12px; align-items:end; margin-bottom:12px;">
            <div class="filter-field filter-wide" style="grid-column:span 2;">
              <label style="display:block; font-weight:600; margin-bottom:6px;" for="clients-search">Search</label>
              <div class="inline-search" style="width:100%;">
                <i class="fa-solid fa-search"></i>
                <input type="text" id="clients-search" placeholder="Search by Client ID, Name or Company" value="${_clientsFilters.search}" />
              </div>
            </div>
            <div class="filter-field">
              <label style="display:block; font-weight:600; margin-bottom:6px;" for="clients-country">Country</label>
              <select id="clients-country" style="width:100%; border:1px solid #ddd; border-radius:8px; padding:8px 10px;">
                <option value="">All Countries</option>
                ${_clientsCache.countries.map(function (c) { return '<option ' + (_clientsFilters.country === c.toLowerCase() ? 'selected' : '') + ' value="' + c + '">' + c + '</option>'; }).join('')}
              </select>
            </div>
            <div class="filter-field">
              <label style="display:block; font-weight:600; margin-bottom:6px;" for="clients-company">Company</label>
              <select id="clients-company" style="width:100%; border:1px solid #ddd; border-radius:8px; padding:8px 10px;">
                <option value="">All Companies</option>
                ${_clientsCache.companies.map(function (c) { return '<option ' + (_clientsFilters.company === c.toLowerCase() ? 'selected' : '') + ' value="' + c + '">' + c + '</option>'; }).join('')}
              </select>
            </div>
            <div class="filter-field">
              <label style="display:block; font-weight:600; margin-bottom:6px;" for="clients-sort">Sort</label>
              <select id="clients-sort" style="width:100%; border:1px solid #ddd; border-radius:8px; padding:8px 10px;">
                <option value="recent" ${_clientsFilters.sort === 'recent' ? 'selected' : ''}>Recently Created</option>
                <option value="name" ${_clientsFilters.sort === 'name' ? 'selected' : ''}>Name</option>
                <option value="country" ${_clientsFilters.sort === 'country' ? 'selected' : ''}>Country</option>
              </select>
            </div>
           </div>`;

        const tableHtml = `
          <div class="table-container" style="overflow:hidden; border:1px solid #eee; border-radius:12px; background:#fff;">
            <table class="table" style="table-layout:auto; width:100%; border-collapse:separate; border-spacing:0;">
              <thead>
                <tr>
                  <th style="text-align:center; position:sticky; top:0; background:var(--surface-alt);">Client ID</th>
                  <th style="text-align:center; position:sticky; top:0; background:var(--surface-alt);">Client Name</th>
                  <th style="text-align:center; position:sticky; top:0; background:var(--surface-alt);">Company Name</th>
                  <th style="text-align:center; position:sticky; top:0; background:var(--surface-alt);">Email</th>
                  <th style="text-align:center; position:sticky; top:0; background:var(--surface-alt);">Phone</th>
                  <th style="text-align:center; position:sticky; top:0; background:var(--surface-alt);">Country</th>
                  <th style="text-align:center; position:sticky; top:0; background:var(--surface-alt);">Actions</th>
                </tr>
              </thead>
              <tbody>
                ${rows || `<tr><td colspan="7" class="placeholder-text">No Clients Found</td></tr>`}
              </tbody>
            </table>
          </div>`;

        const content = `
          <style>
            .clients-card { padding:16px; }
            .clients-filters .filter-wide { grid-column: span 2; }
            @media (max-width: 720px) { .clients-filters .filter-wide { grid-column: span 1; } }
            .clients-card .table th,
            .clients-card .table td {
              padding:8px 10px;
              text-align:center;
              vertical-align:middle;
            }
            .actions-cell .icon-btn + .icon-btn { margin-left:6px; }
          </style>
          <div class="card clients-card">
            ${filtersHtml}
            ${tableHtml}
          </div>`;

        document.getElementById('app-content').innerHTML = getPageContentHTML('Clients', content, controls);

        attachClientsEvents();
    } catch (err) {
        console.error('Failed to load clients:', err);
        showToast(err?.message || 'Failed to load clients', 'error');
        const content = `<div class="card"><p class="placeholder-text">Failed to load clients.</p></div>`;
        document.getElementById('app-content').innerHTML = getPageContentHTML('Clients', content);
    }
};

const attachClientsEvents = () => {
    const search = document.getElementById('clients-search');
    const country = document.getElementById('clients-country');
    const company = document.getElementById('clients-company');
    const sort = document.getElementById('clients-sort');
    const refresh = document.getElementById('clients-refresh');
    const add = document.getElementById('clients-add');

    let debounce;
    if (search) search.addEventListener('input', (e) => {
        clearTimeout(debounce);
        const v = e.target.value;
        debounce = setTimeout(() => { _clientsFilters.search = v.trim(); renderTTClientsPage(); }, 300);
    });
    if (country) country.addEventListener('change', (e) => { _clientsFilters.country = (e.target.value || '').toLowerCase(); renderTTClientsPage(); });
    if (company) company.addEventListener('change', (e) => { _clientsFilters.company = (e.target.value || '').toLowerCase(); renderTTClientsPage(); });
    if (sort) sort.addEventListener('change', (e) => { _clientsFilters.sort = e.target.value; renderTTClientsPage(); });
    if (refresh) refresh.addEventListener('click', () => renderTTClientsPage());
    if (add) add.addEventListener('click', () => showClientModal());

    document.querySelectorAll('.client-edit').forEach(btn => btn.addEventListener('click', () => showClientModal(btn.dataset.id)));
    document.querySelectorAll('.client-delete').forEach(btn => btn.addEventListener('click', () => handleDeleteClient(btn.dataset.id, btn.dataset.clientid)));
};

const clientFormHTML = (data = {}) => `
  <div class="modal-form modern-form client-form">
    <div class="form-section">
      <div class="form-section-header">
        <div>
          <p class="form-eyebrow">Client</p>
          <h3>Client details</h3>
        </div>
      </div>
      <div class="form-grid two-col">
        <div class="form-field">
          <label class="form-label" for="cl-clientid">Client ID</label>
          <input class="input-control" type="text" id="cl-clientid" value="${data.crc6f_clientid || ''}" ${data._isEdit ? '' : 'placeholder="Auto-generated if empty"'}>
        </div>
        <div class="form-field">
          <label class="form-label" for="cl-name">Client Name</label>
          <input class="input-control" type="text" id="cl-name" value="${data.crc6f_clientname || ''}" required>
        </div>
        <div class="form-field">
          <label class="form-label" for="cl-company">Company Name</label>
          <input class="input-control" type="text" id="cl-company" value="${data.crc6f_companyname || ''}">
        </div>
        <div class="form-field">
          <label class="form-label" for="cl-email">Email</label>
          <input class="input-control" type="email" id="cl-email" value="${data.crc6f_email || ''}">
        </div>
        <div class="form-field">
          <label class="form-label" for="cl-phone">Phone</label>
          <input class="input-control" type="text" id="cl-phone" value="${data.crc6f_phone || ''}" required>
        </div>
        <div class="form-field">
          <label class="form-label" for="cl-country">Country</label>
          <input class="input-control" type="text" id="cl-country" value="${data.crc6f_country || ''}">
        </div>
        <div class="form-field" style="grid-column:1 / -1;">
          <label class="form-label" for="cl-address">Address</label>
          <textarea class="input-control" id="cl-address" rows="3">${data.crc6f_address || ''}</textarea>
        </div>
      </div>
    </div>
  </div>`;

const showClientModal = async (recordId) => {
    const isEdit = !!recordId;
    let data = {};
    if (isEdit) {
        const rec = _clientsCache.items.find(x => x.crc6f_hr_clientsid === recordId);
        data = { ...rec, _isEdit: true };
    } else {
        try {
            const next = await getNextClientId();
            data.crc6f_clientid = next;
        } catch { }
    }
    renderModal(isEdit ? 'Edit Client' : 'Add Client', clientFormHTML(data), 'clients-submit');
    setTimeout(() => {
        const form = document.getElementById('modal-form');
        if (!form) return;
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            await runWithSubmissionLoading(async () => {
                try {
                    const payload = collectClientForm();
                    validateClient(payload);
                    if (isEdit) {
                        await updateClient(recordId, payload);
                        showToast('Client updated successfully', 'success');
                    } else {
                        await createClient(payload);
                        showToast('Client created successfully', 'success');
                    }
                    await renderTTClientsPage();
                    closeModal();
                } catch (err) {
                    console.error(err);
                    showToast(err?.message || 'Failed to save client', 'error');
                }
            }, isEdit ? 'Updating client...' : 'Creating client...');
        });
    }, 50);
};

const collectClientForm = () => ({
    crc6f_clientid: document.getElementById('cl-clientid')?.value?.trim(),
    crc6f_clientname: document.getElementById('cl-name')?.value?.trim(),
    crc6f_companyname: document.getElementById('cl-company')?.value?.trim(),
    crc6f_email: document.getElementById('cl-email')?.value?.trim(),
    crc6f_phone: document.getElementById('cl-phone')?.value?.trim(),
    crc6f_address: document.getElementById('cl-address')?.value?.trim(),
    crc6f_country: document.getElementById('cl-country')?.value?.trim(),
});

const validateClient = (p) => {
    if (!p.crc6f_clientname) throw new Error('Client Name is required');
    if (!p.crc6f_phone) throw new Error('Phone is required');
    if (p.crc6f_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.crc6f_email)) throw new Error('Invalid email');
};

const handleDeleteClient = async (recordId, clientId) => {
    if (!confirm(`Delete client ${clientId || ''}?`)) return;
    try {
        await deleteClient(recordId);
        showToast('Client deleted', 'success');
        await renderTTClientsPage();
    } catch (err) {
        console.error(err);
        showToast(err?.message || 'Failed to delete client', 'error');
    }
};

const showClientDetails = (recordId) => {
    const rec = _clientsCache.items.find(x => x.crc6f_hr_clientsid === recordId);
    if (!rec) return;
    const body = `
      <div class="form-grid-2-col">
        <div class="form-group"><label>Client ID</label><input type="text" value="${rec.crc6f_clientid || ''}" disabled></div>
        <div class="form-group"><label>Client Name</label><input type="text" value="${rec.crc6f_clientname || ''}" disabled></div>
        <div class="form-group"><label>Company</label><input type="text" value="${rec.crc6f_companyname || ''}" disabled></div>
        <div class="form-group"><label>Email</label><input type="text" value="${rec.crc6f_email || ''}" disabled></div>
        <div class="form-group"><label>Phone</label><input type="text" value="${rec.crc6f_phone || ''}" disabled></div>
        <div class="form-group"><label>Country</label><input type="text" value="${rec.crc6f_country || ''}" disabled></div>
        <div class="form-group" style="grid-column:1 / span 2;"><label>Address</label><textarea rows="3" disabled>${rec.crc6f_address || ''}</textarea></div>
      </div>`;
    renderModal('Client Details', body, [
        { id: 'close-client', text: 'Close', className: 'btn-secondary', type: 'button' }
    ]);
    setTimeout(() => {
        const close = document.getElementById('close-client');
        if (close) close.onclick = closeModal;
    }, 50);
};

export const renderTTProjectsPage = async () => {
    const content = `<div class="card"><p class="placeholder-text">Projects page is under construction.</p></div>`;
    document.getElementById('app-content').innerHTML = getPageContentHTML('Projects', content);
};

export const renderInboxPage = async () => {
    console.log('📥 Rendering Inbox Page...');

    // Update notification badge
    await updateNotificationBadge();

    const isAdmin = isAdminUser();
    const canViewTeamQueues = isManagerOrAdmin();
    const showAwaitingTab = canViewTeamQueues;
    console.log('👤 User is admin:', isAdmin, '| can view team queues:', canViewTeamQueues);

    // Initial static content
    const content = `
    <div class="inbox-container">
        <div class="inbox-sidebar">
            <div class="inbox-category active" data-category="leaves">Leaves</div>
            <div class="inbox-category" data-category="timesheet">Timesheet</div>
            <div class="inbox-category" data-category="attendance">Attendance Report</div>
        </div>
        <div class="inbox-content">
            <div class="inbox-tabs">
                ${showAwaitingTab ? '<div class="inbox-tab active" data-tab="awaiting">Awaiting approval</div>' : ''}
                <div class="inbox-tab ${showAwaitingTab ? '' : 'active'}" data-tab="requests">My requests</div>
                <div class="inbox-tab" data-tab="completed">Completed</div>
            </div>
            <div class="inbox-list">
                <div style="padding: 16px 20px;">
                    <div class="skeleton skeleton-list-line-lg" style="width: 70%;"></div>
                    <div class="skeleton skeleton-list-line-sm" style="width: 40%; margin-top: 4px;"></div>
                    <div style="margin-top: 16px; display:flex; flex-direction:column; gap:12px;">
                        <div class="skeleton skeleton-list-line-lg"></div>
                        <div class="skeleton skeleton-list-line-lg"></div>
                        <div class="skeleton skeleton-list-line-lg"></div>
                    </div>
                </div>
            </div>
        </div>
    </div>
    `;
    document.getElementById('app-content').innerHTML = getPageContentHTML('Inbox', content);

    // Set initial tab (force non-admins away from awaiting queue)
    if (!showAwaitingTab && currentInboxTab === 'awaiting') {
        currentInboxTab = 'requests';
    } else {
        currentInboxTab = showAwaitingTab ? 'awaiting' : 'requests';
    }

    // Add event listeners
    setTimeout(async () => {
        // Category navigation
        document.querySelectorAll('.inbox-category').forEach(cat => {
            cat.addEventListener('click', (e) => {
                document.querySelectorAll('.inbox-category').forEach(c => c.classList.remove('active'));
                e.currentTarget.classList.add('active');
                currentInboxCategory = e.currentTarget.getAttribute('data-category');

                if (currentInboxCategory === 'leaves') {
                    loadInboxLeaves();
                } else if (currentInboxCategory === 'timesheet') {
                    loadInboxTimesheets();
                } else if (currentInboxCategory === 'attendance') {
                    loadInboxAttendance();
                }
            });
        });

        // Tab navigation
        document.querySelectorAll('.inbox-tab').forEach(tab => {
            tab.addEventListener('click', (e) => {
                document.querySelectorAll('.inbox-tab').forEach(t => t.classList.remove('active'));
                e.currentTarget.classList.add('active');
                currentInboxTab = e.currentTarget.getAttribute('data-tab');

                if (currentInboxCategory === 'leaves') {
                    loadInboxLeaves();
                } else if (currentInboxCategory === 'timesheet') {
                    loadInboxTimesheets();
                } else if (currentInboxCategory === 'attendance') {
                    loadInboxAttendance();
                }
            });
        });

        // Load initial data for current category
        if (currentInboxCategory === 'leaves') {
            await loadInboxLeaves();
        } else if (currentInboxCategory === 'timesheet') {
            await loadInboxTimesheets();
        } else if (currentInboxCategory === 'attendance') {
            await loadInboxAttendance();
        }
    }, 0);
};

export const renderMeetPage = async () => {
    const tz = (() => {
        try {
            return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
        } catch {
            return 'UTC';
        }
    })();

    const content = `
    <style>
        /* --- Modern Meet Layout --- */
        .meet-container {
            max-width: 1200px;
            margin: 0 auto;
            padding: 20px;
        }
        .meet-header {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 30px;
            border-radius: 16px;
            margin-bottom: 24px;
            box-shadow: 0 10px 30px rgba(102, 126, 234, 0.3);
        }
        body.dark-theme .meet-header {
            background: linear-gradient(135deg, #4c51bf 0%, #553c9a 100%);
        }
        .meet-header h1 {
            margin: 0 0 8px 0;
            font-size: 28px;
            font-weight: 700;
        }
        .meet-header p {
            margin: 0;
            opacity: 0.9;
            font-size: 15px;
        }
        .meet-card {
            background: white;
            border-radius: 16px;
            padding: 24px;
            box-shadow: 0 4px 20px rgba(0, 0, 0, 0.08);
            margin-bottom: 20px;
        }
        body.dark-theme .meet-card {
            background: rgba(30, 41, 59, 0.9);
            box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4);
        }

        /* --- Form & Inputs --- */
        .meet-form-group {
            margin-bottom: 20px;
        }
        .meet-form-group label {
            display: block;
            margin-bottom: 8px;
            font-size: 14px;
            font-weight: 600;
            color: #374151;
        }
        body.dark-theme .meet-form-group label {
            color: #e5e7eb;
        }
        .meet-input,
        .meet-select,
        .meet-textarea {
            width: 100%;
            padding: 12px 16px;
            border: 2px solid #e5e7eb;
            border-radius: 10px;
            font-size: 14px;
            transition: all 0.2s ease;
            background: white;
        }
        .meet-input:focus,
        .meet-select:focus,
        .meet-textarea:focus {
            outline: none;
            border-color: #667eea;
            box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.1);
        }
        body.dark-theme .meet-input,
        body.dark-theme .meet-select,
        body.dark-theme .meet-textarea {
            background: rgba(30, 41, 59, 0.8);
            border-color: rgba(148, 163, 184, 0.3);
            color: #e5e7eb;
        }
        body.dark-theme .meet-input:focus,
        body.dark-theme .meet-select:focus,
        body.dark-theme .meet-textarea:focus {
            border-color: #818cf8;
        }
        .meet-select {
            cursor: pointer;
            appearance: none;
            background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%23374151' d='M6 9L1 4h10z'/%3E%3C/svg%3E");
            background-repeat: no-repeat;
            background-position: right 12px center;
            padding-right: 40px;
        }
        body.dark-theme .meet-select {
            background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%23e5e7eb' d='M6 9L1 4h10z'/%3E%3C/svg%3E");
        }
        .meet-multiselect {
            position: relative;
        }
        .meet-multiselect-dropdown {
            position: absolute;
            top: 100%;
            left: 0;
            right: 0;
            max-height: 300px;
            overflow-y: auto;
            background: white;
            border: 2px solid #667eea;
            border-radius: 10px;
            margin-top: 4px;
            box-shadow: 0 10px 40px rgba(0, 0, 0, 0.15);
            z-index: 1000;
            display: none;
        }
        .meet-multiselect-dropdown.active {
            display: block;
        }
        body.dark-theme .meet-multiselect-dropdown {
            background: rgba(30, 41, 59, 0.98);
            border-color: #818cf8;
        }
        .meet-multiselect-option {
            padding: 12px 16px;
            cursor: pointer;
            transition: background 0.15s ease;
            display: flex;
            align-items: center;
            gap: 12px;
        }
        .meet-multiselect-option:hover {
            background: #f3f4f6;
        }
        body.dark-theme .meet-multiselect-option:hover {
            background: rgba(55, 65, 81, 0.6);
        }
        .meet-multiselect-option.selected {
            background: #ede9fe;
        }
        body.dark-theme .meet-multiselect-option.selected {
            background: rgba(109, 40, 217, 0.3);
        }
        .meet-multiselect-checkbox {
            width: 18px;
            height: 18px;
            border: 2px solid #d1d5db;
            border-radius: 4px;
            display: flex;
            align-items: center;
            justify-content: center;
            flex-shrink: 0;
        }
        .meet-multiselect-option.selected .meet-multiselect-checkbox {
            background: #667eea;
            border-color: #667eea;
        }
        .meet-multiselect-option.selected .meet-multiselect-checkbox::after {
            content: '✓';
            color: white;
            font-size: 12px;
            font-weight: bold;
        }
        .meet-multiselect-info {
            flex: 1;
        }
        .meet-multiselect-name {
            font-weight: 600;
            color: #111827;
        }
        body.dark-theme .meet-multiselect-name {
            color: #f3f4f6;
        }
        .meet-multiselect-meta {
            font-size: 12px;
            color: #6b7280;
            margin-top: 2px;
        }
        body.dark-theme .meet-multiselect-meta {
            color: #9ca3af;
        }

        /* --- Selected Participants Chips --- */
        .meet-selected-chips {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
            min-height: 40px;
            padding: 12px;
            background: #f9fafb;
            border-radius: 10px;
            border: 2px dashed #e5e7eb;
        }
        body.dark-theme .meet-selected-chips {
            background: rgba(17, 24, 39, 0.5);
            border-color: rgba(148, 163, 184, 0.3);
        }
        .meet-chip {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            padding: 8px 12px;
            border-radius: 20px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            font-size: 13px;
            font-weight: 500;
            box-shadow: 0 2px 8px rgba(102, 126, 234, 0.3);
        }
        .meet-chip-remove {
            border: none;
            background: rgba(255, 255, 255, 0.2);
            color: white;
            cursor: pointer;
            font-size: 16px;
            padding: 2px 6px;
            border-radius: 50%;
            line-height: 1;
            transition: background 0.15s ease;
        }
        .meet-chip-remove:hover {
            background: rgba(255, 255, 255, 0.3);
        }
        .meet-empty-state {
            color: #9ca3af;
            font-size: 13px;
            font-style: italic;
        }
        body.dark-theme .meet-empty-state {
            color: #6b7280;
        }

        /* --- Action Buttons --- */
        .meet-btn {
            padding: 12px 24px;
            border: none;
            border-radius: 10px;
            font-size: 15px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.2s ease;
            display: inline-flex;
            align-items: center;
            gap: 8px;
        }
        .meet-btn-primary {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            box-shadow: 0 4px 15px rgba(102, 126, 234, 0.4);
        }
        .meet-btn-primary:hover:not(:disabled) {
            transform: translateY(-2px);
            box-shadow: 0 6px 20px rgba(102, 126, 234, 0.5);
        }
        .meet-btn-primary:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }
        .meet-btn-secondary {
            background: white;
            color: #667eea;
            border: 2px solid #667eea;
        }
        body.dark-theme .meet-btn-secondary {
            background: rgba(30, 41, 59, 0.8);
            color: #818cf8;
            border-color: #818cf8;
        }
        .meet-btn-secondary:hover:not(:disabled) {
            background: #f3f4f6;
        }
        body.dark-theme .meet-btn-secondary:hover:not(:disabled) {
            background: rgba(55, 65, 81, 0.8);
        }
        .meet-actions {
            display: flex;
            gap: 12px;
            justify-content: flex-end;
            margin-top: 24px;
        }

        /* --- Call Modal --- */
        /* Globally centered overlay - no blur, transparent background */
        .meet-call-modal {
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 9999;
        }
        .meet-call-modal.hidden { display: none !important; }
        .meet-call-modal-card {
            position: relative;
        }
        #meet-call-close {
            cursor: pointer;
            background: transparent;
            border: none;
            color: #e5e7eb;
            font-size: 20px;
            padding: 8px;
            border-radius: 8px;
            transition: background 0.15s ease;
        }
        #meet-call-close:hover {
            background: rgba(255, 255, 255, 0.1);
        }
        .meet-call-footer {
            margin-top: 12px;
            display: flex;
            justify-content: flex-end;
        }
        @media (max-width: 768px) {
            .meet-call-modal-card {
                width: min(420px, 94vw);
            }
        }
        .meet-call-banner {
            display: flex;
            gap: 12px;
            align-items: center;
            background: rgba(59, 130, 246, 0.12);
            border: 1px solid rgba(59, 130, 246, 0.35);
            border-radius: 12px;
            padding: 12px 14px;
            margin-bottom: 12px;
        }
        .meet-call-banner.hidden { display: none; }
        body.dark-theme .meet-call-banner {
            background: rgba(96, 165, 250, 0.18);
            border-color: rgba(96, 165, 250, 0.5);
            color: #dbeafe;
        }
        .meet-call-banner-icon {
            width: 38px;
            height: 38px;
            border-radius: 999px;
            background: rgba(59, 130, 246, 0.16);
            display: flex;
            align-items: center;
            justify-content: center;
            color: #1d4ed8;
            font-size: 15px;
        }
        body.dark-theme .meet-call-banner-icon {
            background: rgba(96, 165, 250, 0.3);
            color: #e0f2fe;
        }
        .meet-call-user {
            border: 1px solid rgba(148, 163, 184, 0.35);
            border-radius: 14px;
            padding: 12px 14px;
            margin-bottom: 10px;
            display: flex;
            align-items: center;
            justify-content: space-between;
            background: rgba(15, 23, 42, 0.03);
        }
        body.dark-theme .meet-call-user {
            border-color: rgba(148, 163, 184, 0.55);
            background: rgba(31, 41, 55, 0.6);
        }
        .meet-call-user-info { display: flex; flex-direction: column; gap: 2px; }
        .meet-call-user-actions { display: flex; gap: 8px; align-items: center; }

        /* --- Headers & Helpers --- */
        .meet-header h2, .meet-header h3 { margin: 0; }
        .meet-subtle { color: #6b7280; font-size: 13px; }
        body.dark-theme .meet-subtle { color: #cbd5e1; }
    </style>

    <div class="meet-container">
        <div class="meet-header">
            <h1><i class="fa-solid fa-video"></i> Start a Meeting</h1>
            <p>Create a Google Meet and invite your team members</p>
        </div>

        <div class="meet-card">
            <h3 style="margin: 0 0 20px 0; font-size: 18px; font-weight: 600;">Meeting Details</h3>
            
            <div class="meet-form-group">
                <label for="meet-title">Meeting Title</label>
                <input type="text" id="meet-title" class="meet-input" placeholder="e.g., Team Standup" value="Team Sync" />
            </div>

            <div class="meet-form-group">
                <label for="meet-description">Description (Optional)</label>
                <textarea id="meet-description" class="meet-textarea" rows="3" placeholder="Add meeting agenda or notes..."></textarea>
            </div>

            <div class="meet-form-group">
                <label for="meet-employee-select">Select Participants</label>
                <div class="meet-multiselect">
                    <input 
                        type="text" 
                        id="meet-employee-select" 
                        class="meet-input" 
                        placeholder="Click to select employees or type to search..."
                        autocomplete="off"
                        readonly
                    />
                    <div id="meet-employee-dropdown" class="meet-multiselect-dropdown"></div>
                </div>
            </div>

            <div class="meet-form-group">
                <label>Selected Participants (<span id="meet-participant-count">0</span>)</label>
                <div id="meet-selected-chips" class="meet-selected-chips">
                    <span class="meet-empty-state">No participants selected yet</span>
                </div>
            </div>

            <div class="meet-actions">
                <button type="button" id="meet-call-btn" class="meet-btn meet-btn-primary" disabled>
                    <i class="fa-solid fa-phone"></i>
                    Start Call & Notify Participants
                </button>
            </div>
        </div>
    </div>

    <div id="meet-call-modal" class="meet-call-modal incoming-call-overlay hidden">
        <div class="meet-call-modal-card incoming-call-modal">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
                <div>
                    <h3 style="margin:0; font-size:18px;">Call participants</h3>
                    <p style="margin:4px 0 0; font-size:13px; color:#6b7280;">Gather confirmations before joining the meeting.</p>
                </div>
                <button type="button" id="meet-call-close" aria-label="Close call participants">
                    <i class="fa-solid fa-xmark"></i>
                </button>
            </div>
            <div id="meet-call-banner" class="meet-call-banner hidden">
                <div class="meet-call-banner-icon">
                    <i class="fa-solid fa-bell"></i>
                </div>
                <div>
                    <h4 id="meet-call-banner-title">Ringing participants…</h4>
                    <p id="meet-call-banner-text">Awaiting responses with join/decline options.</p>
                </div>
            </div>
            <div id="meet-call-list"></div>
            <div class="meet-call-footer incoming-call-actions">
                <button type="button" id="meet-call-cancel" class="incoming-call-btn incoming-call-btn-decline">
                    <i class="fa-solid fa-phone-slash"></i> Cancel call
                </button>
            </div>
        </div>
    </div>
    `;

    const app = document.getElementById('app-content');
    if (app) {
        app.innerHTML = getPageContentHTML('Meet', content);
    }

    setTimeout(() => {
        const API_BASE = apiBase; // Use global config instead of hardcoded localhost
        const employeesDirectory = new Map();

        const titleInput = document.getElementById('meet-title');
        const descriptionInput = document.getElementById('meet-description');
        const employeeSelectInput = document.getElementById('meet-employee-select');
        const employeeDropdown = document.getElementById('meet-employee-dropdown');
        const selectedChipsContainer = document.getElementById('meet-selected-chips');
        const participantCountEl = document.getElementById('meet-participant-count');
        const callBtn = document.getElementById('meet-call-btn');
        const callModal = document.getElementById('meet-call-modal');
        const callList = document.getElementById('meet-call-list');
        const callCloseBtn = document.getElementById('meet-call-close');
        const callCancelBtn = document.getElementById('meet-call-cancel');
        const callBanner = document.getElementById('meet-call-banner');
        const callBannerTitle = document.getElementById('meet-call-banner-title');
        const callBannerText = document.getElementById('meet-call-banner-text');

        try {
            const body = document.body;
            if (callModal && body && callModal.parentElement !== body) {
                body.appendChild(callModal);
            }
        } catch (_) {
        }

        const participantDirectory = new Map();
        const selectedEmployees = new Set();
        let allEmployees = [];
        let filteredEmployees = [];
        let currentMeetInfo = null;
        let currentCallId = null;
        let callDecisions = new Map();
        let serverParticipantStatuses = new Map();
        const defaultCallBtnHTML = callBtn?.innerHTML || '<i class="fa-solid fa-phone"></i> Start Call & Notify Participants';
        let isMeetRequestInFlight = false;
        let isDropdownOpen = false;

        const normalizeEmployeeId = (value) => String(value || '').trim().toUpperCase();
        const makeManualSource = (id) => `manual:${id}`;
        const makeProjectSource = (projectId) => `project:${projectId}`;

        const ensureParticipantEntry = (id, meta = {}) => {
            const existing = participantDirectory.get(id) || {
                id,
                name: meta.name || id,
                email: meta.email || '',
                designation: meta.designation || '',
                sources: new Set()
            };
            if (meta.name && (!existing.name || existing.name === existing.id)) {
                existing.name = meta.name;
            }
            if (meta.email) existing.email = meta.email;
            if (meta.designation) existing.designation = meta.designation;
            participantDirectory.set(id, existing);
            return existing;
        };

        const addParticipantSource = (id, sourceKey, meta = {}) => {
            const entry = ensureParticipantEntry(id, meta);
            entry.sources.add(sourceKey);
        };

        const removeParticipantSource = (id, sourceKey) => {
            const entry = participantDirectory.get(id);
            if (!entry) return;
            entry.sources.delete(sourceKey);
            if (entry.sources.size === 0) {
                participantDirectory.delete(id);
            }
        };

        const getAllParticipantIds = () => Array.from(participantDirectory.keys());
        const getPendingParticipantCount = () => getAllParticipantIds().filter((id) => {
            const s = String(serverParticipantStatuses.get(id) || callDecisions.get(id) || '').toLowerCase();
            return s !== 'accepted' && s !== 'declined';
        }).length;

        const updateCallButtonState = () => {
            if (!callBtn) return;
            const noParticipants = getAllParticipantIds().length === 0;
            callBtn.disabled = noParticipants || isMeetRequestInFlight;
        };

        const spinnerHTML = (label) => `<i class="fa-solid fa-spinner fa-spin"></i> ${label}`;

        const setMeetRequestInFlight = (inFlight, triggerBtn = null) => {
            isMeetRequestInFlight = inFlight;
            if (createMeetBtn) {
                if (!inFlight) {
                    createMeetBtn.innerHTML = defaultCreateBtnHTML;
                    createMeetBtn.disabled = false;
                } else {
                    createMeetBtn.disabled = true;
                    if (triggerBtn === createMeetBtn) {
                        createMeetBtn.innerHTML = spinnerHTML('Creating...');
                    }
                }
            }
            if (callBtn) {
                const noParticipants = getAllParticipantIds().length === 0;
                callBtn.disabled = inFlight || noParticipants;
                if (!inFlight) {
                    callBtn.innerHTML = defaultCallBtnHTML;
                } else if (triggerBtn === callBtn) {
                    callBtn.innerHTML = spinnerHTML('Calling...');
                }
            }
        };

        const updateCallBanner = (state, pendingCount = null) => {
            if (!callBanner || !callBannerTitle || !callBannerText) return;
            if (state === 'hidden') {
                callBanner.classList.add('hidden');
                return;
            }
            callBanner.classList.remove('hidden');
            if (state === 'ringing') {
                callBannerTitle.textContent = 'Ringing participants…';
                if (typeof pendingCount === 'number') {
                    callBannerText.textContent = pendingCount > 0
                        ? `Awaiting response from ${pendingCount} participant${pendingCount === 1 ? '' : 's'}.`
                        : 'Waiting for responses...';
                } else {
                    callBannerText.textContent = 'Waiting for responses...';
                }
            } else if (state === 'complete') {
                callBannerTitle.textContent = 'Call notification complete';
                callBannerText.textContent = 'All participants have responded. You can close this panel.';
            }
        };

        const startRingTone = () => {
            try {
                stopRingTone();
                ringToneController = null;
            } catch (err) {
                console.warn('Unable to play ring tone', err);
            }
        };

        const stopRingTone = () => {
            if (ringToneController) {
                try { ringToneController.stop(); } catch (_) {}
                ringToneController = null;
            }
        };

        const syncCallBannerState = () => {
            const pending = getPendingParticipantCount();
            if (!callBanner) return;
            if (pending > 0) {
                updateCallBanner('ringing', pending);
            } else if (getAllParticipantIds().length) {
                updateCallBanner('complete');
                stopRingTone();
            } else {
                updateCallBanner('hidden');
                stopRingTone();
            }
        };

        const removeProject = (projectId) => {
            const entry = selectedProjects.get(projectId);
            if (!entry) return;
            entry.contributors.forEach((contrib) => {
                const pid = contrib.employee_id || contrib.employeeId;
                if (!pid) return;
                removeParticipantSource(pid, makeProjectSource(projectId));
            });
            selectedProjects.delete(projectId);
            renderSelectedProjects();
            updateCallButtonState();
        };

        const renderSelectedProjects = () => {
            if (!selectedProjectsWrap) return;
            selectedProjectsWrap.innerHTML = '';
            if (!selectedProjects.size) {
                if (selectedProjectsEmpty) {
                    selectedProjectsEmpty.style.display = '';
                    selectedProjectsWrap.appendChild(selectedProjectsEmpty);
                }
                return;
            }
            if (selectedProjectsEmpty) {
                selectedProjectsEmpty.style.display = 'none';
            }
            selectedProjects.forEach((entry, projectId) => {
                const chip = document.createElement('span');
                chip.className = 'meet-chip';
                chip.innerHTML = `
                    <span>${projectId}</span>
                    <button type="button" data-role="remove-project" data-project-id="${projectId}">&times;</button>
                `;
                const removeBtn = chip.querySelector('[data-role="remove-project"]');
                if (removeBtn) {
                    removeBtn.addEventListener('click', () => removeProject(projectId));
                }
                selectedProjectsWrap.appendChild(chip);
            });
        };

        const updateParticipantCount = () => {
            if (!employeeCountEl) return;
            const count = getAllParticipantIds().length;
            employeeCountEl.textContent = `${count} selected`;
        };

const getEmployeeMeta = (employeeId) => {
    const key = String(employeeId || '').trim().toUpperCase();
    return employeesDirectory.get(key) || null;
};

const loadEmployeeDirectory = async () => {
    if (employeesDirectory.size) return employeesDirectory;
    try {
        console.log('[MEET] Loading employee directory from:', `${API_BASE}/api/employees/all`);
        
        // Use cached fetch with timeout for employees - cache for 5 minutes
        const data = await Promise.race([
            cachedFetch('meet_employees_all', async () => {
                const resp = await fetch(`${API_BASE}/api/employees/all`, {
                    headers: { 'Accept': 'application/json' }
                });
                if (!resp.ok) {
                    throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
                }
                return await resp.json();
            }, TTL.LONG),
            new Promise((_, reject) => 
                setTimeout(() => reject(new Error('Request timeout after 15s')), 15000)
            )
        ]);
        
        console.log('[MEET] Employee data received:', data);
        
        if (data.success && Array.isArray(data.employees)) {
            data.employees.forEach((emp) => {
                const key = String(emp.employee_id || '').trim().toUpperCase();
                if (!key) return;
                employeesDirectory.set(key, {
                    name: `${emp.first_name || ''} ${emp.last_name || ''}`.trim() || key,
                    email: emp.email || '',
                    designation: emp.designation || '',
                    department: emp.department || ''
                });
            });
            console.log(`[MEET] Loaded ${employeesDirectory.size} employees into directory`);
        } else {
            console.warn('[MEET] Invalid employee data format:', data);
        }
    } catch (err) {
        console.error('[MEET] Failed to load employees directory:', err);
        showToast(`Unable to load employee directory: ${err.message}`, 'error');
    }
    return employeesDirectory;
};

const fetchProjects = async () => {
    if (!projectGrid) return;
    projectGrid.innerHTML = `
        <div class="placeholder-text" style="grid-column: 1 / -1;">
            <i class="fa-solid fa-spinner fa-spin" style="color:#007bff; margin-bottom: 0.5rem;"></i>
            <p>Loading projects...</p>
        </div>
    `;
    try {
        const resp = await fetch(`${API_BASE}/api/projects?sort=name`);
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok || !data.success) {
            throw new Error(data.error || `Failed to load projects (${resp.status})`);
        }
        projectsCache = data.projects || [];
        renderProjectCards();
    } catch (err) {
        console.error('Failed to load projects', err);
        if (projectGrid) {
            projectGrid.innerHTML = `
                <div class="placeholder-text" style="grid-column: 1 / -1; color:#dc2626;">
                    <i class="fa-solid fa-triangle-exclamation" style="margin-bottom: 0.5rem;"></i>
                    <p>${err?.message || 'Failed to load projects'}</p>
                </div>
            `;
        }
    }
};

const renderProjectCards = () => {
    if (!projectGrid) return;
    projectGrid.innerHTML = '';
    if (!projectsCache.length) {
        projectGrid.innerHTML = `
            <div class="placeholder-text" style="grid-column: 1 / -1;">
                <p>No projects available.</p>
            </div>
        `;
        return;
    }
    projectsCache.forEach((project) => {
        const projectId = (project.crc6f_projectid || '').toUpperCase();
        const card = document.createElement('div');
        card.className = 'meet-project-card';
        card.innerHTML = `
            <div>
                <p style="font-size:12px; color:#6b7280; margin:0;">${projectId}</p>
                <h4 style="margin:4px 0 6px;">${project.crc6f_projectname || 'Untitled project'}</h4>
                <p style="font-size:12px; color:#4b5563; margin:0 0 6px;">
                    ${project.crc6f_projectstatus || 'Status unknown'} · ${project.crc6f_noofcontributors || 0} contributors
                </p>
                ${project.crc6f_projectdescription ? `<p style="font-size:12px; color:#6b7280; margin:0;">${project.crc6f_projectdescription}</p>` : ''}
            </div>
            <button class="btn btn-sm btn-outline-primary" data-role="add-project" data-project-id="${projectId}">
                <i class="fa-solid fa-plus"></i> Add
            </button>
        `;
        projectGrid.appendChild(card);
    });

    projectGrid.querySelectorAll('button[data-role="add-project"]').forEach(btn => {
        btn.addEventListener('click', async (ev) => {
            const pid = ev.currentTarget.getAttribute('data-project-id');
            await handleAddProject(pid, ev.currentTarget);
        });
    });
};

const fetchProjectContributors = async (projectId) => {
    const safeId = encodeURIComponent(projectId);
    const resp = await fetch(`${API_BASE}/api/projects/${safeId}/contributors`);
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || data.success === false || data.ok === false) {
        throw new Error(data.error || 'Failed to load project contributors');
    }
    return data.contributors || data.items || [];
};

const handleAddProject = async (projectId, triggerBtn) => {
            const normalizedId = String(projectId || '').trim().toUpperCase();
            if (!normalizedId) {
                showToast('Invalid project ID', 'warning');
                return;
            }
            if (selectedProjects.has(normalizedId)) {
                showToast('Project already added', 'info');
                return;
            }
            if (triggerBtn) triggerBtn.disabled = true;
            try {
                await loadEmployeeDirectory();
                const contributors = await fetchProjectContributors(normalizedId);
                const projectMeta = projectsCache.find(p => String(p.crc6f_projectid || '').toUpperCase() === normalizedId) || { crc6f_projectid: normalizedId };
                selectedProjects.set(normalizedId, { ...projectMeta, contributors });
                contributors.forEach((contrib) => {
                    const empId = String(contrib.employee_id || contrib.crc6f_employeeid || '').trim().toUpperCase();
                    if (!empId) return;
                    const directoryMeta = getEmployeeMeta(empId) || {};
                    const name = contrib.employee_name || directoryMeta.name || empId;
                    const email = directoryMeta.email || '';
                    const designation = contrib.designation || directoryMeta.designation || '';
                    addParticipantSource(empId, makeProjectSource(normalizedId), { name, email, designation });
                });
                if (!contributors.length) {
                    showToast(`No contributors found for ${normalizedId}`, 'warning');
                } else {
                    showToast(`Added ${contributors.length} contributors from ${normalizedId}`, 'success');
                }
                renderParticipants();
                renderSelectedProjects();
                updateCallButtonState();
                if (projGroup) {
                    const projIdInput = document.getElementById('meet-project-id');
                    if (projIdInput) projIdInput.value = normalizedId;
                }
            } catch (err) {
                console.error('Failed to add project', err);
                showToast(err?.message || 'Failed to add project', 'error');
            } finally {
                if (triggerBtn) triggerBtn.disabled = false;
            }
        };

        const renderParticipantsEmptyState = () => {
            if (!participantsContainer || !participantsEmpty) return;
            participantsContainer.innerHTML = '';
            participantsEmpty.style.display = '';
            participantsContainer.appendChild(participantsEmpty);
        };

        const renderCallList = () => {
            if (!callList) return;
            callList.innerHTML = '';
            const ids = getAllParticipantIds();
            if (!ids.length) {
                callList.innerHTML = '<p class="placeholder-text">No participants added.</p>';
                updateCallBanner('hidden');
                return;
            }
            ids.forEach((id) => {
                const entry = participantDirectory.get(id) || { name: id };
                const statusKey = String(serverParticipantStatuses.get(id) || callDecisions.get(id) || '').toLowerCase();
                const row = document.createElement('div');
                row.className = 'meet-call-user';
                const statusHTML = statusKey === 'accepted'
                    ? '<span class="badge badge-success">Accepted</span>'
                    : statusKey === 'declined'
                        ? '<span class="badge badge-danger">Declined</span>'
                        : '<span class="badge badge-secondary">Ringing...</span>';
                row.innerHTML = `
                    <div class="meet-call-user-info">
                        <strong>${entry.name || id}</strong>
                        <span style="font-size:12px; color:#4b5563;">${entry.email || id}</span>
                        ${entry.designation ? `<span style="font-size:12px; color:#6b7280;">${entry.designation}</span>` : ''}
                    </div>
                    <div class="meet-call-user-actions">
                        ${statusHTML}
                    </div>
                `;
                callList.appendChild(row);
            });
            syncCallBannerState();
        };

        const handleCallDecision = (participantId, accepted) => {
            const entry = participantDirectory.get(participantId) || { name: participantId };
            callDecisions.set(participantId, accepted ? 'accepted' : 'declined');
            renderCallList();
            if (accepted) {
                openMeetLink(currentMeetInfo);
            } else {
                showToast(`${entry.name || participantId} declined the call`, 'warning');
            }
            syncCallBannerState();
        };

        const attachCallListEvents = () => {
            if (!callList) return;
        };

        const openCallModal = () => {
            if (!callModal) return;
            try {
                window.scrollTo(0, 0);
            } catch (_) {
            }
            callModal.classList.remove('hidden');
            callDecisions = new Map();
            renderCallList();
            updateCallBanner('ringing', getAllParticipantIds().length);
            startRingTone();
        };

        const closeCallModal = () => {
            if (!callModal) return;
            callModal.classList.add('hidden');
            updateCallBanner('hidden');
            stopRingTone();
        };

        const cancelOutgoingCall = () => {
            console.log('[MEET] cancelOutgoingCall called');
            try {
                const callId = currentCallId || currentMeetInfo?.call_id;
                const adminId = String(state?.user?.id || '').trim() || 'admin';
                const emitter = window.__emitMeetCallCancel;
                console.log('[MEET] Cancel call - callId:', callId, 'adminId:', adminId, 'emitter exists:', typeof emitter === 'function');
                if (callId && typeof emitter === 'function') {
                    emitter({ call_id: callId, admin_id: adminId });
                    console.log('[MEET] Emitted call:cancel event');
                }
            } catch (err) {
                console.warn('cancelOutgoingCall error', err);
            }
            try {
                currentCallId = null;
                serverParticipantStatuses = new Map();
                callDecisions = new Map();
                renderCallList();
            } catch (_) {}
            closeCallModal();
            console.log('[MEET] Modal closed');
        };

        const buildEmployeeCards = () => {
            employeeCards = Array.from(employeesDirectory.entries()).map(([id, meta]) => ({
                id,
                name: meta.name || id,
                email: meta.email || '',
                designation: meta.designation || '',
                department: meta.department || ''
            }));
            filteredEmployeeCards = employeeCards.slice();
        };

        const renderEmployeeGrid = () => {
            if (!employeeGrid) return;
            employeeGrid.innerHTML = '';
            if (!filteredEmployeeCards.length) {
                employeeGrid.innerHTML = `
                    <div class="placeholder-text" style="grid-column:1 / -1;">
                        <p>No employees match your search.</p>
                    </div>
                `;
                return;
            }
            filteredEmployeeCards.forEach((emp) => {
                const card = document.createElement('div');
                card.className = 'meet-employee-card';
                if (participantDirectory.has(emp.id)) {
                    card.classList.add('selected');
                }
                card.innerHTML = `
                    <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:8px;">
                        <div>
                            <h4>${emp.name || emp.id}</h4>
                            <p>${emp.id}</p>
                        </div>
                        ${emp.department ? `<span class="badge badge-light">${emp.department}</span>` : ''}
                    </div>
                    <p>${emp.email || 'No email on file'}</p>
                    ${emp.designation ? `<p style="color:#6b7280;">${emp.designation}</p>` : ''}
                `;
                card.addEventListener('click', () => toggleEmployeeSelection(emp.id));
                employeeGrid.appendChild(card);
            });
        };

        const toggleEmployeeSelection = (employeeId) => {
            const id = normalizeEmployeeId(employeeId);
            if (!id) return;
            const entry = participantDirectory.get(id);
            const manualKey = makeManualSource(id);
            if (entry && entry.sources.has(manualKey)) {
                removeParticipantSource(id, manualKey);
            } else {
                const meta = getEmployeeMeta(id) || { name: id, email: '', designation: '' };
                addParticipantSource(id, manualKey, meta);
            }
            renderParticipants();
            updateCallButtonState();
            renderEmployeeGrid();
        };

        const filterEmployeeGrid = (term) => {
            const q = String(term || '').trim().toLowerCase();
            if (!q) {
                filteredEmployeeCards = employeeCards.slice();
            } else {
                filteredEmployeeCards = employeeCards.filter((emp) => {
                    return [emp.name, emp.id, emp.department, emp.designation]
                        .some(field => String(field || '').toLowerCase().includes(q));
                });
            }
            renderEmployeeGrid();
        };

        const renderParticipants = () => {
            if (!participantsContainer) return;
            participantsContainer.innerHTML = '';
            const ids = getAllParticipantIds();
            if (!ids.length) {
                if (participantsEmpty) {
                    participantsEmpty.style.display = '';
                    participantsContainer.appendChild(participantsEmpty);
                }
                return;
            }
            if (participantsEmpty) {
                participantsEmpty.style.display = 'none';
            }
            ids.forEach(id => {
                const entry = participantDirectory.get(id) || { name: id };
                const chip = document.createElement('span');
                chip.className = 'meet-chip';
                chip.innerHTML = `
                    <span style="display:flex; flex-direction:column;">
                        <strong style="font-size:12px;">${entry.name || id}</strong>
                        <small style="font-size:11px; color:#4b5563;">${entry.email || id}</small>
                    </span>
                    <button type="button" data-role="remove" data-id="${id}">&times;</button>
                `;
                const removeBtn = chip.querySelector('[data-role="remove"]');
                if (removeBtn) {
                    removeBtn.addEventListener('click', () => {
                        // Remove all sources (manual + project)
                        const entrySources = participantDirectory.get(id)?.sources || [];
                        entrySources.forEach((sourceKey) => removeParticipantSource(id, sourceKey));
                        renderParticipants();
                        updateCallButtonState();
                    });
                }
                participantsContainer.appendChild(chip);
            });
            updateParticipantCount();
        };

        const addParticipant = (raw) => {
            const v = String(raw || '').trim().toUpperCase();
            if (!v) return;
            if (participantDirectory.has(v)) {
                showToast('Participant already added.', 'info');
                return;
            }
            const meta = getEmployeeMeta(v) || { name: v, email: '', designation: '' };
            addParticipantSource(v, makeManualSource(v), meta);
            renderParticipants();
            updateCallButtonState();
        };

        if (addMemberBtn && empIdInput) {
            addMemberBtn.addEventListener('click', () => {
                addParticipant(empIdInput.value);
                empIdInput.value = '';
                empIdInput.focus();
            });
            empIdInput.addEventListener('keydown', (ev) => {
                if (ev.key === 'Enter') {
                    ev.preventDefault();
                    addParticipant(empIdInput.value);
                    empIdInput.value = '';
                }
            });
        }

        const updateAudienceVisibility = () => {
            if (!audienceSelect || !empGroup || !projGroup) return;
            const val = audienceSelect.value;
            if (val === 'employees') {
                empGroup.style.display = '';
                projGroup.style.display = 'none';
            } else if (val === 'project') {
                empGroup.style.display = 'none';
                projGroup.style.display = '';
            } else {
                empGroup.style.display = '';
                projGroup.style.display = '';
            }
        };

        const updateTimeInputs = () => {
            if (!startNowCheckbox || !startInput || !endInput) return;
            const disabled = startNowCheckbox.checked;
            startInput.disabled = disabled;
            endInput.disabled = disabled;
        };

        const convertLocalDateTimeToISO = (value) => {
            if (!value) return null;
            const dt = new Date(value);
            if (Number.isNaN(dt.getTime())) return null;
            return dt.toISOString();
        };

        const buildMeetPayload = () => {
            const audience = (audienceSelect?.value || 'employees').toLowerCase();
            const participantIds = getAllParticipantIds();
            const participantEmails = participantIds
                .map((id) => (participantDirectory.get(id)?.email || '').trim())
                .filter(Boolean);
            let projectIdValue = null;
            if (audience !== 'employees') {
                const manualProject = (projectIdInput?.value || '').trim().toUpperCase();
                if (manualProject) {
                    projectIdValue = manualProject;
                } else if (selectedProjects.size === 1) {
                    projectIdValue = selectedProjects.keys().next().value;
                }
            }

            const payload = {
                title: (titleInput?.value || 'Team Sync').trim() || 'Team Sync',
                description: (descriptionInput?.value || '').trim(),
                audience_type: audience,
                employee_ids: participantIds,
                employee_emails: participantEmails,
                project_id: projectIdValue,
                start_time: null,
                end_time: null,
                timezone: (timezoneInput?.value || tz || 'UTC').trim() || 'UTC',
                admin_id: (String(state?.user?.id || '').trim() || 'admin'),
            };

            if (!startNowCheckbox?.checked) {
                payload.start_time = convertLocalDateTimeToISO(startInput?.value);
                payload.end_time = convertLocalDateTimeToISO(endInput?.value);
            }

            return payload;
        };

        const renderMeetResult = (state, data) => {
            if (!resultEl) return;
            if (state === 'loading') {
                resultEl.innerHTML = `
                    <div class="placeholder-text">
                        <i class="fa-solid fa-spinner fa-spin" style="color:#2563eb; margin-bottom:4px;"></i>
                        <p>Creating Google Meet...</p>
                    </div>
                `;
                return;
            }

            if (state === 'error') {
                resultEl.innerHTML = `
                    <div style="background:#fef2f2; border:1px solid #fecaca; border-radius:8px; padding:12px;">
                        <strong style="color:#b91c1c;">Failed to create Google Meet.</strong>
                        <p style="margin:6px 0 0; color:#991b1b; font-size:13px;">${data || 'Something went wrong. Please try again.'}</p>
                    </div>
                `;
                return;
            }

            if (state === 'success') {
                const joinLink = data?.meet_url || data?.html_link;
                resultEl.innerHTML = `
                    <div style="background:#f0fdf4; border:1px solid #bbf7d0; border-radius:8px; padding:12px;">
                        <p style="margin:0; font-weight:600; color:#166534;">${data?.title || 'Google Meet is ready'}</p>
                        ${joinLink ? `<p style="margin:4px 0 0;"><a href="${joinLink}" target="_blank" rel="noopener" style="color:#15803d;">Open meeting link</a></p>` : ''}
                    </div>
                `;
            }
        };

        const openMeetLink = (info) => {
            const joinLink = info?.meet_url || info?.html_link;
            if (!joinLink) {
                showToast('Meeting link is not available yet.', 'warning');
                return;
            }
            window.open(joinLink, '_blank', 'noopener');
        };

        const startMeetFlow = async ({ openCallModalAfter = false, triggerBtn = null } = {}) => {
            const participantIds = getAllParticipantIds();
            if (!participantIds.length) {
                showToast('Add at least one participant before starting a call.', 'warning');
                return;
            }

            const payload = buildMeetPayload();
            renderMeetResult('loading');
            setMeetRequestInFlight(true, triggerBtn);
            try {
                const resp = await fetch(`${API_BASE}/api/meet/start`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                });
                const data = await resp.json().catch(() => ({}));
                if (!resp.ok || data.success === false) {
                    throw new Error(data.error || `Failed to create Google Meet (${resp.status})`);
                }
                currentMeetInfo = data;
                currentCallId = data?.call_id || null;
                callDecisions = new Map();
                renderCallList();
                renderMeetResult('success', data);
                showToast('Google Meet created successfully.', 'success');
                if (openCallModalAfter) {
                    openMeetLink(data);
                    openCallModal();
                    showToast('Ringing participants...', 'info');
                }
            } catch (err) {
                console.error('Failed to start Google Meet', err);
                showToast(err?.message || 'Failed to create Google Meet', 'error');
                renderMeetResult('error', err?.message);
            } finally {
                setMeetRequestInFlight(false);
                updateCallButtonState();
            }
        };

        if (audienceSelect) {
            audienceSelect.addEventListener('change', updateAudienceVisibility);
            updateAudienceVisibility();
        }

        if (startNowCheckbox) {
            startNowCheckbox.addEventListener('change', updateTimeInputs);
            updateTimeInputs();
        }

        if (!form || !resultEl) return;

        attachCallListEvents();

        // Expose participant update handler for socket events from index.js
        const applyServerParticipantUpdate = (payload) => {
            try {
                if (!payload || !Array.isArray(payload.participants)) return;
                serverParticipantStatuses = new Map();
                (payload.participants || []).forEach((p) => {
                    const rawId = normalizeEmployeeId(p.employee_id || '');
                    const emailKey = String(p.email || '').trim().toUpperCase();
                    const idKey = rawId || emailKey;
                    if (!idKey) return;
                    const status = String(p.status || 'ringing').toLowerCase();
                    serverParticipantStatuses.set(idKey, status);
                    if (status === 'accepted' || status === 'declined') {
                        callDecisions.set(idKey, status);
                    }
                });
                renderCallList();
                syncCallBannerState();
            } catch (err) {
                console.error('applyServerParticipantUpdate error', err);
                try { closeCallModal(); } catch (_) {}
            }
        };

        // Expose handler globally so index.js socket listener can call it
        try {
            window.__onParticipantUpdate = applyServerParticipantUpdate;
        } catch (_) {}

        // Cleanup helper so router can hide/stop Meet UI artifacts when navigating away
        window.__cleanupMeetUI = () => {
            try {
                if (typeof stopRingTone === 'function') stopRingTone();
                if (typeof closeCallModal === 'function') closeCallModal();
                if (callBanner) callBanner.classList.add('hidden');
                callDecisions = new Map();
                serverParticipantStatuses = new Map();
                // Remove modal from document.body to prevent it from persisting across pages
                if (callModal && callModal.parentElement === document.body) {
                    callModal.remove();
                }
            } catch (err) {
                console.warn('cleanupMeetUI error', err);
            }
            try {
                window.__onParticipantUpdate = null;
            } catch (_) {}
        };

        if (callModal) {
            // Close on backdrop click
            callModal.addEventListener('click', (ev) => {
                if (ev.target === callModal) {
                    closeCallModal();
                }
            });

            // Event delegation for close/cancel buttons (works even after modal is moved to body)
            callModal.addEventListener('click', (ev) => {
                const target = ev.target;
                const closeBtn = target.closest('#meet-call-close');
                const cancelBtn = target.closest('#meet-call-cancel');
                console.log('[MEET] Modal click - target:', target.tagName, target.id, 'closeBtn:', !!closeBtn, 'cancelBtn:', !!cancelBtn);
                if (closeBtn || cancelBtn) {
                    ev.preventDefault();
                    ev.stopPropagation();
                    if (cancelBtn) {
                        console.log('[MEET] Cancel button clicked via delegation');
                        cancelOutgoingCall();
                    } else {
                        console.log('[MEET] Close button clicked via delegation');
                        closeCallModal();
                    }
                }
            });
        }

        // Direct event listeners as fallback
        if (callCloseBtn) {
            callCloseBtn.addEventListener('click', (ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                closeCallModal();
            });
        }
        if (callCancelBtn) {
            console.log('[MEET] Cancel button found, attaching direct listener');
            callCancelBtn.addEventListener('click', (ev) => {
                console.log('[MEET] Cancel button direct click');
                ev.preventDefault();
                ev.stopPropagation();
                cancelOutgoingCall();
            });
        } else {
            console.warn('[MEET] Cancel button NOT found in DOM');
        }

        if (form) {
            form.addEventListener('submit', (ev) => {
                ev.preventDefault();
                startMeetFlow({ openCallModalAfter: false, triggerBtn: createMeetBtn });
            });
        }

        if (callBtn) {
            callBtn.addEventListener('click', () => {
                startMeetFlow({ openCallModalAfter: true, triggerBtn: callBtn });
            });
        }

        if (employeeSearchInput) {
            employeeSearchInput.addEventListener('input', (ev) => {
                filterEmployeeGrid(ev.target.value);
            });
        }

        fetchProjects();
        renderParticipants();
        renderSelectedProjects();
        updateCallButtonState();

        // Load employee directory and render the employee grid
        (async () => {
            try {
                await loadEmployeeDirectory();
                buildEmployeeCards();
                renderEmployeeGrid();
                if (employeeCountEl) {
                    employeeCountEl.textContent = `${employeesDirectory.size} employees`;
                }
            } catch (err) {
                console.error('Failed to load employee directory for grid', err);
                if (employeeGrid) {
                    employeeGrid.innerHTML = `
                        <div class="placeholder-text" style="grid-column:1 / -1; color:#dc2626;">
                            <p>Failed to load employees. Please refresh.</p>
                        </div>
                    `;
                }
            }
        })();
    }, 0);
};

const loadInboxLeaves = async () => {
    const isAdmin = isAdminUser();
    const canViewTeamQueues = isManagerOrAdmin();
    const listContainer = document.querySelector('.inbox-list');

    if (!listContainer) return;

    listContainer.innerHTML = `
        <div class="placeholder-text">
            <i class="fa-solid fa-spinner fa-spin fa-3x" style="color:#ddd; margin-bottom: 1rem;"></i>
            <p>Loading leaves...</p>
        </div>
    `;

    try {
        // Fetch all employees to map IDs to names
        const allEmployees = await listEmployees(1, 5000);
        const employeeMap = {};
        (allEmployees.items || []).forEach(emp => {
            if (emp.employee_id) {
                employeeMap[emp.employee_id.toUpperCase()] = `${emp.first_name || ''} ${emp.last_name || ''}`.trim();
            }
        });

        let leaves = [];
        let compAll = [];
        try {
            compAll = await fetchCompOffRequests();
        } catch (compErr) {
            console.warn('Failed to fetch comp off requests for inbox leaves:', compErr);
            compAll = [];
        }
        // Normalize comp off requests into leave-like objects
        const normalizeComp = (r) => ({
            leave_id: `CO-${r.id}`,
            employee_id: r.employeeId,
            leave_type: 'Comp Off',
            start_date: r.dateWorked,
            end_date: r.dateWorked,
            total_days: 1,
            status: r.status || 'Pending',
            paid_unpaid: 'Paid',
            rejection_reason: r.rejectionReason || '',
            _source: 'compoff',
            _raw: r,
        });

        const isCompOffLeaveType = (leaveType) => {
            const lt = String(leaveType || '').trim().toLowerCase();
            return lt === 'co' || lt === 'comp off' || lt === 'compoff' || lt === 'compensatory off' || lt.includes('comp');
        };

        if (currentInboxTab === 'awaiting' && canViewTeamQueues) {
            // Fetch all pending leaves for admin
            const pendingLeaves = await fetchPendingLeaves();
            const compPending = compAll.filter(r => (r.status || 'pending').toLowerCase() === 'pending').map(normalizeComp);
            leaves = (pendingLeaves || []);  // Backend now includes comp-off requests
            console.log(`📋 Loaded ${leaves.length} pending leave requests`);
        } else if (currentInboxTab === 'completed' && isAdmin) {
            // For admin in completed tab, fetch all employees' completed leaves
            try {
                const allEmployees = await listEmployees(1, 5000);
                const employeeIds = (allEmployees.items || []).map(emp => emp.employee_id).filter(Boolean);

                console.log(`📋 Fetching completed leaves for ${employeeIds.length} employees...`);

                const allLeavesPromises = employeeIds.map(empId =>
                    fetchEmployeeLeaves(empId, true).catch(err => {
                        console.warn(`Failed to fetch leaves for ${empId}:`, err);
                        return [];
                    })
                );

                const allLeavesArrays = await Promise.all(allLeavesPromises);
                const allLeaves = allLeavesArrays.flat();
                const compCompleted = compAll.filter(r => ['approved', 'rejected'].includes((r.status || '').toLowerCase())).map(normalizeComp);

                // Filter for approved/rejected only
                leaves = allLeaves.filter(l =>
                    (l.status?.toLowerCase() === 'approved' || l.status?.toLowerCase() === 'rejected')
                ).concat(compCompleted);

                console.log(`📋 Loaded ${leaves.length} completed leaves from all employees`);
            } catch (err) {
                console.error('Error fetching all employees completed leaves:', err);
                leaves = [];
            }
        } else {
            // Fetch current user's leaves
            const empId = await resolveCurrentEmployeeId();
            const allLeaves = await fetchEmployeeLeaves(empId, currentInboxTab === 'completed');

            if (currentInboxTab === 'requests') {
                const compMine = compAll.filter(r => String(r.employeeId).toUpperCase() === String(empId).toUpperCase() && (r.status || 'pending').toLowerCase() === 'pending').map(normalizeComp);
                leaves = (allLeaves || []).filter(l => l.status?.toLowerCase() === 'pending');  // Backend includes comp-off
            } else if (currentInboxTab === 'completed') {
                const compMineDone = compAll.filter(r => String(r.employeeId).toUpperCase() === String(empId).toUpperCase() && ['approved', 'rejected'].includes((r.status || '').toLowerCase())).map(normalizeComp);
                leaves = (allLeaves || []).filter(l =>
                    (l.status?.toLowerCase() === 'approved' || l.status?.toLowerCase() === 'rejected')
                ).concat(compMineDone);
            }

            console.log(`📋 Loaded ${leaves.length} ${currentInboxTab} leaves for user`);
        }

        // Sort leaves by start_date descending (latest first)
        leaves.sort((a, b) => {
            const dateA = new Date(a.start_date || '1900-01-01');
            const dateB = new Date(b.start_date || '1900-01-01');
            return dateB - dateA; // Descending order (newest first)
        });
        console.log(`✅ Sorted ${leaves.length} leaves by date (latest first)`);

        if (leaves.length === 0) {
            listContainer.innerHTML = `
                <div class="placeholder-text">
                    <i class="fa-solid fa-envelope-open fa-3x" style="color:#ddd; margin-bottom: 1rem;"></i>
                    <p>No requests found.</p>
                </div>
            `;
            return;
        }

        // Render leave cards
        const leaveCards = leaves.map(leave => {
            const leaveId = leave.leave_id;
            const employeeId = leave.employee_id;
            const employeeName = employeeMap[employeeId?.toUpperCase()] || employeeId;
            const leaveType = leave.leave_type;
            const startDate = leave.start_date;
            const endDate = leave.end_date;
            const totalDays = leave.total_days;
            const status = leave.status || 'Pending';
            const paidUnpaid = leave.paid_unpaid || 'Paid';
            const rejectionReason = leave.rejection_reason || leave.crc6f_rejectionreason || '';
            const approvalComments = leave.approval_comments || leave.approvalComments || leave.crc6f_approvalcomments || '';
            const approvalCommentsText = String(approvalComments || '').trim();
            const leaveReason = leave.reason || leave.rejection_reason || leave.crc6f_rejectionreason || '';

            // Debug logging for rejected leaves
            if (status.toLowerCase() === 'rejected') {
                console.log(`🔍 Rejected leave ${leaveId}:`, {
                    status,
                    rejection_reason: rejectionReason,
                    fullLeaveData: leave
                });
            }

            const statusClass = status.toLowerCase();
            const showActions = currentInboxTab === 'awaiting' && isAdmin;
            const isRejected = status.toLowerCase() === 'rejected';
            const isApproved = status.toLowerCase() === 'approved';
            const isCompOff = leave._source === 'compoff' || leave.request_type === 'compoff';

            return `
                <div class="inbox-item">
                    <div class="inbox-item-header">
                        <div>
                            <h4 style="font-size: 1.25rem; margin-bottom: 4px;">${employeeName}</h4>
                            <span class="inbox-item-meta" style="font-size: 0.875rem; color: #666;">${leaveType} • ${employeeId}</span>
                        </div>
                        <span class="status-badge ${statusClass}">${status}</span>
                    </div>
                    <div class="inbox-item-body">
                        <p><strong>Period:</strong> ${startDate} to ${endDate} (${totalDays} day${totalDays > 1 ? 's' : ''})</p>
                        <p><strong>Type:</strong> ${paidUnpaid}</p>
                        <p><strong>Leave ID:</strong> ${leaveId}</p>
                        ${leaveReason ? `<p><strong>Reason:</strong> ${leaveReason}</p>` : ''}
                        ${isRejected && rejectionReason ? `
                            <div class="rejection-reason-box" style="background: #fff3cd; border-left: 4px solid #ffc107; padding: 12px; margin-top: 12px; border-radius: 4px;">
                                <strong style="color: #856404;"><i class="fa-solid fa-info-circle"></i> Rejection Reason:</strong>
                                <p style="margin: 8px 0 0 0; color: #856404;">${rejectionReason}</p>
                            </div>
                        ` : ''}
                        ${isApproved && !isCompOff ? `
                            <div class="approval-comments-box" style="background: #fff3cd; border-left: 4px solid #34c759; padding: 12px; margin-top: 12px; border-radius: 4px;">
                                <strong style="color: #2f855a;"><i class="fa-solid fa-comment"></i> Approval Comments:</strong>
                                <p style="margin: 8px 0 0 0; color: #2f855a;">${approvalCommentsText || 'No comments added.'}</p>
                            </div>
                        ` : ''}
                    </div>
                    ${showActions ? `
                        <div class="inbox-item-actions">
                            <button class="btn btn-success btn-sm inbox-approve-btn" data-leave-id="${leaveId}" data-source="${isCompOff ? 'compoff' : 'leave'}" data-compoff-id="${isCompOff ? (leave._raw?.id || leave.compoff_id || leave.id || '') : ''}">
                                <i class="fa-solid fa-check"></i> Approve
                            </button>
                            <button class="btn btn-danger btn-sm inbox-reject-btn" data-leave-id="${leaveId}" data-source="${isCompOff ? 'compoff' : 'leave'}" data-compoff-id="${isCompOff ? (leave._raw?.id || leave.compoff_id || leave.id || '') : ''}">
                                <i class="fa-solid fa-times"></i> Reject
                            </button>
                        </div>
                    ` : ''}
                </div>
            `;
        }).join('');

        listContainer.innerHTML = leaveCards;

        // Add event listeners for approve/reject buttons
        if (currentInboxTab === 'awaiting' && isAdmin) {
            document.querySelectorAll('.inbox-approve-btn').forEach(btn => {
                btn.addEventListener('click', async (e) => {
                    const src = e.currentTarget.getAttribute('data-source');
                    if (src === 'compoff') {
                        const requestId = e.currentTarget.getAttribute('data-compoff-id');
                        await handleCompOffApprove(requestId);
                    } else {
                        const leaveId = e.currentTarget.getAttribute('data-leave-id');
                        await handleInboxApprove(leaveId);
                    }
                });
            });

            document.querySelectorAll('.inbox-reject-btn').forEach(btn => {
                btn.addEventListener('click', async (e) => {
                    const src = e.currentTarget.getAttribute('data-source');
                    if (src === 'compoff') {
                        const requestId = e.currentTarget.getAttribute('data-compoff-id');
                        showCompOffRejectModal(requestId);
                    } else {
                        const leaveId = e.currentTarget.getAttribute('data-leave-id');
                        showInboxRejectModal(leaveId);
                    }
                });
            });
        }

    } catch (err) {
        console.error('❌ Error loading inbox leaves:', err);
        listContainer.innerHTML = `
            <div class="placeholder-text">
                <i class="fa-solid fa-exclamation-triangle fa-3x" style="color:#e74c3c; margin-bottom: 1rem;"></i>
                <p>Error loading leave requests.</p>
            </div>
        `;
    }
};


const loadInboxAttendance = async () => {
    const isAdmin = isAdminUser();
    const canViewTeamQueues = isManagerOrAdmin();
    const listContainer = document.querySelector('.inbox-list');

    if (!listContainer) return;

    listContainer.innerHTML = `
        <div class="placeholder-text">
            <i class="fa-solid fa-spinner fa-spin fa-3x" style="color:#ddd; margin-bottom: 1rem;"></i>
            <p>Loading attendance submissions...</p>
        </div>
    `;

    try {
        const allEmployees = await listEmployees(1, 5000);
        const employeeMap = {};
        (allEmployees.items || []).forEach(emp => {
            if (emp.employee_id) {
                employeeMap[String(emp.employee_id).toUpperCase()] = `${emp.first_name || ''} ${emp.last_name || ''}`.trim();
            }
        });

        const params = new URLSearchParams();
        if (currentInboxTab === 'awaiting' && canViewTeamQueues) {
            params.set('status', 'pending');
        } else if (!isAdmin) {
            const empId = await resolveCurrentEmployeeId();
            if (!empId) {
                listContainer.innerHTML = `
                    <div class="placeholder-text">
                        <i class="fa-solid fa-user-slash fa-3x" style="color:#ddd; margin-bottom: 1rem;"></i>
                        <p>Unable to resolve your employee ID.</p>
                    </div>
                `;
                return;
            }
            params.set('employee_id', empId);
            if (currentInboxTab === 'requests') {
                params.set('status', 'pending');
            }
        }

        const qs = params.toString() ? `?${params.toString()}` : '';
        const resp = await fetch(`${apiBase}/api/attendance/submissions${qs}`);
        const data = await resp.json().catch(() => ({ success: false }));

        if (!resp.ok || !data.success) {
            throw new Error(data.error || `Failed to fetch attendance submissions (${resp.status})`);
        }

        let items = data.items || [];
        if (currentInboxTab === 'completed') {
            items = items.filter(r => ['approved', 'rejected'].includes(String(r.status || '').toLowerCase()));
        }

        items.sort((a, b) => new Date(b.created_date || 0) - new Date(a.created_date || 0));

        if (!items.length) {
            listContainer.innerHTML = `
                <div class="placeholder-text">
                    <i class="fa-solid fa-envelope-open fa-3x" style="color:#ddd; margin-bottom: 1rem;"></i>
                    <p>No attendance submissions found.</p>
                </div>
            `;
            return;
        }

        const formatPeriod = (year, month) => {
            if (!year || !month) return '-';
            const d = new Date(Number(year), Number(month) - 1, 1);
            if (Number.isNaN(d.getTime())) return `${month}/${year}`;
            return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
        };

        const cards = items.map(item => {
            const employeeId = String(item.employee_id || '').toUpperCase();
            const employeeName = employeeMap[employeeId] || employeeId;
            const status = String(item.status || 'pending');
            const statusClass = status.toLowerCase();
            const showActions = isAdmin && currentInboxTab === 'awaiting';
            const leaveTypes = Array.isArray(item.leave_types) ? item.leave_types : [];
            const leaveSummary = leaveTypes.length
                ? leaveTypes.map(x => `${x.type}: ${x.days}`).join(', ')
                : 'None';

            return `
                <div class="inbox-item">
                    <div class="inbox-item-header">
                        <div>
                            <h4 style="font-size: 1.25rem; margin-bottom: 4px;">${employeeName}</h4>
                            <span class="inbox-item-meta" style="font-size: 0.875rem; color: #666;">Attendance Report � ${employeeId}</span>
                        </div>
                        <span class="status-badge ${statusClass}">${status.charAt(0).toUpperCase() + status.slice(1)}</span>
                    </div>
                    <div class="inbox-item-body">
                        <p><strong>Period:</strong> ${formatPeriod(item.year, item.month)}</p>
                        <p><strong>Days Checked In:</strong> ${item.days_checked_in ?? 0}</p>
                        <p><strong>Half Days:</strong> ${item.halfdays ?? 0}</p>
                        <p><strong>Leaves:</strong> ${leaveSummary}</p>
                        <p><strong>Submitted:</strong> ${item.created_date || '-'}</p>
                        ${statusClass === 'rejected' && item.rejection_reason ? `
                            <div class="rejection-reason-box" style="background: #fff3cd; border-left: 4px solid #ffc107; padding: 12px; margin-top: 12px; border-radius: 4px;">
                                <strong style="color: #856404;"><i class="fa-solid fa-info-circle"></i> Rejection Reason:</strong>
                                <p style="margin: 8px 0 0 0; color: #856404;">${item.rejection_reason}</p>
                            </div>
                        ` : ''}
                    </div>
                    ${showActions ? `
                        <div class="inbox-item-actions">
                            <button class="btn btn-success btn-sm attendance-approve-btn" data-marker-id="${item.marker_id}">
                                <i class="fa-solid fa-check"></i> Approve
                            </button>
                            <button class="btn btn-danger btn-sm attendance-reject-btn" data-marker-id="${item.marker_id}">
                                <i class="fa-solid fa-times"></i> Reject
                            </button>
                        </div>
                    ` : ''}
                </div>
            `;
        }).join('');

        listContainer.innerHTML = cards;

        if (isAdmin && currentInboxTab === 'awaiting') {
            document.querySelectorAll('.attendance-approve-btn').forEach(btn => {
                btn.addEventListener('click', async (e) => {
                    const markerId = e.currentTarget.getAttribute('data-marker-id');
                    await handleAttendanceApprove(markerId);
                });
            });

            document.querySelectorAll('.attendance-reject-btn').forEach(btn => {
                btn.addEventListener('click', async (e) => {
                    const markerId = e.currentTarget.getAttribute('data-marker-id');
                    await handleAttendanceReject(markerId);
                });
            });
        }
    } catch (err) {
        console.error('? Error loading attendance submissions:', err);
        listContainer.innerHTML = `
            <div class="placeholder-text">
                <i class="fa-solid fa-exclamation-triangle fa-3x" style="color:#e74c3c; margin-bottom: 1rem;"></i>
                <p>Error loading attendance submissions.</p>
            </div>
        `;
    }
};
const loadInboxTimesheets = async () => {
    const isAdmin = isAdminUser();
    const canViewTeamQueues = isManagerOrAdmin();
    const listContainer = document.querySelector('.inbox-list');

    if (!listContainer) return;

    listContainer.innerHTML = `
        <div class="placeholder-text">
            <i class="fa-solid fa-spinner fa-spin fa-3x" style="color:#ddd; margin-bottom: 1rem;"></i>
            <p>Loading timesheet submissions...</p>
        </div>
    `;

    try {
        // Fetch all employees to map IDs to names
        const allEmployees = await listEmployees(1, 5000);
        const employeeMap = {};
        (allEmployees.items || []).forEach(emp => {
            if (emp.employee_id) {
                employeeMap[emp.employee_id.toUpperCase()] = `${emp.first_name || ''} ${emp.last_name || ''}`.trim();
            }
        });

        // Build query string based on role and tab
        const params = new URLSearchParams();
        if (currentInboxTab === 'awaiting' && canViewTeamQueues) {
            params.set('status', 'pending');
        } else if (!isAdmin) {
            const empId = await resolveCurrentEmployeeId();
            if (!empId) {
                listContainer.innerHTML = `
                    <div class="placeholder-text">
                        <i class="fa-solid fa-user-slash fa-3x" style="color:#ddd; margin-bottom: 1rem;"></i>
                        <p>Unable to resolve your employee ID.</p>
                    </div>
                `;
                return;
            }
            params.set('employee_id', empId);
            if (currentInboxTab === 'requests') {
                params.set('status', 'pending');
            }
        }

        const qs = params.toString() ? `?${params.toString()}` : '';
        const resp = await fetch(`${apiBase}/api/time-tracker/timesheet/submissions${qs}`);
        const data = await resp.json().catch(() => ({ success: false }));

        if (!resp.ok || !data.success) {
            throw new Error(data.error || `Failed to fetch timesheet submissions (${resp.status})`);
        }

        let items = data.items || [];

        // For completed tab, keep only Accepted/Rejected
        if (currentInboxTab === 'completed') {
            items = items.filter(r =>
                r.status?.toLowerCase() === 'accepted' || r.status?.toLowerCase() === 'rejected'
            );
        }

        // Sort by submitted date (latest first)
        items.sort((a, b) => new Date(b.submitted_at || 0) - new Date(a.submitted_at || 0));

        if (items.length === 0) {
            listContainer.innerHTML = `
                <div class="placeholder-text">
                    <i class="fa-solid fa-envelope-open fa-3x" style="color:#ddd; margin-bottom: 1rem;"></i>
                    <p>No timesheet submissions found.</p>
                </div>
            `;
            return;
        }

        // Preferred view: group into weekly Mon-Fri cards with day/task/hours table
        const toYmd = (v) => {
            const s = String(v || '').slice(0, 10);
            return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
        };
        const weekStartMon = (ymd) => {
            const d = new Date(`${ymd}T00:00:00`);
            if (Number.isNaN(d.getTime())) return '';
            const day = d.getDay();
            const delta = day === 0 ? -6 : (1 - day);
            d.setDate(d.getDate() + delta);
            return d.toISOString().slice(0, 10);
        };
        const plusDays = (ymd, n) => {
            const d = new Date(`${ymd}T00:00:00`);
            if (Number.isNaN(d.getTime())) return ymd;
            d.setDate(d.getDate() + n);
            return d.toISOString().slice(0, 10);
        };
        const isMonToFri = (ymd) => {
            const d = new Date(`${ymd}T00:00:00`);
            if (Number.isNaN(d.getTime())) return false;
            const day = d.getDay();
            return day >= 1 && day <= 5;
        };
        const dayLabel = (ymd) => {
            const d = new Date(`${ymd}T00:00:00`);
            if (Number.isNaN(d.getTime())) return ymd;
            return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: '2-digit' });
        };

        const grouped = new Map();
        items.forEach((entry) => {
            const date = toYmd(entry.date);
            if (!date || !isMonToFri(date)) return;

            const employeeId = String(entry.employee_id || '').trim();
            if (!employeeId) return;
            const status = entry.status || 'Pending';
            const statusClass = String(status).toLowerCase();
            const weekStart = weekStartMon(date);
            const key = `${employeeId}|${statusClass}|${weekStart}`;

            if (!grouped.has(key)) {
                grouped.set(key, {
                    first_id: String(entry.id || ''),
                    employee_id: employeeId,
                    employee_name: employeeMap[employeeId.toUpperCase()] || entry.employee_name || employeeId,
                    status,
                    statusClass,
                    week_start: weekStart,
                    week_end: plusDays(weekStart, 4),
                    submitted_at: entry.submitted_at || '',
                    decided_at: entry.decided_at || '',
                    reject_comment: entry.reject_comment || '',
                    rows: []
                });
            }

            const g = grouped.get(key);
            if (entry.submitted_at && (!g.submitted_at || entry.submitted_at > g.submitted_at)) g.submitted_at = entry.submitted_at;
            if (entry.decided_at && (!g.decided_at || entry.decided_at > g.decided_at)) g.decided_at = entry.decided_at;
            if (!g.reject_comment && entry.reject_comment) g.reject_comment = entry.reject_comment;

            const hoursValueRaw = (entry.hours_worked !== undefined && entry.hours_worked !== null)
                ? Number(entry.hours_worked)
                : (entry.seconds ? (Number(entry.seconds) / 3600) : 0);
            const hoursValue = Number.isFinite(hoursValueRaw) ? hoursValueRaw : 0;

            g.rows.push({
                date,
                day_text: dayLabel(date),
                task_text: entry.task_name || entry.task_id || '-',
                hours_value: hoursValue
            });
        });

        const groupedItems = Array.from(grouped.values())
            .filter(g => Array.isArray(g.rows) && g.rows.length)
            .sort((a, b) => new Date(b.submitted_at || 0) - new Date(a.submitted_at || 0));

        if (groupedItems.length) {
            const cards = groupedItems.map(group => {
                const showActions = isAdmin && currentInboxTab === 'awaiting';
                const isRejected = group.statusClass === 'rejected';

                const mergedRowsMap = new Map();
                group.rows.forEach((r) => {
                    const normalizedTask = String(r.task_text || '-').trim().toLowerCase();
                    const mergeKey = `${r.date}|${normalizedTask}`;
                    if (!mergedRowsMap.has(mergeKey)) {
                        mergedRowsMap.set(mergeKey, {
                            ...r,
                            merge_count: 1,
                        });
                        return;
                    }

                    const merged = mergedRowsMap.get(mergeKey);
                    merged.hours_value += Number(r.hours_value || 0);
                    merged.merge_count += 1;
                });

                const sortedRows = Array.from(mergedRowsMap.values())
                    .sort((a, b) => (a.date === b.date ? a.task_text.localeCompare(b.task_text) : a.date.localeCompare(b.date)));
                
                // Calculate daily totals and weekly total
                const dailyTotals = {};
                let weeklyTotal = 0;

                
                sortedRows.forEach((r) => {
                    const day = r.day_text;
                    const hours = Number(r.hours_value || 0);
                    if (!dailyTotals[day]) dailyTotals[day] = 0;
                    dailyTotals[day] += hours;
                    weeklyTotal += hours;
                });
                
                // Generate rows with daily subtotals
                const rowsHtmlArray = [];
                let currentDay = null;
                
                sortedRows.forEach((r, idx) => {
                    const mergedBadge = r.merge_count > 1
                        ? `<span style="margin-left:6px; padding:1px 6px; border-radius:999px; font-size:11px; background:#eef2ff; color:#3730a3; font-weight:600;">${r.merge_count} records combined</span>`
                        : '';
                    
                    rowsHtmlArray.push(`<tr><td style="padding:8px 10px; border-bottom:1px solid #eef2f7;">${r.day_text}</td><td style="padding:8px 10px; border-bottom:1px solid #eef2f7;">${r.task_text}${mergedBadge}</td><td style="padding:8px 10px; border-bottom:1px solid #eef2f7; text-align:right;">${Number(r.hours_value || 0).toFixed(2)}</td></tr>`);
                    
                    // Add subtotal if day changes or last row
                    const isLastRow = idx === sortedRows.length - 1;
                    const nextDay = !isLastRow ? sortedRows[idx + 1].day_text : null;
                    
                    if (r.day_text !== nextDay) {
                        const dayTotal = dailyTotals[r.day_text];
                        rowsHtmlArray.push(`<tr style="background:#f8fafc;"><td colspan="2" style="padding:6px 10px; border-bottom:2px solid #d1d5db; text-align:right; font-weight:600; color:#4b5563; font-size:12px;">Subtotal (${r.day_text}):</td><td style="padding:6px 10px; border-bottom:2px solid #d1d5db; text-align:right; font-weight:700; color:#1f2937;">${dayTotal.toFixed(2)}</td></tr>`);
                    }
                });
                
                const rowsHtml = rowsHtmlArray.join('');

                return `
                    <div class="inbox-item">
                        <div class="inbox-item-header">
                            <div>
                                <h4 style="font-size: 1.25rem; margin-bottom: 4px;">${group.employee_name}</h4>
                                <span class="inbox-item-meta" style="font-size: 0.875rem; color: #666;">Timesheet • ${group.employee_id}</span>
                            </div>
                            <span class="status-badge ${group.statusClass}">${group.status}</span>
                        </div>
                        <div class="inbox-item-body">
                            <p><strong>Week:</strong> ${group.week_start} to ${group.week_end} (Mon-Fri)</p>
                            <div style="margin-top:10px; border:1px solid #e5e7eb; border-radius:10px; overflow:hidden;">
                                <table style="width:100%; border-collapse:collapse; font-size:13px;">
                                    <thead style="background:#f8fafc;"><tr><th style="text-align:left; padding:8px 10px;">Day</th><th style="text-align:left; padding:8px 10px;">Task</th><th style="text-align:right; padding:8px 10px;">Hours</th></tr></thead>
                                    <tbody>${rowsHtml}</tbody>
                                    <tfoot style="background:#eef2ff;">
                                        <tr>
                                            <td colspan="2" style="padding:10px; text-align:right; font-weight:700; color:#1e40af; font-size:14px;">Weekly Total:</td>
                                            <td style="padding:10px; text-align:right; font-weight:700; color:#1e40af; font-size:14px;">${weeklyTotal.toFixed(2)}</td>
                                        </tr>
                                    </tfoot>
                                </table>
                            </div>
                            <p style="margin-top:10px;"><strong>Submitted:</strong> ${group.submitted_at || '-'}</p>
                            ${group.decided_at ? `<p><strong>Updated:</strong> ${group.decided_at}</p>` : ''}
                            ${isRejected && group.reject_comment ? `
                                <div class="rejection-reason-box" style="background: #fff3cd; border-left: 4px solid #ffc107; padding: 12px; margin-top: 12px; border-radius: 4px;">
                                    <strong style="color: #856404;"><i class="fa-solid fa-info-circle"></i> Rejection Reason:</strong>
                                    <p style="margin: 8px 0 0 0; color: #856404;">${group.reject_comment}</p>
                                </div>
                            ` : ''}
                        </div>
                        ${showActions ? `<div class="inbox-item-actions"><button class="btn btn-success btn-sm ts-approve-btn" data-id="${group.first_id}"><i class="fa-solid fa-check"></i> Approve</button><button class="btn btn-danger btn-sm ts-reject-btn" data-id="${group.first_id}"><i class="fa-solid fa-times"></i> Reject</button></div>` : ''}
                    </div>
                `;
            }).join('');

            listContainer.innerHTML = cards;

            if (isAdmin && currentInboxTab === 'awaiting') {
                document.querySelectorAll('.ts-approve-btn').forEach(btn => {
                    btn.addEventListener('click', async (e) => {
                        const entryId = e.currentTarget.getAttribute('data-id');
                        await handleTimesheetApprove(entryId);
                    });
                });

                document.querySelectorAll('.ts-reject-btn').forEach(btn => {
                    btn.addEventListener('click', (e) => {
                        const entryId = e.currentTarget.getAttribute('data-id');
                        showTimesheetRejectModal(entryId);
                    });
                });
            }

            return;
        }

        const cards = items.map(entry => {
            const employeeId = entry.employee_id;
            const employeeName = employeeMap[employeeId?.toUpperCase()] || entry.employee_name || employeeId;
            const status = entry.status || 'Pending';
            const statusClass = String(status).toLowerCase();
            const showActions = isAdmin && currentInboxTab === 'awaiting';
            const isRejected = statusClass === 'rejected';
            const rejectionReason = entry.reject_comment || '';
            const projectName = entry.project_name || entry.project_id || '-';
            const taskName = entry.task_name || entry.task_id || '-';
            const hours = (entry.hours_worked !== undefined && entry.hours_worked !== null)
                ? Number(entry.hours_worked).toFixed(2)
                : (entry.seconds ? (entry.seconds / 3600).toFixed(2) : '0.00');

            return `
                <div class="inbox-item">
                    <div class="inbox-item-header">
                        <div>
                            <h4 style="font-size: 1.25rem; margin-bottom: 4px;">${employeeName}</h4>
                            <span class="inbox-item-meta" style="font-size: 0.875rem; color: #666;">Timesheet • ${employeeId}</span>
                        </div>
                        <span class="status-badge ${statusClass}">${status}</span>
                    </div>
                    <div class="inbox-item-body">
                        <p><strong>Date:</strong> ${entry.date || '-'}</p>
                        <p><strong>Project:</strong> ${projectName}</p>
                        <p><strong>Task:</strong> ${taskName}</p>
                        <p><strong>Hours:</strong> ${hours}</p>
                        <p><strong>Description:</strong> ${entry.description || '-'}</p>
                        <p><strong>Submitted:</strong> ${entry.submitted_at || '-'}</p>
                        ${entry.decided_at ? `<p><strong>Updated:</strong> ${entry.decided_at}</p>` : ''}
                        ${isRejected && rejectionReason ? `
                            <div class="rejection-reason-box" style="background: #fff3cd; border-left: 4px solid #ffc107; padding: 12px; margin-top: 12px; border-radius: 4px;">
                                <strong style="color: #856404;"><i class="fa-solid fa-info-circle"></i> Rejection Reason:</strong>
                                <p style="margin: 8px 0 0 0; color: #856404;">${rejectionReason}</p>
                            </div>
                        ` : ''}
                    </div>
                    ${showActions ? `
                        <div class="inbox-item-actions">
                            <button class="btn btn-success btn-sm ts-approve-btn" data-id="${entry.id}">
                                <i class="fa-solid fa-check"></i> Approve
                            </button>
                            <button class="btn btn-danger btn-sm ts-reject-btn" data-id="${entry.id}">
                                <i class="fa-solid fa-times"></i> Reject
                            </button>
                        </div>
                    ` : ''}
                </div>
            `;
        }).join('');

        listContainer.innerHTML = cards;

        if (isAdmin && currentInboxTab === 'awaiting') {
            document.querySelectorAll('.ts-approve-btn').forEach(btn => {
                btn.addEventListener('click', async (e) => {
                    const entryId = e.currentTarget.getAttribute('data-id');
                    await handleTimesheetApprove(entryId);
                });
            });

            document.querySelectorAll('.ts-reject-btn').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    const entryId = e.currentTarget.getAttribute('data-id');
                    showTimesheetRejectModal(entryId);
                });
            });
        }
    } catch (err) {
        console.error('❌ Error loading timesheet submissions:', err);
        listContainer.innerHTML = `
            <div class="placeholder-text">
                <i class="fa-solid fa-exclamation-triangle fa-3x" style="color:#e74c3c; margin-bottom: 1rem;"></i>
                <p>Error loading timesheet submissions.</p>
            </div>
        `;
    }
};

const loadInboxCompOff = async () => {
    const isAdmin = isAdminUser();
    const canViewTeamQueues = isManagerOrAdmin();
    const listContainer = document.querySelector('.inbox-list');
    if (!listContainer) return;
    listContainer.innerHTML = `
        <div class="placeholder-text">
            <i class="fa-solid fa-spinner fa-spin fa-3x" style="color:#ddd; margin-bottom: 1rem;"></i>
            <p>Loading comp off requests...</p>
        </div>
    `;

    try {
        const empId = await resolveCurrentEmployeeId();
        const all = await fetchCompOffRequests();
        let items = all;

        if (currentInboxTab === 'awaiting' && canViewTeamQueues) {
            items = all.filter(r => (r.status || 'pending').toLowerCase() === 'pending');
        } else if (isAdmin) {
            if (currentInboxTab === 'completed') {
                items = all.filter(r => ['approved', 'rejected'].includes((r.status || '').toLowerCase()));
            }
        } else {
            if (currentInboxTab === 'requests') {
                items = all.filter(r => String(r.employeeId).toUpperCase() === String(empId).toUpperCase() && (r.status || 'pending').toLowerCase() === 'pending');
            } else if (currentInboxTab === 'completed') {
                items = all.filter(r => String(r.employeeId).toUpperCase() === String(empId).toUpperCase() && ['approved', 'rejected'].includes((r.status || '').toLowerCase()));
            }
        }

        // Deduplicate by id to prevent duplicate cards
        const uniqueItems = items.filter((req, idx, arr) => arr.findIndex(r => r.id === req.id) === idx);
        uniqueItems.sort((a, b) => new Date(b.appliedDate || b.timestamp || 0) - new Date(a.appliedDate || a.timestamp || 0));

        if (uniqueItems.length === 0) {
            listContainer.innerHTML = `
                <div class="placeholder-text">
                    <i class="fa-solid fa-envelope-open fa-3x" style="color:#ddd; margin-bottom: 1rem;"></i>
                    <p>No comp off requests found.</p>
                </div>
            `;
            return;
        }

        const cards = uniqueItems.map(req => {
            const status = req.status || 'Pending';
            const statusClass = status.toLowerCase();
            const showActions = isAdmin && currentInboxTab === 'awaiting';
            return `
                <div class="inbox-item">
                    <div class="inbox-item-header">
                        <div>
                            <h4 style="font-size: 1.25rem; margin-bottom: 4px;">${req.employeeName || req.employeeId}</h4>
                            <span class="inbox-item-meta" style="font-size: 0.875rem; color: #666;">Comp Off • ${req.employeeId}</span>
                        </div>
                        <span class="status-badge ${statusClass}">${status}</span>
                    </div>
                    <div class="inbox-item-body">
                        <p><strong>Date Worked:</strong> ${req.dateWorked}</p>
                        <p><strong>Reason:</strong> ${req.reason || '-'}</p>
                        <p><strong>Applied:</strong> ${req.appliedDate || '-'}</p>
                        ${statusClass === 'rejected' && req.rejectionReason ? `
                            <div class="rejection-reason-box" style="background: #fff3cd; border-left: 4px solid #ffc107; padding: 12px; margin-top: 12px; border-radius: 4px;">
                           
                            <strong style="color: #856404;"><i class="fa-solid fa-info-circle"></i> Rejection Reason:</strong>
                                <p style="margin: 8px 0 0 0; color: #856404;">${req.rejectionReason}</p>
                            </div>` : ''}
                    </div>
                    ${showActions ? `
                        <div class="inbox-item-actions">
                            <button class="btn btn-success btn-sm compoff-approve-btn" data-id="${req.id}"><i class="fa-solid fa-check"></i> Grant</button>
                            <button class="btn btn-danger btn-sm compoff-reject-btn" data-id="${req.id}"><i class="fa-solid fa-times"></i> Reject</button>
                        </div>` : ''}
                </div>`;
        }).join('');

        listContainer.innerHTML = cards;

        if (isAdmin && currentInboxTab === 'awaiting') {
            document.querySelectorAll('.compoff-approve-btn').forEach(btn => {
                btn.addEventListener('click', async (e) => {
                    const requestId = e.currentTarget.getAttribute('data-id');
                    await handleCompOffApprove(requestId);
                });
            });
            document.querySelectorAll('.compoff-reject-btn').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    const requestId = e.currentTarget.getAttribute('data-id');
                    showCompOffRejectModal(requestId);
                });
            });
        }
    } catch (err) {
        console.error('❌ Error loading comp off requests:', err);
        listContainer.innerHTML = `
            <div class="placeholder-text">
                <i class="fa-solid fa-exclamation-triangle fa-3x" style="color:#e74c3c; margin-bottom: 1rem;"></i>
                <p>Error loading comp off requests.</p>
            </div>
        `;
    }
};

const handleCompOffApprove = async (requestId) => {
    if (!confirm('Grant this Comp Off request?')) return;
    try {
        const allRequests = await fetchCompOffRequests();
        const req = allRequests.find(r => String(r.id) === String(requestId));
        const adminId = await resolveCurrentEmployeeId();

        await approveCompOffRequest(requestId, adminId || state.user?.id || 'EMP001');

        if (req?.employeeId) {
            try { await notifyEmployeeCompOffGranted(req.id || requestId, req.employeeId); } catch { }
        }

        alert('✅ Comp Off granted');
        await loadInboxCompOff();
        await updateNotificationBadge();
    } catch (err) {
        console.error('❌ Error granting comp off:', err);
        alert('❌ Failed to grant comp off');
    }
};

const buildRejectReasonForm = ({
    eyebrow,
    textareaId,
    hiddenId,
    hiddenValue,
    helperText = 'This comment is shared with the employee.'
}) => `
    <div class="leave-form">
        <div class="form-section">
            <div class="form-section-header">
                <div>
                    <p class="form-eyebrow">${eyebrow}</p>
                    <h3>Rejection reason</h3>
                </div>
                <p class="form-section-copy">${helperText}</p>
            </div>
            <div class="form-field">
                <div class="field-header">
                    <label class="form-label" for="${textareaId}">Reason (Optional)</label>
                    <span class="field-hint">Be specific and actionable</span>
                </div>
                <textarea class="input-control" id="${textareaId}" name="rejectionReason" rows="4" placeholder="Enter reason for rejection..."></textarea>
            </div>
        </div>
    </div>
    <input type="hidden" id="${hiddenId}" value="${hiddenValue}">
`;

const APPROVAL_COMMENTS_MAX_CHARS = 100;

const buildApprovalCommentsForm = ({
    eyebrow,
    textareaId,
    hiddenId,
    hiddenValue,
    helperText = 'This comment is optional and will be shared with the employee.',
    maxChars = APPROVAL_COMMENTS_MAX_CHARS
}) => `
    <div class="leave-form">
        <div class="form-section">
            <div class="form-section-header">
                <div>
                    <p class="form-eyebrow">${eyebrow}</p>
                    <h3>Approval comments</h3>
                </div>
                <p class="form-section-copy">${helperText}</p>
            </div>
            <div class="form-field">
                <div class="field-header">
                    <label class="form-label" for="${textareaId}">Comments (Optional)</label>
                    <span class="field-hint" id="${textareaId}-counter">0 / ${maxChars} characters</span>
                </div>
                <textarea class="input-control" id="${textareaId}" name="approvalComments" rows="4" maxlength="${maxChars}" placeholder="Add any comments for the approval..."></textarea>
            </div>
        </div>
    </div>
    <input type="hidden" id="${hiddenId}" value="${hiddenValue}">
`;

const showCompOffRejectModal = (requestId) => {
    const formHTML = buildRejectReasonForm({
        eyebrow: 'Comp off review',
        textareaId: 'compoffRejectionReason',
        hiddenId: 'compoffRejectId',
        hiddenValue: requestId
    });
    renderModal('Reject Comp Off Request', formHTML, 'compoff-submit-reject-btn', 'normal', 'Reject');
};

export const handleCompOffReject = async (e) => {
    e.preventDefault();
    const requestId = document.getElementById('compoffRejectId')?.value;
    const reason = document.getElementById('compoffRejectionReason')?.value || '';

    if (!requestId) {
        alert('Error: Request ID not found');
        return;
    }

    try {
        const allRequests = await fetchCompOffRequests();
        const req = allRequests.find(r => String(r.id) === String(requestId));
        const adminId = await resolveCurrentEmployeeId();

        await rejectCompOffRequest(requestId, adminId || state.user?.id || 'EMP001', reason);

        if (req?.employeeId) {
            try {
                await notifyEmployeeCompOffRejected(req.id || requestId, req.employeeId, reason);
            } catch (notifErr) {
                console.warn('⚠️ Failed to send comp off rejection notification:', notifErr);
            }
        }

        closeModal();
        alert('✅ Comp Off rejected');
        await loadInboxCompOff();
        await updateNotificationBadge();
    } catch (err) {
        console.error('❌ Error rejecting comp off:', err);
        alert('❌ Failed to reject comp off');
    }
};

const handleTimesheetApprove = async (entryId) => {
    if (!confirm('Are you sure you want to APPROVE this timesheet entry?')) {
        return;
    }

    try {
        const adminId = await resolveCurrentEmployeeId();
        const resp = await fetch(
            `${apiBase}/api/time-tracker/timesheet/${encodeURIComponent(entryId)}/approve`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ decided_by: adminId }),
            }
        );
        const data = await resp.json().catch(() => ({}));

        if (!resp.ok || !data.success) {
            throw new Error(data.error || resp.status);
        }

        alert('✅ Timesheet entry approved successfully!');
        await loadInboxTimesheets();
    } catch (err) {
        console.error('❌ Error approving timesheet entry:', err);
        alert(`❌ Failed to approve timesheet entry: ${err.message || err}`);
    }
};

const showTimesheetRejectModal = (entryId) => {
    const formHTML = buildRejectReasonForm({
        eyebrow: 'Timesheet review',
        textareaId: 'timesheetRejectionReason',
        hiddenId: 'timesheetRejectId',
        hiddenValue: entryId
    });
    renderModal('Reject Timesheet Entry', formHTML, 'timesheet-submit-reject-btn', 'normal', 'Reject');
};

export const handleTimesheetReject = async (e) => {
    e.preventDefault();

    const entryId = document.getElementById('timesheetRejectId')?.value;
    const reason = document.getElementById('timesheetRejectionReason')?.value || '';

    if (!entryId) {
        alert('Error: Timesheet entry ID not found');
        return;
    }

    try {
        const adminId = await resolveCurrentEmployeeId();
        const resp = await fetch(
            `${apiBase}/api/time-tracker/timesheet/${encodeURIComponent(entryId)}/reject`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ decided_by: adminId, comment: reason }),
            }
        );
        const data = await resp.json().catch(() => ({}));

        if (!resp.ok || !data.success) {
            throw new Error(data.error || resp.status);
        }

        closeModal();
        alert('✅ Timesheet entry rejected successfully!');
        await loadInboxTimesheets();
    } catch (err) {
        console.error('❌ Error rejecting timesheet entry:', err);
        alert(`❌ Failed to reject timesheet entry: ${err.message || err}`);
    }
};

const showInboxRejectModal = (leaveId) => {
    const formHTML = buildRejectReasonForm({
        eyebrow: 'Leave review',
        textareaId: 'inboxRejectionReason',
        hiddenId: 'inboxRejectLeaveId',
        hiddenValue: leaveId
    });

    renderModal('Reject Leave Request', formHTML, 'inbox-submit-reject-btn', 'normal', 'Reject');
};

const showInboxApproveModal = (leaveId) => {
    const maxChars = APPROVAL_COMMENTS_MAX_CHARS;
    const formHTML = buildApprovalCommentsForm({
        eyebrow: 'Leave review',
        textareaId: 'inboxApprovalComments',
        hiddenId: 'inboxApproveLeaveId',
        hiddenValue: leaveId,
        maxChars
    });

    renderModal('Approve Leave Request', formHTML, 'inbox-submit-approve-btn', 'normal', 'Approve');
    
    // Add character counter
    setTimeout(() => {
        const textarea = document.getElementById('inboxApprovalComments');
        const counter = document.getElementById('inboxApprovalComments-counter');
        if (textarea && counter) {
            textarea.addEventListener('input', () => {
                const length = textarea.value.length;
                counter.textContent = `${length} / ${maxChars} characters`;
            });
        }
    }, 100);
};

export const handleInboxRejectLeave = async (e) => {
    e.preventDefault();

    const leaveId = document.getElementById('inboxRejectLeaveId').value;
    const reason = document.getElementById('inboxRejectionReason')?.value || '';

    if (!leaveId) {
        alert('Error: Leave ID not found');
        return;
    }

    try {
        // Find the leave details before rejection
        const leaves = await fetchPendingLeaves();
        const leave = leaves.find(l => l.leave_id === leaveId);

        const adminId = await resolveCurrentEmployeeId();
        await rejectLeave(leaveId, adminId, reason);

        // Send notification to employee
        if (leave) {
            try {
                await notifyEmployeeLeaveRejection(
                    leaveId,
                    leave.employee_id,
                    leave.leave_type,
                    reason
                );
            } catch (notifErr) {
                console.warn('⚠️ Failed to send rejection notification:', notifErr);
            }
        }

        closeModal();
        alert(`✅ Leave ${leaveId} rejected successfully!`);
        // Switch to completed tab to show the rejected leave
        currentInboxTab = 'completed';
        // Update tab UI
        document.querySelectorAll('.inbox-tab').forEach(t => t.classList.remove('active'));
        document.querySelector('.inbox-tab[data-tab="completed"]')?.classList.add('active');
        await loadInboxLeaves();
    } catch (err) {
        console.error('❌ Error rejecting leave:', err);
        alert(`❌ Failed to reject leave: ${err.message}`);
    }
};

const handleInboxApprove = async (leaveId) => {
    showInboxApproveModal(leaveId);
};

export const handleInboxApproveLeave = async (e) => {
    e.preventDefault();

    const leaveId = document.getElementById('inboxApproveLeaveId').value;
    const formComments = e?.target ? new FormData(e.target).get('approvalComments') : '';
    const comments = String(document.getElementById('inboxApprovalComments')?.value ?? formComments ?? '').trim();

    console.log('🔍 [APPROVE] Leave ID:', leaveId);
    console.log('🔍 [APPROVE] Captured comments:', comments);
    console.log('🔍 [APPROVE] Comments length:', comments.length);

    if (!leaveId) {
        alert('Error: Leave ID not found');
        return;
    }

    try {
        // Find the leave details before approval
        const leaves = await fetchPendingLeaves();
        const leave = leaves.find(l => l.leave_id === leaveId);

        const adminId = await resolveCurrentEmployeeId();
        console.log('📤 [APPROVE] Sending to API - Leave:', leaveId, 'Admin:', adminId, 'Comments:', comments);
        await approveLeave(leaveId, adminId, comments);

        // Clear leave cache to force refresh
        if (leave?.employee_id && state?.cache?.leaves) {
            const empKey = String(leave.employee_id).toUpperCase();
            delete state.cache.leaves[empKey];
        }

        // Send notification to employee
        if (leave) {
            try {
                await notifyEmployeeLeaveApproval(
                    leaveId,
                    leave.employee_id,
                    leave.leave_type
                );
            } catch (notifErr) {
                console.warn('⚠️ Failed to send approval notification:', notifErr);
            }
        }

        closeModal();
        alert(`✅ Leave ${leaveId} approved successfully!`);
        // Switch to completed tab to show the approved leave
        currentInboxTab = 'completed';
        // Update tab UI
        document.querySelectorAll('.inbox-tab').forEach(t => t.classList.remove('active'));
        document.querySelector('.inbox-tab[data-tab="completed"]')?.classList.add('active');
        await loadInboxLeaves();
    } catch (err) {
        console.error('❌ Error approving leave:', err);
        alert(`❌ Failed to approve leave: ${err.message}`);
    }
};

const handleAttendanceApprove = async (markerId) => {
    if (!confirm(`Are you sure you want to APPROVE this attendance report?`)) {
        return;
    }

    try {
        const response = await fetch(`${apiBase}/api/attendance/submissions/${markerId}/approve`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });

        const data = await response.json();

        if (!data.success) {
            throw new Error(data.error || 'Failed to approve attendance report');
        }

        alert(`✅ Attendance report approved successfully!`);
        await loadInboxAttendance();
    } catch (err) {
        console.error('❌ Error approving attendance report:', err);
        alert(`❌ Failed to approve attendance report: ${err.message}`);
    }
};


const handleAttendanceReject = async (markerId) => {
    const reason = prompt('Enter rejection reason for this attendance report:');
    if (reason === null) {
        return;
    }

    try {
        const response = await fetch(`${apiBase}/api/attendance/submissions/${markerId}/reject`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reason })
        });

        const data = await response.json();

        if (!data.success) {
            throw new Error(data.error || 'Failed to reject attendance report');
        }

        alert('? Attendance report rejected successfully!');
        await loadInboxAttendance();
    } catch (err) {
        console.error('? Error rejecting attendance report:', err);
        alert(`? Failed to reject attendance report: ${err.message}`);
    }
};
export const renderProjectsPage = () => {
    const content = `
        <div class="card">
            <div class="table-container">
                <table class="table">
                    <thead><tr><th>Work item id & name</th><th>Project</th><th>Client</th><th>Status</th><th>Due date</th><th>Due Time</th><th>Priority</th><th>Time spent</th></tr></thead>
                    <tbody><tr><td colspan="8" class="placeholder-text">No tasks assigned.</td></tr></tbody>
                </table>
            </div>
        </div>
    `;
    document.getElementById('app-content').innerHTML = getPageContentHTML('My tasks', content);
};
