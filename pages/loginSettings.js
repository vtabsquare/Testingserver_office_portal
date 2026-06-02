// loginSettings.js - Login Settings page for admin to manage login accounts

import { state } from '../state.js';
import { getPageContentHTML } from '../utils.js';
import { renderModal, closeModal } from '../components/modal.js';
import { listLoginAccounts, createLoginAccount, updateLoginAccount, deleteLoginAccount, fetchLoginEvents, updateLoginActivity, fetchAuthSessionEvents, triggerForceLogout } from '../features/loginSettingsApi.js';
import { fetchCustomRoles } from '../features/roleSettingsApi.js';
import { listAllEmployees } from '../features/employeeApi.js';
import { getUserAccessContext } from '../utils/accessControl.js';
import { canUseFunction } from '../utils/roleSettings.js';
import { renderSettingsLayout } from '../components/settingsLayout.js';

let currentLoginSettingsView = 'accounts';
let cachedLoginAccounts = [];
let cachedLoginActivitySummary = [];
let cachedAuthSessionEvents = [];
let loginAccountNameIndex = {};
let cachedEmployeeDirectory = [];

const DEFAULT_ROLES = [
    { key: 'L1', name: 'User' },
    { key: 'L2', name: 'Manager' },
    { key: 'L4', name: 'Team Lead' },
    { key: 'L3', name: 'Admin' }
];
let availableRoles = [...DEFAULT_ROLES];

const formatLastLogin = (value) => {
    if (!value) return 'N/A';
    try {
        // If value already looks like ISO, let Date try to parse it
        const d = new Date(value);
        if (!isNaN(d.getTime())) {
            return d.toLocaleString('en-IN', {
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
            });
        }
        return String(value);
    } catch {
        return String(value);
    }
};

const formatAccessLevelLabel = (level) => {
    const normalized = String(level || '').trim().toUpperCase();
    const role = availableRoles.find(r => r.key.toUpperCase() === normalized);
    return role ? role.name : (level || '');
};

const formatTime = (isoString) => {
    if (!isoString) return '-';
    try {
        const d = new Date(isoString);
        if (!isNaN(d.getTime())) {
            return d.toLocaleTimeString('en-IN', {
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
            });
        }
        return String(isoString);
    } catch {
        return String(isoString);
    }
};

const geocodeCache = {};

const reverseGeocodeToCity = async (lat, lng) => {
    const cacheKey = `${lat},${lng}`;
    if (geocodeCache[cacheKey]) return geocodeCache[cacheKey];
    try {
        const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&zoom=16&addressdetails=1&accept-language=en-IN`;
        const resp = await fetch(url, { headers: { 'User-Agent': 'OfficeToolApp/1.0' } });
        if (resp.ok) {
            const data = await resp.json();
            const address = data.address || {};
            const city = address.city || address.town || address.village || address.suburb || address.municipality || address.county || address.state_district || address.state;
            if (city) {
                geocodeCache[cacheKey] = city;
                return city;
            }
        }
    } catch (e) {
        console.warn('[GEOCODE] Error:', e);
    }
    return null;
};

const parseCoordinateString = (str) => {
    if (!str || typeof str !== 'string') return null;
    const match = str.match(/^(-?\d+\.?\d*),\s*(-?\d+\.?\d*)$/);
    if (match) {
        const lat = parseFloat(match[1]);
        const lng = parseFloat(match[2]);
        if (!isNaN(lat) && !isNaN(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
            return { lat, lng };
        }
    }
    return null;
};

const formatLocation = (loc) => {
    if (!loc) return '<span class="text-muted">Not shared</span>';

    // If backend sent city string directly (legacy) or coordinate string
    if (typeof loc === 'string') {
        const coords = parseCoordinateString(loc);
        if (coords) {
            // It's a coordinate string - return placeholder and trigger async geocoding
            const uniqueId = `loc-${coords.lat}-${coords.lng}`.replace(/\./g, '_');
            // Async geocode and update DOM
            reverseGeocodeToCity(coords.lat, coords.lng).then(city => {
                const elements = document.querySelectorAll(`[data-loc-id="${uniqueId}"]`);
                elements.forEach(el => {
                    if (city) {
                        el.innerHTML = `📍 ${city}`;
                    }
                });
            });
            // Return with data attribute for later update
            return `<span data-loc-id="${uniqueId}">📍 ${loc}</span>`;
        }
        return loc ? `📍 ${loc}` : '<span class="text-muted">Not shared</span>';
    }

    // If backend sent detailed object
    const city = loc.city;
    const lat = loc.lat;
    const lng = loc.lng;
    const accuracy = typeof loc.accuracy_m === 'number' ? loc.accuracy_m : null;

    // If accuracy is extremely low (radius > 100km), do not pretend we know exact city
    if (accuracy && accuracy > 100000) {
        return '<span class="text-muted">~ Approximate location (not precise)</span>';
    }

    if (city) {
        return `📍 ${city}`;
    }

    if (lat && lng) {
        const uniqueId = `loc-${lat}-${lng}`.replace(/\./g, '_');
        reverseGeocodeToCity(lat, lng).then(cityName => {
            const elements = document.querySelectorAll(`[data-loc-id="${uniqueId}"]`);
            elements.forEach(el => {
                if (cityName) {
                    el.innerHTML = `📍 ${cityName}`;
                }
            });
        });
        const latStr = Number(lat).toFixed(4);
        const lngStr = Number(lng).toFixed(4);
        const accText = accuracy ? ` (±${Math.round(accuracy)}m)` : '';
        return `<span data-loc-id="${uniqueId}">🌐 ${latStr}, ${lngStr}${accText}</span>`;
    }

    return '<span class="text-muted">Not shared</span>';
};

const normalizeTimeInputToISO = (dateStr, timeStr) => {
    const d = String(dateStr || '').trim();
    const t = String(timeStr || '').trim();
    if (!d || !t) return null;

    // If user pasted an ISO string, accept as-is
    if (t.includes('T') && t.includes('Z')) return t;

    // Accept HH:mm or HH:mm:ss (as local time). Store as UTC ISO for Dataverse.
    const full = t.length === 5 ? `${t}:00` : t;
    const dt = new Date(`${d}T${full}`);
    if (Number.isNaN(dt.getTime())) return null;
    return dt.toISOString();
};

const formatISOToTimeInput = (isoString) => {
    if (!isoString) return '';
    const d = new Date(isoString);
    if (Number.isNaN(d.getTime())) return '';
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
};

const openEditLoginActivityModal = (row) => {
    if (!row) return;
    const formHTML = `
        <div class="modal-form modern-form team-modal">
            <div class="form-section">
                <div class="form-section-header">
                    <div>
                        <p class="form-eyebrow">LOGIN SETTINGS</p>
                        <h3>Edit login activity</h3>
                    </div>
                </div>
                <input type="hidden" id="la-employee-id" value="${row.employee_id || ''}" />
                <input type="hidden" id="la-date" value="${row.date || ''}" />
                <div class="form-grid two-col">
                    <div class="form-field">
                        <label class="form-label">Employee ID</label>
                        <input class="input-control" type="text" value="${row.employee_id || ''}" disabled />
                    </div>
                    <div class="form-field">
                        <label class="form-label">Date</label>
                        <input class="input-control" type="text" value="${row.date || ''}" disabled />
                    </div>
                    <div class="form-field">
                        <label class="form-label" for="la-checkin-time">Check-in Time (HH:mm:ss)</label>
                        <input id="la-checkin-time" class="input-control" type="text" placeholder="09:30:00" value="${formatISOToTimeInput(row.check_in_time)}" />
                    </div>
                    <div class="form-field">
                        <label class="form-label" for="la-checkin-location">Check-in Location</label>
                        <input id="la-checkin-location" class="input-control" type="text" placeholder="Chennai" value="${row.check_in_location || ''}" />
                    </div>
                    <div class="form-field">
                        <label class="form-label" for="la-checkout-time">Check-out Time (HH:mm:ss)</label>
                        <input id="la-checkout-time" class="input-control" type="text" placeholder="18:10:00" value="${formatISOToTimeInput(row.check_out_time)}" />
                    </div>
                    <div class="form-field">
                        <label class="form-label" for="la-checkout-location">Check-out Location</label>
                        <input id="la-checkout-location" class="input-control" type="text" placeholder="Chennai" value="${row.check_out_location || ''}" />
                    </div>
                </div>
                <p class="helper-text">Only check-in/out time and location are editable. Employee ID and Date are read-only.</p>
            </div>
        </div>
    `;

    renderModal('Edit Login Activity', formHTML, 'update-login-activity-btn');

    const form = document.getElementById('modal-form');
    if (form) {
        form.onsubmit = async (e) => {
            e.preventDefault();
            await handleUpdateLoginActivity();
        };
    }
};

const handleUpdateLoginActivity = async () => {
    try {
        const employee_id = document.getElementById('la-employee-id')?.value?.trim()?.toUpperCase();
        const dateStr = document.getElementById('la-date')?.value?.trim();
        if (!employee_id || !dateStr) return;

        const checkInTimeRaw = document.getElementById('la-checkin-time')?.value;
        const checkOutTimeRaw = document.getElementById('la-checkout-time')?.value;
        const checkInLocation = document.getElementById('la-checkin-location')?.value?.trim() || null;
        const checkOutLocation = document.getElementById('la-checkout-location')?.value?.trim() || null;

        const checkInTimeISO = normalizeTimeInputToISO(dateStr, checkInTimeRaw);
        const checkOutTimeISO = normalizeTimeInputToISO(dateStr, checkOutTimeRaw);

        await updateLoginActivity({
            employee_id,
            date: dateStr,
            check_in_time: checkInTimeISO,
            check_in_location: checkInLocation,
            check_out_time: checkOutTimeISO,
            check_out_location: checkOutLocation,
        });

        closeModal();
        await renderLoginSettingsPage();
    } catch (err) {
        console.error('Error updating login activity:', err);
        alert(err.message || 'Failed to update login activity');
    }
};

const buildLoginAccountNameIndex = (accounts = [], employees = []) => {
    loginAccountNameIndex = {};
    const addToIndex = (id, displayName) => {
        const key = String(id || '').trim().toUpperCase();
        if (!key || loginAccountNameIndex[key]) return;
        const value = String(displayName || '').trim();
        loginAccountNameIndex[key] = value || key;
    };

    (accounts || []).forEach((acc) => {
        const id = acc.employeeId || acc.employee_id || acc.employeeID || acc.employeeid;
        const displayName =
            acc.employeeName ||
            acc.employee_name ||
            acc.employeeFullName ||
            `${acc.firstName || ''} ${acc.lastName || ''}`.trim() ||
            acc.username;
        addToIndex(id, displayName);
    });

    (employees || []).forEach((emp) => {
        const id = emp.employee_id || emp.employeeId || emp.id;
        const displayName =
            emp.full_name ||
            emp.name ||
            `${emp.first_name || ''} ${emp.last_name || ''}`.trim();
        addToIndex(id, displayName);
    });

};

const resolveEmployeeName = (employeeId) => {
    const key = String(employeeId || '').trim().toUpperCase();
    if (!key) return '';
    return loginAccountNameIndex[key] || '';
};

const buildPresenceBadge = (item) => {
    const isCheckedIn = !!item.check_in_time && !item.check_out_time;
    const label = isCheckedIn ? 'Checked In' : 'Offline';
    const statusClass = isCheckedIn ? 'present' : 'absent';
    return `<span class="status-badge compact ${statusClass}">${label}</span>`;
};

const getActivityCounts = (dailySummary = []) => {
    const checkedIn = (dailySummary || []).filter(
        (item) => !!item.check_in_time && !item.check_out_time
    ).length;
    const offline = Math.max((dailySummary?.length || 0) - checkedIn, 0);
    return { checkedIn, offline };
};

const buildLoginActivityHTML = (dailySummary = []) => {
    if (!dailySummary.length) {
        return `
            <div class="card" style="margin-top: 24px;">
                <h3><i class="fa-solid fa-clock-rotate-left"></i> Login Activity</h3>
                <p class="allocation-description">Track employee check-in/out times and locations.</p>
                <p class="placeholder-text">No login activity recorded yet.</p>
            </div>
        `;
    }

    const rows = dailySummary.map((item) => {
        const employeeName = resolveEmployeeName(item.employee_id);
        return `
        <tr>
            <td>
                <div style="display:flex; flex-direction:column; line-height:1.35;">
                    <span style="font-weight:600; color:#0f172a; font-size:15px;">
                        ${item.employee_id || ''}
                    </span>
                    <span style="font-size:12px; color:#6b7280; letter-spacing:0.3px;">
                        ${employeeName && employeeName !== item.employee_id ? employeeName : ''}
                    </span>
                </div>
            </td>
            <td>${item.date || ''}</td>
            <td>${formatTime(item.check_in_time)}</td>
            <td>${formatLocation(item.check_in_location)}</td>
            <td>${buildPresenceBadge(item)}</td>
            <td>${formatTime(item.check_out_time)}</td>
            <td>${formatLocation(item.check_out_location)}</td>
        </tr>
    `}).join('');

    return `
        <div class="card" style="margin-top: 24px;">
            <h3><i class="fa-solid fa-clock-rotate-left"></i> Login Activity</h3>
            <p class="allocation-description">Track employee check-in/out times and locations.</p>
            <div class="table-container login-settings-table">
                <table class="table">
                    <thead>
                        <tr>
                            <th>Employee</th>
                            <th>Date</th>
                            <th>Check-in Time</th>
                            <th>Check-in Location</th>
                            <th>Presence</th>
                            <th>Check-out Time</th>
                            <th>Check-out Location</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${rows}
                    </tbody>
                </table>
            </div>
        </div>
    `;
};

const formatAuthEventType = (eventType = '') => {
    const normalized = String(eventType || '').trim().toLowerCase();
    if (normalized === 'login') return 'Login';
    if (normalized === 'logout') return 'Logout';
    if (normalized === 'force_logout') return 'Force Logout';
    return normalized || '-';
};

const formatAuthEventTime = (value) => {
    if (!value) return '-';
    try {
        const d = new Date(value);
        if (!isNaN(d.getTime())) {
            return d.toLocaleString('en-IN', {
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
            });
        }
    } catch {
    }
    return String(value);
};

const buildAuthSessionsHTML = (events = [], accounts = []) => {
    const activeAccounts = accounts.filter(a => String(a.userStatus || '').toLowerCase() === 'active');

    const activeRows = activeAccounts.length
        ? activeAccounts.map((acc) => `
            <tr>
                <td>${acc.username || '-'}</td>
                <td>${acc.employeeName || '-'}</td>
                <td>${formatAccessLevelLabel(acc.accessLevel)}</td>
                <td>${formatLastLogin(acc.lastLogin)}</td>
                <td><span class="status-badge active">ACTIVE</span></td>
                <td>
                    <button class="btn btn-outline session-force-logout-btn" data-id="${acc.id}" data-username="${acc.username || ''}" data-employee-name="${acc.employeeName || ''}" data-employee-id="${acc.userId || ''}" style="border-color:#dc2626; color:#dc2626; padding:4px 10px; font-size:12px;">
                        <i class="fa-solid fa-power-off"></i> Force Logout
                    </button>
                </td>
            </tr>
        `).join('')
        : '<tr><td colspan="6" class="placeholder-text">No active users found.</td></tr>';

    const eventRows = events.length
        ? events.map((item) => `
            <tr>
                <td>${item.employee_name || '-'}</td>
                <td>${item.username || '-'}</td>
                <td><span class="status-badge">${formatAuthEventType(item.event_type)}</span></td>
                <td>${formatAuthEventTime(item.occurred_at_utc)}</td>
                <td>${item.reason || '-'}</td>
            </tr>
        `).join('')
        : '<tr><td colspan="5" class="placeholder-text">No auth session events recorded yet.</td></tr>';

    return `
        <div class="card" style="margin-top: 24px;">
            <h3><i class="fa-solid fa-users"></i> Currently Logged-In Users</h3>
            <p class="allocation-description">Users with active login accounts. Force logout ends their app session and checks out any open attendance timer for today.</p>
            <div style="display:flex; gap:10px; margin-bottom:12px;">
                <button id="force-logout-all-btn" class="btn btn-outline" style="border-color:#dc2626; color:#dc2626;">
                    <i class="fa-solid fa-power-off"></i> Force Logout All Users
                </button>
            </div>
            <div class="table-container login-settings-table">
                <table class="table">
                    <thead>
                        <tr>
                            <th>Username</th>
                            <th>Employee Name</th>
                            <th>Access Level</th>
                            <th>Last Login</th>
                            <th>Status</th>
                            <th>Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${activeRows}
                    </tbody>
                </table>
            </div>
        </div>
        <div class="card" style="margin-top: 16px;">
            <h3><i class="fa-solid fa-right-to-bracket"></i> Auth Session Log</h3>
            <p class="allocation-description">Historical login/logout events (not check-in/check-out).</p>
            <div class="table-container login-settings-table">
                <table class="table">
                    <thead>
                        <tr>
                            <th>Name</th>
                            <th>Username</th>
                            <th>Event</th>
                            <th>Time</th>
                            <th>Reason</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${eventRows}
                    </tbody>
                </table>
            </div>
        </div>
    `;
};

const buildTableHTML = (accounts = []) => {
    const rows = accounts.map((acc) => `
        <tr>
            <td>${acc.username || ''}</td>
            <td>${acc.employeeName || ''}</td>
            <td>
                <span class="role-badge" style="background: var(--surface-hover); padding: 4px 10px; border-radius: 12px; font-size: 12px; font-weight: 600; color: var(--text-primary); border: 1px solid var(--border-color);">${formatAccessLevelLabel(acc.accessLevel)}</span>
            </td>
            <td>${formatLastLogin(acc.lastLogin)}</td>
            <td>${typeof acc.loginAttempts === 'number' ? acc.loginAttempts : ''}</td>
            <td>
                <span class="status-badge ${String(acc.userStatus || '').toLowerCase()}">${acc.userStatus || ''}</span>
            </td>
            <td>
                <div class="table-actions">
                    <button class="icon-btn login-edit-btn" title="Edit" data-id="${acc.id}">
                        <i class="fa-solid fa-pen-to-square"></i>
                    </button>
                    <button class="icon-btn login-force-logout-btn" title="Force Logout" data-id="${acc.id}" style="color:#dc2626;">
                        <i class="fa-solid fa-power-off"></i>
                    </button>
                    <button class="icon-btn login-delete-btn" title="Delete" data-id="${acc.id}">
                        <i class="fa-solid fa-trash"></i>
                    </button>
                </div>
            </td>
        </tr>
    `).join('');

    return `
        <div class="card">
            <h3><i class="fa-solid fa-user-shield"></i> Login Accounts</h3>
            <p class="allocation-description">Manage login access level, status, and attempts for users.</p>
            <div class="table-container login-settings-table">
                <table class="table">
                    <thead>
                        <tr>
                            <th>Username</th>
                            <th>Employee Name</th>
                            <th>Access Level</th>
                            <th>Last Login</th>
                            <th>Login Attempts</th>
                            <th>User Status</th>
                            <th>Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${rows || '<tr><td colspan="7" class="placeholder-text">No login accounts found.</td></tr>'}
                    </tbody>
                </table>
            </div>
        </div>
    `;
};

const getLoginSettingsContentHTML = (view, accounts = [], dailySummary = [], authEvents = []) => {
    if (view === 'activity') {
        return buildLoginActivityHTML(dailySummary);
    }
    if (view === 'sessions') {
        return buildAuthSessionsHTML(authEvents, accounts);
    }
    return buildTableHTML(accounts);
};

const buildLoginSettingsLayout = (accounts = [], dailySummary = [], authEvents = []) => {
    const sidebarOption = (view, label, icon) => {
        const isActive = currentLoginSettingsView === view;
        const countMarkup =
            view === 'activity'
                ? (() => {
                      const { checkedIn, offline } = getActivityCounts(dailySummary);
                      return `
                        <span class="status-badge compact present" style="margin-left:auto;">${checkedIn}</span>
                        <span class="status-badge compact absent" style="margin-left:6px;">${offline}</span>
                    `;
                  })()
                : `<span style="margin-left:auto; font-size:12px; color:#cbd5f5;">${accounts.length}</span>`;
        const count = view === 'sessions' ? authEvents.length : (view === 'activity' ? '' : accounts.length);
        const defaultCountMarkup = view === 'sessions'
            ? `<span style="margin-left:auto; font-size:12px; color:#cbd5f5;">${count}</span>`
            : `<span style="margin-left:auto; font-size:12px; color:#cbd5f5;">${accounts.length}</span>`;
        return `
            <div class="inbox-category login-settings-view ${isActive ? 'active' : ''}" data-view="${view}">
                <i class="fa-solid ${icon}" style="margin-right:8px;"></i>
                <span>${label}</span>
                ${view === 'activity' ? countMarkup : defaultCountMarkup}
            </div>
        `;
    };

    return `
        <div class="inbox-container login-settings-layout">
            <div class="inbox-sidebar login-settings-sidebar">
                ${sidebarOption('accounts', 'Login Accounts', 'fa-user-shield')}
                ${sidebarOption('activity', 'Login Activity', 'fa-clock-rotate-left')}
                ${sidebarOption('sessions', 'Auth Sessions', 'fa-right-to-bracket')}
            </div>
            <div class="inbox-content login-settings-content">
                <div class="login-settings-content-body"></div>
            </div>
        </div>
    `;
};

const refreshLoginSettingsContent = () => {
    const container = document.querySelector('.login-settings-content-body');
    if (!container) return;
    container.innerHTML = getLoginSettingsContentHTML(
        currentLoginSettingsView,
        cachedLoginAccounts,
        cachedLoginActivitySummary,
        cachedAuthSessionEvents
    );

    if (currentLoginSettingsView === 'accounts') {
        attachRowHandlers(cachedLoginAccounts);
    }

    const addBtn = document.getElementById('add-login-account-btn');
    if (addBtn) {
        addBtn.style.display = currentLoginSettingsView === 'accounts' ? 'inline-flex' : 'none';
    }

    const forceAllBtn = document.getElementById('force-logout-all-btn');
    if (forceAllBtn) {
        forceAllBtn.onclick = async () => {
            if (!confirm('Force logout all users? This also checks out anyone with an open attendance timer today.')) return;
            try {
                const result = await triggerForceLogout({
                    requested_by: state.user?.email || state.user?.id || 'admin',
                    reason: 'Admin forced logout for all users',
                    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Calcutta',
                });
                const ac = result.attendance_checkout || {};
                const n = (ac.checked_out || []).length;
                alert(`Force logout triggered for all users.${n ? ` Checked out ${n} attendance timer(s).` : ' No open attendance timers today.'}`);
                const authData = await fetchAuthSessionEvents({ limit: 200 }).catch(() => ({ items: [] }));
                cachedAuthSessionEvents = authData.items || [];
                refreshLoginSettingsContent();
            } catch (err) {
                alert(err.message || 'Failed to force logout all users');
            }
        };
    }

    if (currentLoginSettingsView === 'sessions') {
        const sessionLogoutBtns = document.querySelectorAll('.session-force-logout-btn');
        sessionLogoutBtns.forEach((btn) => {
            btn.addEventListener('click', async () => {
                const employeeId = String(btn.getAttribute('data-employee-id') || '').trim().toUpperCase();
                const username = (btn.getAttribute('data-username') || '').trim();
                const employeeName = btn.getAttribute('data-employee-name') || '';
                if (!employeeId && !username) {
                    alert('Employee ID and username both missing for this user.');
                    return;
                }
                if (!confirm(`Force logout ${username || employeeName || employeeId}? This also checks out their attendance timer if checked in today.`)) return;
                try {
                    const result = await triggerForceLogout({
                        employee_id: employeeId,
                        username: username,
                        employee_name: employeeName,
                        requested_by: state.user?.email || state.user?.id || 'admin',
                        reason: 'Admin forced logout',
                        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Calcutta',
                    });
                    const ac = result.attendance_checkout || {};
                    const checkedOut = (ac.checked_out || []).length > 0;
                    alert(checkedOut
                        ? `Force logout triggered for ${username || employeeName || employeeId}. Attendance timer checked out.`
                        : `Force logout triggered for ${username || employeeName || employeeId}. No open attendance timer today.`);
                    const authData = await fetchAuthSessionEvents({ limit: 200 }).catch(() => ({ items: [] }));
                    cachedAuthSessionEvents = authData.items || [];
                    refreshLoginSettingsContent();
                } catch (err) {
                    alert(err.message || 'Failed to force logout user');
                }
            });
        });
    }
};

const attachLoginSettingsViewHandlers = () => {
    const viewButtons = document.querySelectorAll('.login-settings-view');
    viewButtons.forEach((btn) => {
        btn.addEventListener('click', () => {
            const targetView = btn.getAttribute('data-view');
            if (!targetView || targetView === currentLoginSettingsView) return;
            currentLoginSettingsView = targetView;
            document
                .querySelectorAll('.login-settings-view')
                .forEach((el) => el.classList.toggle('active', el.getAttribute('data-view') === currentLoginSettingsView));
            refreshLoginSettingsContent();
        });
    });

};

const openAddLoginModal = () => {
    const formHTML = `
        <div class="modal-form modern-form team-modal">
            <div class="form-section">
                <div class="form-section-header">
                    <div>
                        <p class="form-eyebrow">LOGIN SETTINGS</p>
                        <h3>Add login account</h3>
                    </div>
                </div>
                <div class="form-grid two-col">
                    <div class="form-field">
                        <label class="form-label" for="login-username">Username (email)</label>
                        <input id="login-username" class="input-control" type="email" required placeholder="user@company.com" />
                    </div>
                    <div class="form-field">
                        <label class="form-label" for="login-employee-name">Employee Name</label>
                        <input id="login-employee-name" class="input-control" type="text" placeholder="Employee Name" />
                    </div>
                    <div class="form-field">
                        <label class="form-label" for="login-access-level">Access Level</label>
                        <select id="login-access-level" class="input-control">
                            ${availableRoles.map(r => `<option value="${r.key}" ${r.key === 'L1' ? 'selected' : ''}>${r.name}</option>`).join('')}
                        </select>
                    </div>
                    <div class="form-field">
                        <label class="form-label" for="login-user-status">User Status</label>
                        <select id="login-user-status" class="input-control">
                            <option value="Active" selected>Active</option>
                            <option value="Locked">Locked</option>
                            <option value="Inactive">Inactive</option>
                        </select>
                    </div>
                    <div class="form-field">
                        <label class="form-label" for="login-attempts">Login Attempts</label>
                        <input id="login-attempts" class="input-control" type="number" min="0" step="1" value="0" />
                    </div>
                </div>
                <p class="helper-text">A default password will be set for new accounts. Users should change it on first login.</p>
            </div>
        </div>
    `;

    renderModal('Add Login Account', formHTML, 'save-login-account-btn');

    const form = document.getElementById('modal-form');
    if (form) {
        form.onsubmit = async (e) => {
            e.preventDefault();
            await handleAddLoginAccount();
        };
    }
};

const openEditLoginModal = (account) => {
    if (!account) return;
    const attempts = typeof account.loginAttempts === 'number' ? account.loginAttempts : 0;

    const formHTML = `
        <div class="modal-form modern-form team-modal">
            <div class="form-section">
                <div class="form-section-header">
                    <div>
                        <p class="form-eyebrow">LOGIN SETTINGS</p>
                        <h3>Edit login account</h3>
                    </div>
                </div>
                <input type="hidden" id="login-edit-id" value="${account.id}" />
                <div class="form-grid two-col">
                    <div class="form-field">
                        <label class="form-label">Username</label>
                        <input class="input-control" type="text" value="${account.username || ''}" disabled />
                    </div>
                    <div class="form-field">
                        <label class="form-label" for="login-edit-employee-name">Employee Name</label>
                        <input id="login-edit-employee-name" class="input-control" type="text" value="${account.employeeName || ''}" />
                    </div>
                    <div class="form-field">
                        <label class="form-label" for="login-edit-access-level">Access Level</label>
                        <select id="login-edit-access-level" class="input-control">
                            ${availableRoles.map(r => `<option value="${r.key}" ${String(account.accessLevel).toUpperCase() === r.key.toUpperCase() ? 'selected' : ''}>${r.name}</option>`).join('')}
                        </select>
                    </div>
                    <div class="form-field">
                        <label class="form-label" for="login-edit-user-status">User Status</label>
                        <select id="login-edit-user-status" class="input-control">
                            <option value="Active" ${account.userStatus === 'Active' ? 'selected' : ''}>Active</option>
                            <option value="Locked" ${account.userStatus === 'Locked' ? 'selected' : ''}>Locked</option>
                            <option value="Inactive" ${account.userStatus === 'Inactive' ? 'selected' : ''}>Inactive</option>
                        </select>
                    </div>
                    <div class="form-field">
                        <label class="form-label" for="login-edit-attempts">Login Attempts</label>
                        <input id="login-edit-attempts" class="input-control" type="number" min="0" step="1" value="${attempts}" />
                    </div>
                    <div class="form-field">
                        <label class="form-label">Last Login</label>
                        <input class="input-control" type="text" value="${formatLastLogin(account.lastLogin)}" disabled />
                    </div>
                </div>
            </div>
        </div>
    `;

    renderModal('Edit Login Account', formHTML, 'update-login-account-btn');

    const form = document.getElementById('modal-form');
    if (form) {
        form.onsubmit = async (e) => {
            e.preventDefault();
            await handleUpdateLoginAccount();
        };
    }
};

const handleAddLoginAccount = async () => {
    try {
        const username = document.getElementById('login-username')?.value.trim();
        const employeeName = document.getElementById('login-employee-name')?.value.trim();
        const accessLevel = document.getElementById('login-access-level')?.value || 'L1';
        const userStatus = document.getElementById('login-user-status')?.value || 'Active';
        const attemptsRaw = document.getElementById('login-attempts')?.value || '0';
        const loginAttempts = Number.isNaN(Number(attemptsRaw)) ? 0 : Number(attemptsRaw);

        if (!username) {
            alert('Username is required');
            return;
        }

        await createLoginAccount({
            username,
            employee_name: employeeName,
            access_level: accessLevel,
            user_status: userStatus,
            login_attempts: loginAttempts,
        });

        closeModal();
        await renderLoginSettingsPage();
    } catch (err) {
        console.error('Error creating login account:', err);
        alert(err.message || 'Failed to create login account');
    }
};

const handleUpdateLoginAccount = async () => {
    try {
        const id = document.getElementById('login-edit-id')?.value;
        if (!id) return;
        const employeeName = document.getElementById('login-edit-employee-name')?.value.trim();
        const accessLevel = document.getElementById('login-edit-access-level')?.value || 'L1';
        const userStatus = document.getElementById('login-edit-user-status')?.value || 'Active';
        const attemptsRaw = document.getElementById('login-edit-attempts')?.value || '0';
        const loginAttempts = Number.isNaN(Number(attemptsRaw)) ? 0 : Number(attemptsRaw);

        await updateLoginAccount(id, {
            employee_name: employeeName,
            access_level: accessLevel,
            user_status: userStatus,
            login_attempts: loginAttempts,
        });

        closeModal();
        await renderLoginSettingsPage();
    } catch (err) {
        console.error('Error updating login account:', err);
        alert(err.message || 'Failed to update login account');
    }
};

const attachRowHandlers = (accounts) => {
    const editButtons = document.querySelectorAll('.login-edit-btn');
    editButtons.forEach((btn) => {
        btn.addEventListener('click', () => {
            const id = btn.getAttribute('data-id');
            const acc = accounts.find((a) => String(a.id) === String(id));
            openEditLoginModal(acc);
        });
    });

    const deleteButtons = document.querySelectorAll('.login-delete-btn');
    deleteButtons.forEach((btn) => {
        btn.addEventListener('click', async () => {
            const id = btn.getAttribute('data-id');
            const acc = accounts.find((a) => String(a.id) === String(id));
            if (!id) return;
            const name = acc?.username || acc?.employeeName || id;
            if (!confirm(`Are you sure you want to delete login for ${name}?`)) return;
            try {
                await deleteLoginAccount(id);
                await renderLoginSettingsPage();
            } catch (err) {
                console.error('Error deleting login account:', err);
                alert(err.message || 'Failed to delete login account');
            }
        });
    });

    const forceLogoutButtons = document.querySelectorAll('.login-force-logout-btn');
    forceLogoutButtons.forEach((btn) => {
        btn.addEventListener('click', async () => {
            const id = btn.getAttribute('data-id');
            const acc = accounts.find((a) => String(a.id) === String(id));
            const employeeId = String(acc?.userId || '').trim().toUpperCase();
            if (!employeeId) {
                alert('Employee ID missing for this login account.');
                return;
            }
            if (!confirm(`Force logout ${acc?.username || employeeId}?`)) return;
            try {
                const result = await triggerForceLogout({
                    employee_id: employeeId,
                    username: acc?.username || '',
                    employee_name: acc?.employeeName || '',
                    requested_by: state.user?.email || state.user?.id || 'admin',
                    reason: 'Admin forced logout',
                    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Calcutta',
                });
                const ac = result.attendance_checkout || {};
                const checkedOut = (ac.checked_out || []).length > 0;
                alert(checkedOut
                    ? `Force logout triggered for ${acc?.username || employeeId}. Attendance timer checked out.`
                    : `Force logout triggered for ${acc?.username || employeeId}. User will be signed out on their next request (within ~10s).`);
                const authData = await fetchAuthSessionEvents({ limit: 200 }).catch(() => ({ items: [] }));
                cachedAuthSessionEvents = authData.items || [];
            } catch (err) {
                alert(err.message || 'Failed to force logout user');
            }
        });
    });
};

export const renderLoginSettingsPage = async () => {
    console.log('⚙️ Rendering Login Settings Page...');

    // Check if user has permission
    if (!canUseFunction('manage_login_settings')) {
        const content = `
            <div class="card">
                <div class="access-denied-content">
                    <i class="fa-solid fa-lock fa-3x error-icon"></i>
                    <h3 class="error-heading">Access Denied</h3>
                    <p>Login Settings is only accessible to administrators, managers, and team leads.</p>
                    <p class="access-denied-note">Please contact your administrator if you need access.</p>
                </div>
            </div>
        `;
        document.getElementById('app-content').innerHTML = getPageContentHTML('Settings', renderSettingsLayout('login-settings', content));
        return;
    }

    const controls = `
        <div class="employee-controls">
            <div class="employee-control-actions">
                <button id="add-login-account-btn" class="btn btn-primary">
                    <i class="fa-solid fa-plus"></i> ADD LOGIN ACCOUNT
                </button>
            </div>
        </div>
    `;

    const loadingContent = `
        <div class="card">
            <h3><i class="fa-solid fa-user-shield"></i> Login Accounts</h3>
            <p class="placeholder-text">⏳ Loading login accounts...</p>
        </div>
    `;

    document.getElementById('app-content').innerHTML = getPageContentHTML('Settings', renderSettingsLayout('login-settings', loadingContent), controls);

    try {
        // Fetch login accounts and login events in parallel
        const [accounts, loginEventsData, employeeDirectory, authEventsData, customRoles] = await Promise.all([
            listLoginAccounts(),
            fetchLoginEvents().catch(() => ({ daily_summary: [] })),
            listAllEmployees().catch(() => []),
            fetchAuthSessionEvents({ limit: 200 }).catch(() => ({ items: [] })),
            fetchCustomRoles().catch(() => [])
        ]);
        
        availableRoles = [...DEFAULT_ROLES, ...customRoles];
        cachedLoginAccounts = accounts;
        cachedLoginActivitySummary = loginEventsData.daily_summary || [];
        cachedAuthSessionEvents = authEventsData.items || [];
        cachedEmployeeDirectory = employeeDirectory;
        buildLoginAccountNameIndex(cachedLoginAccounts, cachedEmployeeDirectory);

        const layoutHTML = buildLoginSettingsLayout(cachedLoginAccounts, cachedLoginActivitySummary, cachedAuthSessionEvents);
        document.getElementById('app-content').innerHTML = getPageContentHTML('Settings', renderSettingsLayout('login-settings', layoutHTML), controls);

        const addBtn = document.getElementById('add-login-account-btn');
        if (addBtn) {
            addBtn.onclick = () => {
                openAddLoginModal();
            };
            addBtn.style.display = currentLoginSettingsView === 'accounts' ? 'inline-flex' : 'none';
        }

        attachLoginSettingsViewHandlers();
        refreshLoginSettingsContent();
    } catch (err) {
        console.error('❌ Error loading login settings:', err);
        const errorContent = `
            <div class="card">
                <h3><i class="fa-solid fa-user-shield"></i> Login Accounts</h3>
                <p class="placeholder-text error-message">Error loading login accounts.</p>
            </div>
        `;
        document.getElementById('app-content').innerHTML = getPageContentHTML('Settings', renderSettingsLayout('login-settings', errorContent), controls);
    }
};
