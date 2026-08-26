import { getPageContentHTML } from '../utils.js';
import { canUseFunction, canViewApplication } from '../utils/roleSettings.js';
import { renderSettingsLayout } from '../components/settingsLayout.js';
import { fetchAttendanceMonitoringToday } from '../features/attendanceMonitorApi.js';

const POLL_INTERVAL_MS = 30000;
let pollIntervalId = null;

const formatTime12h = (hhmmss) => {
    if (!hhmmss) return '--';
    const parts = String(hhmmss).split(':');
    let h = parseInt(parts[0], 10);
    const m = parts[1] || '00';
    if (Number.isNaN(h)) return '--';
    const suffix = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return `${h}:${m} ${suffix}`;
};

const buildTableHTML = (data) => {
    const checkedIn = data.checked_in_employees || [];
    const notChecked = data.not_checked_in_employees || [];

    const checkedInRows = checkedIn
        .sort((a, b) => String(a.employee_id).localeCompare(String(b.employee_id)))
        .map((row) => `
            <tr>
                <td>${row.employee_id}</td>
                <td>${row.employee_name}</td>
                <td>${row.shift_start && row.shift_end ? `${formatTime12h(row.shift_start)} - ${formatTime12h(row.shift_end)}` : '--'}</td>
                <td style="font-weight:600;">${formatTime12h(row.checkin_local)}</td>
                <td style="font-weight:600; color:#4f46e5;">${formatTime12h(row.expected_checkout)}</td>
                <td><span class="status-badge approved">Checked In</span></td>
            </tr>
        `).join('');

    const notCheckedRows = notChecked
        .sort((a, b) => String(a.employee_id).localeCompare(String(b.employee_id)))
        .map((row) => `
            <tr>
                <td>${row.employee_id}</td>
                <td>${row.employee_name}</td>
                <td colspan="3" class="placeholder-text" style="text-align:left;">-</td>
                <td><span class="status-badge ${row.status === 'Checked Out' ? 'rejected' : 'pending'}">${row.status}</span></td>
            </tr>
        `).join('');

    return `
        <div class="card">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 1rem;">
                <div>
                    <h3 style="margin-bottom: 4px;">Live Check-In Monitor</h3>
                    <p class="subtle" style="margin:0;">
                        Exact check-in time and expected checkout (check-in + assigned shift duration) for today.
                        Auto-refreshes every 30 seconds.
                    </p>
                </div>
                <div style="display:flex; gap: 16px; font-size: 0.85rem; color: var(--text-secondary);">
                    <span><strong style="color:#10b981;">${checkedIn.length}</strong> checked in</span>
                    <span><strong>${data.total_employees ?? 0}</strong> total</span>
                </div>
            </div>
            <div class="table-container">
                <table class="table">
                    <thead>
                        <tr>
                            <th>Employee ID</th>
                            <th>Name</th>
                            <th>Assigned Shift</th>
                            <th>Checked In At</th>
                            <th>Expected Checkout</th>
                            <th>Status</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${checkedInRows || ''}
                        ${notCheckedRows || ''}
                        ${!checkedInRows && !notCheckedRows ? `<tr><td colspan="6" class="placeholder-text">No employee data available.</td></tr>` : ''}
                    </tbody>
                </table>
            </div>
        </div>
    `;
};

const refreshTable = async () => {
    try {
        const data = await fetchAttendanceMonitoringToday();
        const container = document.getElementById('attendance-monitor-content');
        if (container) container.innerHTML = buildTableHTML(data);
    } catch (err) {
        console.warn('[ATTENDANCE-MONITOR] refresh failed:', err);
        const container = document.getElementById('attendance-monitor-content');
        if (container) {
            container.innerHTML = `
                <div class="card">
                    <p class="placeholder-text error-message">Error loading attendance monitor: ${err.message || err}</p>
                </div>
            `;
        }
    }
};

const stopPolling = () => {
    if (pollIntervalId) {
        clearInterval(pollIntervalId);
        pollIntervalId = null;
    }
};

const isStillOnThisPage = () => (window.location.hash || '').includes('/attendance-monitor');

export const renderAttendanceMonitorPage = async () => {
    stopPolling();

    if (!canUseFunction('view_admin_dashboard') && !canViewApplication('attendance_monitor')) {
        const denied = `
            <div class="card" style="padding: 40px; text-align: center;">
                <i class="fa-solid fa-lock" style="font-size: 48px; color: #e74c3c; margin-bottom: 16px;"></i>
                <h2>Access Denied</h2>
                <p>You don't have permission to view the attendance monitor.</p>
            </div>
        `;
        document.getElementById('app-content').innerHTML = getPageContentHTML('Settings', renderSettingsLayout('attendance-monitor', denied));
        return;
    }

    const loading = `
        <div id="attendance-monitor-content" class="card">
            <p class="placeholder-text">Loading attendance monitor...</p>
        </div>
    `;
    document.getElementById('app-content').innerHTML = getPageContentHTML('Settings', renderSettingsLayout('attendance-monitor', loading));

    await refreshTable();

    pollIntervalId = setInterval(() => {
        if (!isStillOnThisPage()) {
            stopPolling();
            return;
        }
        refreshTable();
    }, POLL_INTERVAL_MS);
};
