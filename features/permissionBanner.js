// permissionBanner.js - Shows "On Permission until X - click Check In to resume"
// while the employee is inside an active permission window (any status:
// approval is audit-only and doesn't gate the pause/banner).
import { state } from '../state.js';
import { fetchActivePermission } from './permissionApi.js';
import { isCheckedIn } from './attendanceRenderer.js';

const POLL_INTERVAL_MS = 30000;
let pollIntervalId = null;

const formatTime12h = (hhmm) => {
    if (!hhmm) return '';
    const [hStr, mStr] = String(hhmm).split(':');
    let h = parseInt(hStr, 10);
    const m = mStr || '00';
    const suffix = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return `${h}:${m} ${suffix}`;
};

const renderBanner = (request) => {
    const slot = document.getElementById('permission-banner-slot');
    if (!slot) return;
    slot.innerHTML = `
        <div class="permission-banner" style="display:flex; align-items:center; gap:8px; padding:6px 14px; border-radius:999px; background:#fef3c7; color:#92400e; font-size:13px; font-weight:600; margin-right:12px;">
            <i class="fa-solid fa-hourglass-half"></i>
            <span>On Permission until ${formatTime12h(request.endTime)} — click Check In to resume</span>
        </div>
    `;
};

const clearBanner = () => {
    const slot = document.getElementById('permission-banner-slot');
    if (slot) slot.innerHTML = '';
};

const tick = async () => {
    try {
        const employeeId = state.user?.id || state.user?.employee_id;
        if (!employeeId) {
            clearBanner();
            return;
        }
        // Only relevant while NOT actively checked in (the pause already checked them out).
        if (isCheckedIn && isCheckedIn()) {
            clearBanner();
            return;
        }
        const { active, request } = await fetchActivePermission(employeeId);
        if (active && request) {
            renderBanner(request);
        } else {
            clearBanner();
        }
    } catch (err) {
        console.warn('[PERMISSION-BANNER] poll failed:', err);
    }
};

export const startPermissionBannerPolling = () => {
    if (pollIntervalId) clearInterval(pollIntervalId);
    tick();
    pollIntervalId = setInterval(tick, POLL_INTERVAL_MS);
};

export const stopPermissionBannerPolling = () => {
    if (pollIntervalId) {
        clearInterval(pollIntervalId);
        pollIntervalId = null;
    }
    clearBanner();
};

export const refreshPermissionBannerNow = () => tick();
