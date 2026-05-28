import { getPageContentHTML } from '../utils.js';
import { canUseFunction } from '../utils/roleSettings.js';
import { renderSettingsLayout } from '../components/settingsLayout.js';
import { renderModal, closeModal } from '../components/modal.js';
import { listEmployees } from '../features/employeeApi.js';
import { fetchShiftSettings, updateEmployeeShiftSetting } from '../features/shiftSettingsApi.js';

const DEFAULT_GRACE_MINUTES = 15;
const MIN_SHIFT_HOURS = 9;
const DEFAULT_WORK_WEEK = 'mon-sat';

const parseTimeToMinutes = (timeValue) => {
    const parts = String(timeValue || '').split(':');
    if (parts.length !== 2) return null;
    const hh = Number(parts[0]);
    const mm = Number(parts[1]);
    if (!Number.isInteger(hh) || !Number.isInteger(mm)) return null;
    if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
    return (hh * 60) + mm;
};

const getShiftDurationHours = (start, end) => {
    const startMinutes = parseTimeToMinutes(start);
    const endMinutes = parseTimeToMinutes(end);
    if (startMinutes === null || endMinutes === null) return 0;
    const diff = endMinutes - startMinutes;
    return diff / 60;
};

const isValidShiftWindow = (start, end) => getShiftDurationHours(start, end) >= MIN_SHIFT_HOURS;

const formatWorkWeek = (value) => (String(value || DEFAULT_WORK_WEEK).toLowerCase() === 'mon-fri' ? 'Mon-Fri' : 'Mon-Sat');

const buildShiftTable = (rows = []) => `
    <div class="card">
        <h3><i class="fa-solid fa-business-time"></i> Employee Shift Settings</h3>
        <p class="allocation-description">Set per-employee shift timings. Grace time is fixed at 15 minutes. Minimum shift length is 9 hours.</p>
        <div class="table-container">
            <table class="table">
                <thead>
                    <tr>
                        <th>Employee ID</th>
                        <th>Employee Name</th>
                        <th>Shift Start</th>
                        <th>Shift End</th>
                        <th>Work Week</th>
                        <th>Grace Time</th>
                        <th>Shift Duration</th>
                        <th>Actions</th>
                    </tr>
                </thead>
                <tbody>
                    ${rows.map((row) => `
                        <tr>
                            <td><strong>${row.employee_id}</strong></td>
                            <td>${row.employee_name || row.employee_id}</td>
                            <td>${row.shift_start}</td>
                            <td>${row.shift_end}</td>
                            <td>${formatWorkWeek(row.work_week)}</td>
                            <td>${row.grace_minutes} mins</td>
                            <td>${row.duration_hours.toFixed(2)}h</td>
                            <td>
                                <button
                                    type="button"
                                    class="icon-btn edit-shift-btn"
                                    title="Edit shift"
                                    data-employee-id="${row.employee_id}"
                                    data-employee-name="${row.employee_name || row.employee_id}"
                                    data-shift-start="${row.shift_start}"
                                    data-shift-end="${row.shift_end}"
                                    data-work-week="${row.work_week}"
                                >
                                    <i class="fa-solid fa-pen-to-square"></i>
                                </button>
                            </td>
                        </tr>
                    `).join('') || '<tr><td colspan="8" class="placeholder-text">No employees found.</td></tr>'}
                </tbody>
            </table>
        </div>
    </div>
`;

const openEditShiftModal = (employeeId, employeeName, shiftStart, shiftEnd, workWeek) => {
    const body = `
        <div class="modal-form modern-form team-modal">
            <div class="form-section">
                <div class="form-section-header">
                    <div>
                        <p class="form-eyebrow">SHIFT SETTINGS</p>
                        <h3>Edit shift timing</h3>
                    </div>
                </div>
                <input type="hidden" id="shift-employee-id" value="${employeeId}" />
                <div class="form-grid two-col">
                    <div class="form-field">
                        <label class="form-label">Employee</label>
                        <input class="input-control" type="text" value="${employeeName} (${employeeId})" disabled />
                    </div>
                    <div class="form-field">
                        <label class="form-label">Grace Time</label>
                        <input class="input-control" type="text" value="${DEFAULT_GRACE_MINUTES} minutes (fixed)" disabled />
                    </div>
                    <div class="form-field">
                        <label class="form-label" for="shift-start">Shift Start</label>
                        <input id="shift-start" class="input-control" type="time" value="${shiftStart}" required />
                    </div>
                    <div class="form-field">
                        <label class="form-label" for="shift-end">Shift End</label>
                        <input id="shift-end" class="input-control" type="time" value="${shiftEnd}" required />
                    </div>
                    <div class="form-field">
                        <label class="form-label" for="work-week">Work Week</label>
                        <select id="work-week" class="input-control">
                            <option value="mon-fri" ${String(workWeek).toLowerCase() === 'mon-fri' ? 'selected' : ''}>Mon-Fri</option>
                            <option value="mon-sat" ${String(workWeek || DEFAULT_WORK_WEEK).toLowerCase() !== 'mon-fri' ? 'selected' : ''}>Mon-Sat</option>
                        </select>
                    </div>
                </div>
                <p class="helper-text">Shift end time must be at least ${MIN_SHIFT_HOURS} hours after shift start.</p>
            </div>
        </div>
    `;

    renderModal('Edit Shift', body, [
        { id: 'cancel-shift-btn', text: 'Cancel', className: 'btn btn-secondary', type: 'button' },
        { id: 'save-shift-btn', text: 'Save Changes', className: 'btn btn-primary', type: 'button' },
    ]);

    const cancelBtn = document.getElementById('cancel-shift-btn');
    if (cancelBtn) cancelBtn.onclick = () => closeModal?.();

    const saveBtn = document.getElementById('save-shift-btn');
    if (!saveBtn) return;
    saveBtn.onclick = async () => {
        const start = document.getElementById('shift-start')?.value;
        const end = document.getElementById('shift-end')?.value;
        const selectedWorkWeek = String(document.getElementById('work-week')?.value || DEFAULT_WORK_WEEK).toLowerCase();
        if (!start || !end) {
            alert('Shift start and end time are required.');
            return;
        }
        if (!['mon-fri', 'mon-sat'].includes(selectedWorkWeek)) {
            alert('Please select a valid work week.');
            return;
        }
        if (!isValidShiftWindow(start, end)) {
            alert(`Shift timing should be minimum ${MIN_SHIFT_HOURS} hours.`);
            return;
        }

        try {
            await updateEmployeeShiftSetting({
                employee_id: employeeId,
                shift_start: start,
                shift_end: end,
                grace_minutes: DEFAULT_GRACE_MINUTES,
                work_week: selectedWorkWeek,
            });
            closeModal?.();
            await renderShiftSettingsPage();
        } catch (err) {
            alert(err.message || 'Failed to update shift setting');
        }
    };
};

const attachShiftHandlers = () => {
    document.querySelectorAll('.edit-shift-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            openEditShiftModal(
                btn.getAttribute('data-employee-id'),
                btn.getAttribute('data-employee-name'),
                btn.getAttribute('data-shift-start'),
                btn.getAttribute('data-shift-end'),
                btn.getAttribute('data-work-week')
            );
        });
    });
};

export const renderShiftSettingsPage = async () => {
    if (!canUseFunction('manage_shift_settings')) {
        const denied = `
            <div class="card">
                <div class="access-denied-content">
                    <i class="fa-solid fa-lock fa-3x error-icon"></i>
                    <h3 class="error-heading">Access Denied</h3>
                    <p>Shift Settings is only accessible to administrators.</p>
                </div>
            </div>
        `;
        document.getElementById('app-content').innerHTML = getPageContentHTML('Settings', renderSettingsLayout('shift-settings', denied));
        return;
    }

    const loading = `
        <div class="card">
            <h3><i class="fa-solid fa-business-time"></i> Employee Shift Settings</h3>
            <p class="placeholder-text">Loading shift settings...</p>
        </div>
    `;
    document.getElementById('app-content').innerHTML = getPageContentHTML('Settings', renderSettingsLayout('shift-settings', loading));

    try {
        const [employeeRes, shiftRes] = await Promise.all([
            listEmployees(1, 5000),
            fetchShiftSettings(),
        ]);
        const employees = employeeRes.items || [];
        const byEmployee = shiftRes.by_employee || {};
        const defaults = shiftRes.defaults || {
            shift_start: '09:00',
            shift_end: '18:00',
            grace_minutes: DEFAULT_GRACE_MINUTES,
            work_week: DEFAULT_WORK_WEEK,
        };

        const rows = employees
            .map((emp) => {
                const employeeId = String(emp.employee_id || emp.id || '').toUpperCase();
                if (!employeeId) return null;
                const entry = byEmployee[employeeId] || {};
                const shiftStart = entry.shift_start || defaults.shift_start;
                const shiftEnd = entry.shift_end || defaults.shift_end;
                const workWeek = String(entry.work_week || defaults.work_week || DEFAULT_WORK_WEEK).toLowerCase() === 'mon-fri' ? 'mon-fri' : 'mon-sat';
                return {
                    employee_id: employeeId,
                    employee_name: `${emp.first_name || ''} ${emp.last_name || ''}`.trim() || emp.name || employeeId,
                    shift_start: shiftStart,
                    shift_end: shiftEnd,
                    work_week: workWeek,
                    grace_minutes: Number(entry.grace_minutes || defaults.grace_minutes || DEFAULT_GRACE_MINUTES),
                    duration_hours: getShiftDurationHours(shiftStart, shiftEnd),
                };
            })
            .filter(Boolean)
            .sort((a, b) => a.employee_id.localeCompare(b.employee_id));

        const html = buildShiftTable(rows);
        document.getElementById('app-content').innerHTML = getPageContentHTML('Settings', renderSettingsLayout('shift-settings', html));
        attachShiftHandlers();
    } catch (err) {
        const errorHTML = `
            <div class="card">
                <h3><i class="fa-solid fa-business-time"></i> Employee Shift Settings</h3>
                <p class="placeholder-text error-message">Error loading shift settings: ${err.message || err}</p>
            </div>
        `;
        document.getElementById('app-content').innerHTML = getPageContentHTML('Settings', renderSettingsLayout('shift-settings', errorHTML));
    }
};
