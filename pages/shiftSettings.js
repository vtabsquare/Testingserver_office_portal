import { getPageContentHTML } from '../utils.js';
import { canUseFunction, canViewApplication } from '../utils/roleSettings.js';
import { renderSettingsLayout } from '../components/settingsLayout.js';
import { renderModal, closeModal } from '../components/modal.js';
import { listEmployees } from '../features/employeeApi.js';
import {
    fetchShiftSettings,
    updateEmployeeShiftSetting,
    createShiftPreset,
    updateShiftPreset,
    deleteShiftPreset,
} from '../features/shiftSettingsApi.js';

const DEFAULT_GRACE_MINUTES = 15;
const DEFAULT_TOLERANCE_MINUTES = 15;
const TOLERANCE_OPTIONS = [0, 5, 10, 15, 20, 30, 45, 60];
const MIN_SHIFT_HOURS = 2;
const DEFAULT_WORK_WEEK = 'mon-sat';

let cachedPresets = [];

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

const formatHoursMinutes = (totalHours) => {
    const h = Math.floor(totalHours);
    const m = Math.round((totalHours - h) * 60);
    if (m === 0) return `${h}h`;
    return `${h}h ${m}m`;
};

const presentHoursForTolerance = (start, end, toleranceMinutes = DEFAULT_TOLERANCE_MINUTES) => {
    const durationH = getShiftDurationHours(start, end);
    if (durationH <= 0) return 0;
    return Math.max(0, durationH - (Number(toleranceMinutes) || 0) / 60);
};

const toleranceSelectHtml = (id, selected = DEFAULT_TOLERANCE_MINUTES) => {
    const sel = Number(selected) || DEFAULT_TOLERANCE_MINUTES;
    return `
        <select id="${id}" class="input-control">
            ${TOLERANCE_OPTIONS.map((m) => `
                <option value="${m}" ${sel === m ? 'selected' : ''}>${m} minutes</option>
            `).join('')}
        </select>
    `;
};

const updateTolerancePreview = (startId, endId, toleranceId, previewId) => {
    const start = document.getElementById(startId)?.value;
    const end = document.getElementById(endId)?.value;
    const tol = Number(document.getElementById(toleranceId)?.value || DEFAULT_TOLERANCE_MINUTES);
    const el = document.getElementById(previewId);
    if (!el || !start || !end) return;
    const presentH = presentHoursForTolerance(start, end, tol);
    el.textContent = `Present at ${formatHoursMinutes(presentH)} worked (${formatHoursMinutes(getShiftDurationHours(start, end))} shift − ${tol} min tolerance). Half day remains 50% of shift.`;
};

const PROTECTED_PRESET_NAMES = new Set(['shift 1', 'shift 2']);

const canDeletePreset = (preset) => {
    if (preset && typeof preset.can_delete === 'boolean') return preset.can_delete;
    return !PROTECTED_PRESET_NAMES.has(String(preset?.name || '').trim().toLowerCase());
};

const buildPresetsSection = (presets = []) => `
    <div class="card" style="margin-bottom: 1.25rem;">
        <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 1rem; flex-wrap: wrap;">
            <div>
                <h3><i class="fa-solid fa-clock"></i> Shift Presets</h3>
                <p class="allocation-description">Define reusable shift timings and work weeks, then assign a preset to each employee below.</p>
            </div>
            <button type="button" class="btn btn-primary" id="add-shift-preset-btn">
                <i class="fa-solid fa-plus"></i> Add Preset
            </button>
        </div>
        <div class="table-container">
            <table class="table">
                <thead>
                    <tr>
                        <th>Preset Name</th>
                        <th>Shift Start</th>
                        <th>Shift End</th>
                        <th>Work Week</th>
                        <th>Late Grace</th>
                        <th>Tolerance</th>
                        <th>Duration</th>
                        <th>Actions</th>
                    </tr>
                </thead>
                <tbody>
                    ${presets.map((p) => `
                        <tr>
                            <td><strong>${p.name}</strong></td>
                            <td>${p.shift_start}</td>
                            <td>${p.shift_end}</td>
                            <td>${formatWorkWeek(p.work_week)}</td>
                            <td>${p.grace_minutes || DEFAULT_GRACE_MINUTES} mins</td>
                            <td>${p.tolerance_minutes ?? DEFAULT_TOLERANCE_MINUTES} mins</td>
                            <td>${getShiftDurationHours(p.shift_start, p.shift_end).toFixed(2)}h</td>
                            <td style="display: flex; gap: 0.35rem; align-items: center;">
                                <button
                                    type="button"
                                    class="icon-btn edit-preset-btn"
                                    title="Edit preset"
                                    data-preset-id="${p.id}"
                                    data-preset-name="${p.name}"
                                    data-shift-start="${p.shift_start}"
                                    data-shift-end="${p.shift_end}"
                                    data-work-week="${p.work_week}"
                                    data-tolerance-minutes="${p.tolerance_minutes ?? DEFAULT_TOLERANCE_MINUTES}"
                                >
                                    <i class="fa-solid fa-pen-to-square"></i>
                                </button>
                                ${canDeletePreset(p) ? `
                                <button
                                    type="button"
                                    class="icon-btn delete-preset-btn"
                                    title="Delete preset"
                                    data-preset-id="${p.id}"
                                    data-preset-name="${p.name}"
                                >
                                    <i class="fa-solid fa-trash"></i>
                                </button>
                                ` : ''}
                            </td>
                        </tr>
                    `).join('') || '<tr><td colspan="8" class="placeholder-text">No presets yet. Add Shift 1, Shift 2, etc.</td></tr>'}
                </tbody>
            </table>
        </div>
    </div>
`;

const buildShiftTable = (rows = []) => `
    <div class="card">
        <h3><i class="fa-solid fa-business-time"></i> Employee Shift Settings</h3>
        <p class="allocation-description">Assign a shift preset or set custom timings per employee. Late grace is 15 minutes (fixed). Tolerance sets how early someone can be marked Present (shift duration − tolerance). Minimum shift length is 2 hours; half day is 50% of shift.</p>
        <div class="table-container">
            <table class="table">
                <thead>
                    <tr>
                        <th>Employee ID</th>
                        <th>Employee Name</th>
                        <th>Assigned Shift</th>
                        <th>Shift Start</th>
                        <th>Shift End</th>
                        <th>Work Week</th>
                        <th>Late Grace</th>
                        <th>Tolerance</th>
                        <th>Shift Duration</th>
                        <th>Actions</th>
                    </tr>
                </thead>
                <tbody>
                    ${rows.map((row) => `
                        <tr>
                            <td><strong>${row.employee_id}</strong></td>
                            <td>${row.employee_name || row.employee_id}</td>
                            <td>${row.preset_name || 'Custom'}</td>
                            <td>${row.shift_start}</td>
                            <td>${row.shift_end}</td>
                            <td>${formatWorkWeek(row.work_week)}</td>
                            <td>${row.grace_minutes} mins</td>
                            <td>${row.tolerance_minutes ?? DEFAULT_TOLERANCE_MINUTES} mins</td>
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
                                    data-tolerance-minutes="${row.tolerance_minutes ?? DEFAULT_TOLERANCE_MINUTES}"
                                    data-preset-id="${row.preset_id || ''}"
                                >
                                    <i class="fa-solid fa-pen-to-square"></i>
                                </button>
                            </td>
                        </tr>
                    `).join('') || '<tr><td colspan="10" class="placeholder-text">No employees found.</td></tr>'}
                </tbody>
            </table>
        </div>
    </div>
`;

const presetOptionsHtml = (selectedId = '') => {
    const options = cachedPresets.map((p) => `
        <option value="${p.id}" ${String(selectedId) === String(p.id) ? 'selected' : ''}>${p.name} (${p.shift_start}–${p.shift_end}, ${formatWorkWeek(p.work_week)})</option>
    `).join('');
    return `<option value="">— Custom timings —</option>${options}`;
};

const toggleCustomFields = (useCustom) => {
    const start = document.getElementById('shift-start');
    const end = document.getElementById('shift-end');
    const week = document.getElementById('work-week');
    if (start) start.disabled = !useCustom;
    if (end) end.disabled = !useCustom;
    if (week) week.disabled = !useCustom;
};

const onPresetSelectChange = () => {
    const select = document.getElementById('shift-preset-select');
    const presetId = select?.value || '';
    const useCustom = !presetId;
    toggleCustomFields(useCustom);
    if (!useCustom) {
        const preset = cachedPresets.find((p) => String(p.id) === String(presetId));
        if (preset) {
            const start = document.getElementById('shift-start');
            const end = document.getElementById('shift-end');
            const week = document.getElementById('work-week');
            if (start) start.value = preset.shift_start;
            if (end) end.value = preset.shift_end;
            if (week) week.value = preset.work_week;
        }
    }
};

const openEditShiftModal = (
    employeeId,
    employeeName,
    shiftStart,
    shiftEnd,
    workWeek,
    presetId = '',
    toleranceMinutes = DEFAULT_TOLERANCE_MINUTES
) => {
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
                        <label class="form-label">Late Grace</label>
                        <input class="input-control" type="text" value="${DEFAULT_GRACE_MINUTES} minutes (fixed)" disabled />
                    </div>
                    <div class="form-field">
                        <label class="form-label" for="shift-tolerance">Tolerance (Present)</label>
                        ${toleranceSelectHtml('shift-tolerance', toleranceMinutes)}
                        <p class="helper-text">Worked time needed: shift length minus this value.</p>
                    </div>
                    <div class="form-field" style="grid-column: 1 / -1;">
                        <label class="form-label" for="shift-preset-select">Assign Shift Preset</label>
                        <select id="shift-preset-select" class="input-control">
                            ${presetOptionsHtml(presetId)}
                        </select>
                        <p class="helper-text">Choose a preset to apply its timings, or select custom to set times manually.</p>
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
                <p class="helper-text" id="shift-tolerance-preview"></p>
            </div>
        </div>
    `;

    renderModal('Edit Shift', body, [
        { id: 'cancel-shift-btn', text: 'Cancel', className: 'btn btn-secondary', type: 'button' },
        { id: 'save-shift-btn', text: 'Save Changes', className: 'btn btn-primary', type: 'button' },
    ]);

    const presetSelect = document.getElementById('shift-preset-select');
    if (presetSelect) {
        presetSelect.onchange = () => {
            onPresetSelectChange();
            const presetId = presetSelect.value;
            const preset = cachedPresets.find((p) => String(p.id) === String(presetId));
            const tolEl = document.getElementById('shift-tolerance');
            if (preset && tolEl) {
                tolEl.value = String(preset.tolerance_minutes ?? DEFAULT_TOLERANCE_MINUTES);
            }
            updateTolerancePreview('shift-start', 'shift-end', 'shift-tolerance', 'shift-tolerance-preview');
        };
        onPresetSelectChange();
    }
    ['shift-start', 'shift-end', 'shift-tolerance'].forEach((id) => {
        document.getElementById(id)?.addEventListener('change', () => {
            updateTolerancePreview('shift-start', 'shift-end', 'shift-tolerance', 'shift-tolerance-preview');
        });
    });
    updateTolerancePreview('shift-start', 'shift-end', 'shift-tolerance', 'shift-tolerance-preview');

    const cancelBtn = document.getElementById('cancel-shift-btn');
    if (cancelBtn) cancelBtn.onclick = () => closeModal?.();

    const saveBtn = document.getElementById('save-shift-btn');
    if (!saveBtn) return;
    saveBtn.onclick = async () => {
        const selectedPresetId = String(document.getElementById('shift-preset-select')?.value || '').trim();
        const useCustom = !selectedPresetId;
        const start = document.getElementById('shift-start')?.value;
        const end = document.getElementById('shift-end')?.value;
        const selectedWorkWeek = String(document.getElementById('work-week')?.value || DEFAULT_WORK_WEEK).toLowerCase();

        if (useCustom) {
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
        }

        const toleranceMinutes = Number(
            document.getElementById('shift-tolerance')?.value || DEFAULT_TOLERANCE_MINUTES
        );

        try {
            const payload = {
                employee_id: employeeId,
                grace_minutes: DEFAULT_GRACE_MINUTES,
                tolerance_minutes: toleranceMinutes,
            };
            if (selectedPresetId) {
                payload.preset_id = selectedPresetId;
                payload.use_custom = false;
            } else {
                payload.use_custom = true;
                payload.shift_start = start;
                payload.shift_end = end;
                payload.work_week = selectedWorkWeek;
            }
            await updateEmployeeShiftSetting(payload);
            closeModal?.();
            await renderShiftSettingsPage();
        } catch (err) {
            alert(err.message || 'Failed to update shift setting');
        }
    };
};

const openPresetModal = (preset = null) => {
    const isEdit = Boolean(preset?.id);
    const title = isEdit ? 'Edit Shift Preset' : 'Add Shift Preset';
    const body = `
        <div class="modal-form modern-form team-modal">
            <div class="form-section">
                <input type="hidden" id="preset-id" value="${preset?.id || ''}" />
                <div class="form-grid two-col">
                    <div class="form-field">
                        <label class="form-label" for="preset-name">Preset Name</label>
                        <input id="preset-name" class="input-control" type="text" value="${preset?.name || ''}" placeholder="e.g. Shift 1" required />
                    </div>
                    <div class="form-field">
                        <label class="form-label">Late Grace</label>
                        <input class="input-control" type="text" value="${DEFAULT_GRACE_MINUTES} minutes (fixed)" disabled />
                    </div>
                    <div class="form-field">
                        <label class="form-label" for="preset-tolerance">Tolerance (Present)</label>
                        ${toleranceSelectHtml('preset-tolerance', preset?.tolerance_minutes ?? DEFAULT_TOLERANCE_MINUTES)}
                    </div>
                    <div class="form-field">
                        <label class="form-label" for="preset-shift-start">Shift Start</label>
                        <input id="preset-shift-start" class="input-control" type="time" value="${preset?.shift_start || '09:00'}" required />
                    </div>
                    <div class="form-field">
                        <label class="form-label" for="preset-shift-end">Shift End</label>
                        <input id="preset-shift-end" class="input-control" type="time" value="${preset?.shift_end || '18:00'}" required />
                    </div>
                    <div class="form-field">
                        <label class="form-label" for="preset-work-week">Work Week</label>
                        <select id="preset-work-week" class="input-control">
                            <option value="mon-fri" ${String(preset?.work_week || '').toLowerCase() === 'mon-fri' ? 'selected' : ''}>Mon-Fri</option>
                            <option value="mon-sat" ${String(preset?.work_week || DEFAULT_WORK_WEEK).toLowerCase() !== 'mon-fri' ? 'selected' : ''}>Mon-Sat</option>
                        </select>
                    </div>
                </div>
                <p class="helper-text">Minimum shift length is ${MIN_SHIFT_HOURS} hours. Employees assigned this preset will use these timings.</p>
                <p class="helper-text" id="preset-tolerance-preview"></p>
            </div>
        </div>
    `;

    renderModal(title, body, [
        { id: 'cancel-preset-btn', text: 'Cancel', className: 'btn btn-secondary', type: 'button' },
        { id: 'save-preset-btn', text: 'Save Preset', className: 'btn btn-primary', type: 'button' },
    ]);

    ['preset-shift-start', 'preset-shift-end', 'preset-tolerance'].forEach((id) => {
        document.getElementById(id)?.addEventListener('change', () => {
            updateTolerancePreview(
                'preset-shift-start',
                'preset-shift-end',
                'preset-tolerance',
                'preset-tolerance-preview'
            );
        });
    });
    updateTolerancePreview(
        'preset-shift-start',
        'preset-shift-end',
        'preset-tolerance',
        'preset-tolerance-preview'
    );

    document.getElementById('cancel-preset-btn')?.addEventListener('click', () => closeModal?.());

    document.getElementById('save-preset-btn')?.addEventListener('click', async () => {
        const name = document.getElementById('preset-name')?.value?.trim();
        const start = document.getElementById('preset-shift-start')?.value;
        const end = document.getElementById('preset-shift-end')?.value;
        const workWeek = String(document.getElementById('preset-work-week')?.value || DEFAULT_WORK_WEEK).toLowerCase();
        const id = document.getElementById('preset-id')?.value?.trim();

        if (!name) {
            alert('Preset name is required.');
            return;
        }
        if (!start || !end || !isValidShiftWindow(start, end)) {
            alert(`Shift timing should be minimum ${MIN_SHIFT_HOURS} hours.`);
            return;
        }

        const toleranceMinutes = Number(
            document.getElementById('preset-tolerance')?.value || DEFAULT_TOLERANCE_MINUTES
        );

        try {
            const payload = {
                name,
                shift_start: start,
                shift_end: end,
                work_week: workWeek,
                tolerance_minutes: toleranceMinutes,
            };
            if (id) {
                await updateShiftPreset(id, payload);
            } else {
                await createShiftPreset(payload);
            }
            closeModal?.();
            await renderShiftSettingsPage();
        } catch (err) {
            alert(err.message || 'Failed to save preset');
        }
    });
};

const attachShiftHandlers = () => {
    document.querySelectorAll('.edit-shift-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            openEditShiftModal(
                btn.getAttribute('data-employee-id'),
                btn.getAttribute('data-employee-name'),
                btn.getAttribute('data-shift-start'),
                btn.getAttribute('data-shift-end'),
                btn.getAttribute('data-work-week'),
                btn.getAttribute('data-preset-id') || '',
                btn.getAttribute('data-tolerance-minutes') || DEFAULT_TOLERANCE_MINUTES
            );
        });
    });

    document.getElementById('add-shift-preset-btn')?.addEventListener('click', () => openPresetModal());

    document.querySelectorAll('.edit-preset-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            openPresetModal({
                id: btn.getAttribute('data-preset-id'),
                name: btn.getAttribute('data-preset-name'),
                shift_start: btn.getAttribute('data-shift-start'),
                shift_end: btn.getAttribute('data-shift-end'),
                work_week: btn.getAttribute('data-work-week'),
                tolerance_minutes: btn.getAttribute('data-tolerance-minutes') || DEFAULT_TOLERANCE_MINUTES,
            });
        });
    });

    document.querySelectorAll('.delete-preset-btn').forEach((btn) => {
        btn.addEventListener('click', async () => {
            const presetId = btn.getAttribute('data-preset-id');
            const presetName = btn.getAttribute('data-preset-name') || 'this preset';
            if (!presetId) return;
            if (!window.confirm(`Delete "${presetName}"? Employees assigned to it will keep their last saved timings as custom.`)) {
                return;
            }
            try {
                await deleteShiftPreset(presetId);
                await renderShiftSettingsPage();
            } catch (err) {
                alert(err.message || 'Failed to delete preset');
            }
        });
    });
};

export const renderShiftSettingsPage = async () => {
    if (!canUseFunction('manage_shift_settings') && !canViewApplication('shift_settings')) {
        const denied = `
            <div class="card">
                <div class="access-denied-content">
                    <i class="fa-solid fa-lock fa-3x error-icon"></i>
                    <h3 class="error-heading">Access Denied</h3>
                    <p>You don't have permission to manage Shift Settings. Please ask your administrator to grant you access.</p>
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
        const shiftRes = await fetchShiftSettings();
        const employeeRes = await listEmployees(1, 5000).catch((empErr) => {
            console.warn('[shift-settings] Employee list unavailable:', empErr);
            return { items: [] };
        });
        const employees = employeeRes.items || [];
        const byEmployee = shiftRes.by_employee || {};
        const presets = shiftRes.presets || [];
        cachedPresets = presets;
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
                    tolerance_minutes: Number(
                        entry.tolerance_minutes ?? defaults.tolerance_minutes ?? DEFAULT_TOLERANCE_MINUTES
                    ),
                    duration_hours: getShiftDurationHours(shiftStart, shiftEnd),
                    preset_id: entry.preset_id || null,
                    preset_name: entry.preset_name || null,
                };
            })
            .filter(Boolean)
            .sort((a, b) => a.employee_id.localeCompare(b.employee_id));

        const html = buildPresetsSection(presets) + buildShiftTable(rows);
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
