import { state } from '../state.js';
import { getPageContentHTML } from '../utils.js';
import { renderModal, closeModal } from '../components/modal.js';
import { listEmployees, listAllEmployees, createEmployee, updateEmployee, deleteEmployee } from '../features/employeeApi.js';
import { getUserAccessContext } from '../utils/accessControl.js';

import { cachedFetch, TTL, clearCacheByPrefix } from '../features/cache.js';
import { API_BASE_URL } from '../config.js';

let empCurrentPage = 1;
const EMP_PAGE_SIZE = 10;
let parsedEmployees = [];
let bulkDeleteFilter = '';
let bulkDeleteSelected = new Set();
let lastDeletedEmployees = [];
let bulkDeleteEmployees = [];
let bulkDeleteSortType = 'id';
let bulkDeleteSortOrder = 'asc';
let restoreSelected = new Set();
let restoreFilter = '';
let currentDeletedEmployees = []; // Store current deleted employees for restore modal
let hasDeletedEmployees = false; // Track if deleted employees exist in backend
let employeeViewMode = 'card';
let photoDraft = { dataUrl: null, cleared: false };
let initialPhotoRef = null;

const cleanDataUrl = (dataUrl) => {
    if (!dataUrl || typeof dataUrl !== 'string') return undefined;
    const parts = dataUrl.split(',', 1);
    if (parts.length === 0) return undefined;
    const raw = dataUrl.includes(',') ? dataUrl.split(',', 2)[1] : dataUrl;
    return raw && raw.trim() ? raw.trim() : undefined;
};

const normalizePhoto = (photo) => {
    if (!photo || typeof photo !== 'string') return null;
    const trimmed = photo.trim();
    if (!trimmed) return null;
    if (trimmed.startsWith('data:')) return trimmed;
    return `data:image/png;base64,${trimmed}`;
};

const compareEmployeeIdAsc = (a, b) => {
    const idA = String(a?.id || '').trim();
    const idB = String(b?.id || '').trim();
    if (!idA && !idB) return 0;
    if (!idA) return 1;
    if (!idB) return -1;
    return idA.localeCompare(idB, undefined, { numeric: true, sensitivity: 'base' });
};

const getEmployeeAccess = () => {
    try {
        const { role, isAdmin, isManager } = getUserAccessContext();
        const isTeamLead = role === 'L4';
        const canManageEmployees = isAdmin || isManager;
        return { isTeamLead, canManageEmployees };
    } catch {
        return { isTeamLead: false, canManageEmployees: false };
    }
};

const isInternRecord = (employee = {}) => {
    const flag = String(employee.employeeFlag || '').trim().toLowerCase();
    const designation = String(employee.jobTitle || '').trim().toLowerCase();
    return flag === 'intern' || designation.includes('intern');
};

const applyHeaderAvatar = () => {
    const headerAvatar = document.querySelector('.user-profile .user-avatar');
    if (!headerAvatar) return;
    const photo = normalizePhoto(state.user?.avatarUrl);
    const initials = state.user?.initials || (state.user?.name || 'U').split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase();
    if (photo) {
        headerAvatar.classList.add('has-photo');
        headerAvatar.style.backgroundImage = `url('${photo}')`;
        headerAvatar.textContent = '';
    } else {
        headerAvatar.classList.remove('has-photo');
        headerAvatar.style.backgroundImage = '';
        headerAvatar.textContent = initials;
    }
};

const initPhotoUploader = (initialPhoto = null) => {
    initialPhotoRef = initialPhoto;
    const input = document.getElementById('photo-input');
    const trigger = document.getElementById('upload-photo-btn');
    const removeBtn = document.getElementById('remove-photo-btn');
    const preview = document.getElementById('photo-preview');

    const applyPreview = () => {
        const activePhoto = photoDraft.dataUrl ?? (photoDraft.cleared ? null : initialPhotoRef);
        if (activePhoto) {
            preview?.classList.add('has-photo');
            if (preview) preview.style.backgroundImage = `url('${activePhoto}')`;
            if (preview) preview.textContent = '';
        } else {
            preview?.classList.remove('has-photo');
            if (preview) preview.style.backgroundImage = '';
            if (preview) preview.textContent = 'No photo';
        }
    };

    applyPreview();

    if (trigger && input) {
        trigger.addEventListener('click', () => input.click());
        input.addEventListener('change', (ev) => {
            const file = ev.target.files && ev.target.files[0];
            if (!file) return;
            if (!file.type.startsWith('image/')) {
                alert('Please select an image file');
                return;
            }
            if (file.size > 1_000_000) {
                const proceed = confirm('Image is larger than 1MB. Continue?');
                if (!proceed) return;
            }
            const reader = new FileReader();
            reader.onload = () => {
                photoDraft = { dataUrl: typeof reader.result === 'string' ? reader.result : null, cleared: false };
                applyPreview();
            };
            reader.readAsDataURL(file);
        });
    }

    if (removeBtn) {
        removeBtn.addEventListener('click', () => {
            photoDraft = { dataUrl: null, cleared: true };
            if (input) input.value = '';
            applyPreview();
        });
    }
};

export const renderEmployeesPage = async (filter = '', page = empCurrentPage) => {
    const isTableMode = employeeViewMode === 'table';
    const { isTeamLead, canManageEmployees } = getEmployeeAccess();
    const controls = `
        <div class="employee-controls">
            <div class="employee-view-toggle" aria-label="Toggle employees view">
                <button id="employee-card-view-btn" class="view-toggle-btn ${isTableMode ? '' : 'active'}" title="Card view">
                    <i class="fa-solid fa-grip"></i>
                </button>
                <button id="employee-table-view-btn" class="view-toggle-btn ${isTableMode ? 'active' : ''}" title="Table view">
                    <i class="fa-solid fa-table"></i>
                </button>
            </div>
            <div class="employee-control-actions">
                ${canManageEmployees ? `
                <button id="add-employee-btn" class="btn btn-primary"><i class="fa-solid fa-plus"></i> ADD NEW</button>
                <div class="dropdown">
                    <button id="bulk-actions-btn" class="btn btn-secondary"><i class="fa-solid fa-ellipsis-vertical"></i> BULK ACTIONS</button>
                    <div id="bulk-actions-menu" class="dropdown-menu" style="display: none;">
                        <button id="bulk-upload-btn" class="dropdown-item"><i class="fa-solid fa-upload"></i> Bulk Upload</button>
                        <button id="bulk-delete-btn" class="dropdown-item"><i class="fa-solid fa-trash"></i> Bulk Delete</button>
                    </div>
                </div>
                ` : '<span class="subtle" style="font-size: 0.85rem;">View-only access</span>'}
            </div>
        </div>
    `;

    const skeletonContent = `
        <div class="card employees-card-shell">
            <div class="page-controls">
                <div class="inline-search">
                    <div class="skeleton skeleton-text" style="height: 36px; width: 100%; border-radius: 999px;"></div>
                </div>
            </div>
            <div class="employee-card-grid view-mode view-mode-visible">
                <div class="employee-card">
                    <div class="employee-card-header">
                        <div class="employee-card-info">
                            <div class="skeleton skeleton-circle" style="width:40px;height:40px;"></div>
                            <div>
                                <div class="skeleton skeleton-list-line-lg"></div>
                                <div class="skeleton skeleton-list-line-sm" style="margin-top: 4px;"></div>
                            </div>
                        </div>
                        <div class="skeleton skeleton-badge"></div>
                    </div>
                    <div class="employee-card-body">
                        <div class="skeleton skeleton-list-line-lg"></div>
                        <div class="skeleton skeleton-list-line-sm"></div>
                    </div>
                </div>
                <div class="employee-card">
                    <div class="employee-card-header">
                        <div class="employee-card-info">
                            <div class="skeleton skeleton-circle" style="width:40px;height:40px;"></div>
                            <div>
                                <div class="skeleton skeleton-list-line-lg"></div>
                                <div class="skeleton skeleton-list-line-sm" style="margin-top: 4px;"></div>
                            </div>
                        </div>
                        <div class="skeleton skeleton-badge"></div>
                    </div>
                    <div class="employee-card-body">
                        <div class="skeleton skeleton-list-line-lg"></div>
                        <div class="skeleton skeleton-list-line-sm"></div>
                    </div>
                </div>
                <div class="employee-card">
                    <div class="employee-card-header">
                        <div class="employee-card-info">
                            <div class="skeleton skeleton-circle" style="width:40px;height:40px;"></div>
                            <div>
                                <div class="skeleton skeleton-list-line-lg"></div>
                                <div class="skeleton skeleton-list-line-sm" style="margin-top: 4px;"></div>
                            </div>
                        </div>
                        <div class="skeleton skeleton-badge"></div>
                    </div>
                    <div class="employee-card-body">
                        <div class="skeleton skeleton-list-line-lg"></div>
                        <div class="skeleton skeleton-list-line-sm"></div>
                    </div>
                </div>
            </div>
            <div class="employee-table-wrapper view-mode" style="margin-top: 1rem;">
                <div class="skeleton skeleton-chart-line"></div>
            </div>
        </div>
    `;

    document.getElementById('app-content').innerHTML = getPageContentHTML('Employees', skeletonContent, controls);

    let paginator = '';
    try {
        const items = await listAllEmployees();
        state.employees = (items || []).map(e => ({
            id: e.employee_id,
            name: `${e.first_name || ''} ${e.last_name || ''}`.trim(),
            email: e.email || '',
            location: e.address || '',
            jobTitle: e.designation || '',
            contactNumber: e.contact_number || '',
            department: e.department || '',
            role: '',
            employmentType: 'Full-time',
            status: (e.active === true || e.active === 'true' || e.active === 1 || e.active === 'Active') ? 'Active' : 'Inactive',
            employeeFlag: e.employee_flag,
            photo: normalizePhoto(e.photo || e.profile_picture)
        }));

        // If the logged-in user is present in this page of employees, hydrate the header avatar.
        const matchMe = (state.employees || []).find(emp =>
            (state.user?.id && emp.id === state.user.id) ||
            (state.user?.email && emp.email?.toLowerCase() === state.user.email.toLowerCase())
        );
        if (matchMe && matchMe.photo) {
            state.user = { ...(state.user || {}), avatarUrl: matchMe.photo };
            try {
                const authRaw = localStorage.getItem('auth');
                if (authRaw) {
                    const parsed = JSON.parse(authRaw);
                    if (parsed && parsed.user) {
                        parsed.user.avatarUrl = matchMe.photo;
                        localStorage.setItem('auth', JSON.stringify(parsed));
                    }
                }
            } catch {}
            applyHeaderAvatar();
        }

    } catch (err) {
        console.error('Failed to load employees from backend:', err);
    }

    const isSearching = !!(filter && filter.trim());
    const visibleEmployees = (state.employees || []).filter((e) => !isTeamLead || !isInternRecord(e));
    const sortedEmployees = visibleEmployees
        .filter(e =>
            e.name.toLowerCase().includes(filter.toLowerCase()) ||
            e.id.toLowerCase().includes(filter.toLowerCase())
        )
        .sort(compareEmployeeIdAsc);

    let filteredEmployees = sortedEmployees;
    if (!isSearching) {
        const totalPages = Math.max(1, Math.ceil(sortedEmployees.length / EMP_PAGE_SIZE));
        empCurrentPage = Math.min(Math.max(1, page), totalPages);

        const startIdx = (empCurrentPage - 1) * EMP_PAGE_SIZE;
        const endIdx = startIdx + EMP_PAGE_SIZE;
        filteredEmployees = sortedEmployees.slice(startIdx, endIdx);

        const prevDisabled = empCurrentPage <= 1 ? 'disabled' : '';
        const nextDisabled = empCurrentPage >= totalPages ? 'disabled' : '';
        const prevPage = Math.max(1, empCurrentPage - 1);
        const nextPage = Math.min(totalPages, empCurrentPage + 1);
        paginator = `
            <div class="pagination">
                <button id="emp-prev" class="btn" ${prevDisabled} data-target-page="${prevPage}"><i class="fa-solid fa-chevron-left"></i> Prev</button>
                <span class="page-indicator">Page ${empCurrentPage} of ${totalPages}</span>
                <button id="emp-next" class="btn" ${nextDisabled} data-target-page="${nextPage}">Next <i class="fa-solid fa-chevron-right"></i></button>
            </div>
        `;
    }

    const pastelColors = ['#bfdbfe', '#c7d2fe', '#fecdd3', '#fde68a', '#bbf7d0', '#fcd34d'];
    const getAvatarColor = (seed = '') => {
        let hash = 0;
        for (let i = 0; i < seed.length; i++) {
            hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
        }
        return pastelColors[hash % pastelColors.length];
    };

    const employeeCards = filteredEmployees.map(e => {
        const emailRow = e.email ? `
            <div class="employee-card-detail">
                <i class="fa-solid fa-envelope"></i>
                <span>${e.email}</span>
            </div>` : '';
        const phoneRow = e.contactNumber ? `
            <div class="employee-card-detail">
                <i class="fa-solid fa-location-dot"></i>
                <span>${e.contactNumber}</span>
            </div>` : '';
        const locationRow = e.location ? `
            <div class="employee-card-detail">
                <i class="fa-solid fa-phone"></i>
                <span>${e.location}</span>
            </div>` : '';

        const initials = (e.name || '').split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase();
        const avatar = e.photo ? `
            <div class="employee-avatar has-photo" style="background-image:url('${e.photo}');"></div>
        ` : `
            <div class="employee-avatar" style="background:${getAvatarColor(e.id || e.name)}; border: 2px solid rgba(255, 255, 255, 0.3); box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15), inset 0 1px 2px rgba(255, 255, 255, 0.2); color: #1a1a1a; font-weight: 600;">${initials}</div>
        `;

        return `
            <div class="employee-card">
                <div class="employee-card-header">
                    <div class="employee-card-info">
                        ${avatar}
                        <div>
                            <div class="employee-name">${e.name || ''}</div>
                            <div class="employee-meta">${e.jobTitle || ''}</div>
                            <div class="employee-meta subtle">${e.department || ''}</div>
                        </div>
                    </div>
                    <span class="status-badge ${e.status ? e.status.toLowerCase() : 'inactive'}">${e.status || 'Inactive'}</span>
                </div>
                <div class="employee-card-body">
                    ${emailRow}
                    ${phoneRow}
                    ${locationRow}
                </div>
                ${canManageEmployees ? `<div class="employee-card-footer">
                    <button class="icon-btn emp-edit-btn" title="Edit" data-id="${e.id}"><i class="fa-solid fa-pen-to-square"></i></button>
                    <button class="icon-btn emp-delete-btn" title="Delete" data-id="${e.id}"><i class="fa-solid fa-trash"></i></button>
                </div>` : ''}
            </div>
        `;
    }).join('');

    const cardsMarkup = employeeCards || `<div class="placeholder-text">No employees found. Click ADD NEW to add employees.</div>`;

    const tableRows = filteredEmployees.map(e => `
        <tr>
            <td>${e.id || ''}</td>
            <td>${e.name || ''}</td>
            <td>${e.contactNumber || ''}</td>
            <td>${e.location || ''}</td>
            <td>${e.jobTitle || ''}</td>
            <td>${e.department || ''}</td>
            <td><span class="status-badge ${e.status ? e.status.toLowerCase() : 'inactive'}">${e.status || 'Inactive'}</span></td>
            <td>
                ${canManageEmployees ? `<div class="table-actions">
                    <button class="icon-btn emp-edit-btn" title="Edit" data-id="${e.id}"><i class="fa-solid fa-pen-to-square"></i></button>
                    <button class="icon-btn emp-delete-btn" title="Delete" data-id="${e.id}"><i class="fa-solid fa-trash"></i></button>
                </div>` : '<span class="subtle">View only</span>'}
            </td>
        </tr>
    `).join('');

    const tableMarkup = `
        <div class="employee-table-wrapper">
            <div class="employee-table-scroll">
                <table class="table employees-table">
                    <thead>
                        <tr>
                            <th>Employee ID</th>
                            <th>Name</th>
                            <th>Address</th>
                            <th>Contact</th>
                            <th>Designation</th>
                            <th>Department</th>
                            <th>Status</th>
                            <th>Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${tableRows || `<tr><td colspan="8" class="placeholder-text">No employees found. Click ADD NEW to add employees.</td></tr>`}
                    </tbody>
                </table>
            </div>
        </div>
    `;

    const content = `
        <div class="card employees-card-shell">
            <div class="page-controls">
                <div class="inline-search">
                    <i class="fa-solid fa-search"></i>
                    <input type="text" id="employee-search-input" placeholder="Search by name or ID" value="${filter}">
                </div>
            </div>
            <div id="employee-card-view" class="employee-card-grid view-mode ${isTableMode ? '' : 'view-mode-visible'}">
                ${cardsMarkup}
            </div>
            <div id="employee-table-view" class="view-mode ${isTableMode ? 'view-mode-visible' : ''}">
                ${tableMarkup}
            </div>
            ${paginator}
        </div>
    `;
    document.getElementById('app-content').innerHTML = getPageContentHTML('Employees', content, controls);

    // After render, wire up view toggles and search
    const addBtn = document.getElementById('add-employee-btn');
    if (canManageEmployees && addBtn) {
        addBtn.onclick = (e) => {
            e.preventDefault();
            try { showAddEmployeeModal(); } catch (err) { console.error('Add Employee modal failed:', err); }
        };
    }

    const cardBtn = document.getElementById('employee-card-view-btn');
    const tableBtn = document.getElementById('employee-table-view-btn');
    const cardView = document.getElementById('employee-card-view');
    const tableView = document.getElementById('employee-table-view');
    if (cardBtn && tableBtn && cardView && tableView) {
        const applyViewState = (target) => {
            const showTable = target === 'table';
            employeeViewMode = showTable ? 'table' : 'card';
            cardBtn.classList.toggle('active', !showTable);
            tableBtn.classList.toggle('active', showTable);
            cardView.classList.toggle('view-mode-visible', !showTable);
            tableView.classList.toggle('view-mode-visible', showTable);
        };
        cardBtn.addEventListener('click', () => applyViewState('card'));
        tableBtn.addEventListener('click', () => applyViewState('table'));
        applyViewState(employeeViewMode);
    }

    // Wire up search input
    const searchInput = document.getElementById('employee-search-input');
    if (searchInput) {
        searchInput.addEventListener('input', (e) => {
            const searchValue = e.target.value || '';
            const cursorPosition = e.target.selectionStart;
            
            renderEmployeesPage(searchValue, 1).then(() => {
                // Restore focus and cursor position after re-render
                const newInput = document.getElementById('employee-search-input');
                if (newInput) {
                    newInput.focus();
                    newInput.setSelectionRange(cursorPosition, cursorPosition);
                }
            });
        });
    }
} // Added closing bracket here

// Simple CSV parser that supports quoted fields, embedded commas, and newlines
const parseCSVText = (text) => {
    const out = [];
    const len = text.length;
    let i = 0;
    let row = [];
    let field = '';
    let inQuotes = false;
    while (i < len) {
        const ch = text[i];
        if (inQuotes) {
            if (ch === '"') {
                if (i + 1 < len && text[i + 1] === '"') {
                    field += '"';
                    i += 2;
                    continue;
                } else {
                    inQuotes = false;
                    i += 1;
                    continue;
                }
            } else {
                field += ch;
                i += 1;
                continue;
            }
        } else {
            if (ch === '"') {
                inQuotes = true;
                i += 1;
                continue;
            }
            if (ch === ',') {
                row.push(field.trim());
                field = '';
                i += 1;
                continue;
            }
            if (ch === '\r') {
                i += 1;
                continue;
            }
            if (ch === '\n') {
                row.push(field.trim());
                out.push(row);
                row = [];
                field = '';
                i += 1;
                continue;
            }
            field += ch;
            i += 1;
        }
    }
    row.push(field.trim());
    if (row.length && (row.length > 1 || row[0] !== '')) out.push(row);
    return out;
};

// Full-page view for Bulk Delete
export const renderBulkDeletePage = async () => {
    if (!getEmployeeAccess().canManageEmployees) {
        window.location.hash = '#/employees';
        return;
    }

    bulkDeleteFilter = '';
    bulkDeleteSelected = new Set();
    restoreSelected = new Set();
    const controls = `
        <div class="employee-controls">
            <button class="btn" onclick="window.location.hash='#/employees'">
                <i class="fa-solid fa-arrow-left"></i> Back to Employees
            </button>
        </div>
    `;
    const content = `
        <div class="card" style="padding:16px; margin-bottom:20px;">
            <h2 style="margin-top:0;">Active Employees</h2>
            <div class="form-group bulk-action-row">
                <label class="bulk-select-all bulk-select-all-left">
                    <input type="checkbox" id="bulk-delete-select-all" /> Select All
                </label>
            </div>
             <div id="bulk-delete-table" class="table-container" style="min-height:300px; overflow:auto;"><div class="loading-placeholder">Loading all employees...</div></div>
            <div style="display:flex; gap:8px; justify-content:flex-end; margin-top:12px;">
                <button type="button" id="bulk-delete-confirm-btn" class="btn btn-danger">Delete Selected</button>
            </div>
        </div>
        
        <div class="card" style="padding:16px;">
            <h2 class="danger-heading">Deleted Employees</h2>
            <div class="form-group bulk-action-row">
                <div class="inline-search" style="flex:1;">
                    <i class="fa-solid fa-search"></i>
                    <input type="text" id="deleted-search" placeholder="Search deleted employees..." />
                </div>
                <label class="bulk-select-all"><input type="checkbox" id="deleted-select-all" /> Select All</label>
            </div>
             <div id="deleted-employees-table" class="table-container" style="min-height:200px; overflow:auto;"><div class="loading-placeholder">Loading deleted employees...</div></div>
            <div style="display:flex; gap:8px; justify-content:space-between; margin-top:12px; flex-wrap:wrap;">
                <div class="muted-info-text">
                    <span id="deleted-count">0</span> deleted employees
                </div>
                <div style="display:flex; gap:8px;">
                    <button type="button" id="restore-selected-btn" class="btn btn-warning" disabled>Restore Selected</button>
                    <button type="button" id="restore-all-btn" class="btn btn-success" disabled>Restore All</button>
                </div>
            </div>
        </div>
    `;
    document.getElementById('app-content').innerHTML = getPageContentHTML('Employees • Bulk Delete', content, controls);
    setTimeout(async () => {
        try {
            // Load active employees
            const { items } = await listEmployees(1, 5000);
            bulkDeleteEmployees = (items || []).map(e => ({
                id: e.employee_id,
                name: `${e.first_name || ''} ${e.last_name || ''}`.trim(),
                location: e.address || '',
                jobTitle: e.designation || '',
                contactNumber: e.contact_number || '',
                department: e.department || '',
                status: (e.active === true || e.active === 'true' || e.active === 1 || e.active === 'Active') ? 'Active' : 'Inactive'
            }));

            // Load deleted employees
            currentDeletedEmployees = await fetchDeletedEmployees();
            hasDeletedEmployees = currentDeletedEmployees.length > 0;
        } catch (err) {
            console.error('Failed to load employees for bulk delete:', err);
            bulkDeleteEmployees = (state.employees || []).slice();
            currentDeletedEmployees = [];
        }

        renderBulkDeleteTable();
        renderDeletedEmployeesTable();

        // Set up event listeners
        const sortType = document.getElementById('bulk-delete-sort-type');
        const sortBtn = document.getElementById('bulk-delete-sort-btn');
        const selectAll = document.getElementById('bulk-delete-select-all');
        const deletedSearch = document.getElementById('deleted-search');
        const deletedSelectAll = document.getElementById('deleted-select-all');
        const restoreSelectedBtn = document.getElementById('restore-selected-btn');
        const restoreAllBtn = document.getElementById('restore-all-btn');
        const deleteConfirmBtn = document.getElementById('bulk-delete-confirm-btn');

        if (sortType) sortType.addEventListener('change', handleBulkDeleteSortTypeChange);
        if (sortBtn) sortBtn.addEventListener('click', handleBulkDeleteSort);
        if (selectAll) selectAll.addEventListener('change', handleBulkDeleteToggleSelectAll);
        if (deletedSearch) deletedSearch.addEventListener('input', handleDeletedSearch);
        if (deletedSelectAll) deletedSelectAll.addEventListener('change', handleDeletedSelectAll);
        if (restoreSelectedBtn) restoreSelectedBtn.addEventListener('click', handleRestoreSelected);
        if (restoreAllBtn) restoreAllBtn.addEventListener('click', handleRestoreAll);
        if (deleteConfirmBtn) deleteConfirmBtn.addEventListener('click', (e) => {
            e.preventDefault();
            handleBulkDeleteConfirm(e);
        });
    }, 50);
};
// Full-page view for Bulk Upload
export const renderBulkUploadPage = async () => {
    if (!getEmployeeAccess().canManageEmployees) {
        window.location.hash = '#/employees';
        return;
    }
    parsedEmployees = [];
    const controls = `
        <div class="employee-controls">
            <button class="btn" onclick="window.location.hash='#/employees'">
                <i class="fa-solid fa-arrow-left"></i> Back to Employees
            </button>
        </div>
    `;
    const content = `
        <form id="bulk-upload-form" class="card bulk-upload-form" style="padding:16px;">
            <h2 style="margin-top:0;">Bulk Upload Employees</h2>
            <div class="form-group bulk-upload-field">
                <input type="file" id="csvFile" accept=".csv" required />
                <label for="csvFile">Upload CSV File</label>
                <small class="csv-format-hint">
                    CSV format: employee_id, first_name, last_name, email, address, contact_number, department, designation, doj, active
                </small>
            </div>
            <div id="upload-preview" class="table-container" style="margin-top:16px; min-height:200px;"></div>
            <div style="display:flex; justify-content:flex-end; gap:8px; margin-top:16px;">
                <button type="button" class="btn" onclick="window.location.hash='#/employees'">Cancel</button>
                <button type="submit" id="upload-csv-btn" class="btn btn-primary" disabled>Upload</button>
            </div>
        </form>
    `;
    document.getElementById('app-content').innerHTML = getPageContentHTML('Employees • Bulk Upload', content, controls);
    // Initialize listeners same as modal flow
    setTimeout(() => {
        const fileInput = document.getElementById('csvFile');
        const submitBtn = document.getElementById('upload-csv-btn');
        if (submitBtn) {
            submitBtn.textContent = 'Upload';
            submitBtn.disabled = true;
        }
        if (fileInput) {
            fileInput.addEventListener('change', handleCSVPreview);
        }
    }, 50);
};

export const showAddEmployeeModal = () => {
    if (!getEmployeeAccess().canManageEmployees) {
        alert('You have view-only access to employees.');
        return;
    }
    photoDraft = { dataUrl: null, cleared: false };
    initialPhotoRef = null;
    const previewClass = 'avatar-preview';
    const previewStyle = '';
    const formHTML = `
        <div class="modal-form modern-form leave-form">
            <div class="form-section">
                <div class="form-section-header">
                    <div>
                        <p class="form-eyebrow">Personal info</p>
                        <h3>Employee details</h3>
                    </div>
                    <p class="form-section-copy">Capture the core information we need to onboard the employee.</p>
                </div>
                <div class="form-grid two-col">
                    <div class="form-field with-icon">
                        <label class="form-label" for="firstName">First Name</label>
                        <div class="input-wrapper">
                            <i class="fa-solid fa-user"></i>
                            <input class="input-control" type="text" id="firstName" name="firstName" placeholder="John" required>
                        </div>
                    </div>
                    <div class="form-field with-icon">
                        <label class="form-label" for="lastName">Last Name</label>
                        <div class="input-wrapper">
                            <i class="fa-solid fa-user"></i>
                            <input class="input-control" type="text" id="lastName" name="lastName" placeholder="Doe">
                        </div>
                    </div>
                    <div class="form-field with-icon">
                        <label class="form-label" for="email">Email</label>
                        <div class="input-wrapper">
                            <i class="fa-solid fa-envelope"></i>
                            <input class="input-control" type="email" id="email" name="email" placeholder="name@company.com">
                        </div>
                    </div>
                    <div class="form-field with-icon">
                        <label class="form-label" for="contactNo">Contact No</label>
                        <div class="input-wrapper">
                            <i class="fa-solid fa-phone"></i>
                            <input class="input-control" type="tel" id="contactNo" name="contactNo" placeholder="(+91) 98765 43210" required>
                        </div>
                        <p class="helper-text">Used for emergency contact and communication.</p>
                    </div>
                </div>
            </div>

            <div class="form-section">
                <div class="form-section-header">
                    <div>
                        <p class="form-eyebrow">Work & contact</p>
                        <h3>Professional details</h3>
                    </div>
                </div>
                <div class="form-grid two-col">
                    <div class="form-field with-icon">
                        <label class="form-label" for="address">Address</label>
                        <div class="input-wrapper">
                            <i class="fa-solid fa-location-dot"></i>
                            <input class="input-control" type="text" id="address" name="address" placeholder="Street, City">
                        </div>
                    </div>
                    <div class="form-field with-icon">
                        <label class="form-label" for="designation">Designation</label>
                        <div class="input-wrapper">
                            <i class="fa-solid fa-briefcase"></i>
                            <input class="input-control" type="text" id="designation" name="designation" placeholder="UI Designer" required>
                        </div>
                    </div>
                    <div class="form-field with-icon">
                        <label class="form-label" for="department">Department</label>
                        <div class="input-wrapper">
                            <i class="fa-solid fa-building-user"></i>
                            <input class="input-control" type="text" id="department" name="department" placeholder="Engineering">
                        </div>
                    </div>
                    <div class="form-field with-icon">
                        <label class="form-label" for="doj">DOJ</label>
                        <div class="input-wrapper">
                            <i class="fa-regular fa-calendar"></i>
                            <input class="input-control" type="date" id="doj" name="doj">
                        </div>
                    </div>
                    <div class="form-field with-icon">
                        <label class="form-label" for="status">Status</label>
                        <div class="input-wrapper">
                            <i class="fa-solid fa-signal"></i>
                            <select class="input-control" id="status" name="status" required>
                                <option value="" disabled selected>Select status</option>
                                <option value="Active">Active</option>
                                <option value="Inactive">Inactive</option>
                            </select>
                        </div>
                    </div>
                    <div class="form-field with-icon">
                        <label class="form-label" for="employeeFlag">Employee Flag</label>
                        <div class="input-wrapper">
                            <i class="fa-solid fa-user-tag"></i>
                            <select class="input-control" id="employeeFlag" name="employeeFlag" required>
                                <option value="Employee" selected>Employee</option>
                                <option value="Intern">Intern</option>
                            </select>
                        </div>
                        <p class="helper-text">Flag interns to auto-appear in the Interns module.</p>
                    </div>
                </div>
            </div>

            <div class="form-section">
                <div class="form-section-header">
                    <div>
                        <p class="form-eyebrow">Profile photo</p>
                        <h3>Avatar</h3>
                    </div>
                    <p class="form-section-copy">Upload a square image (recommended). Max ~1MB.</p>
                </div>
                <div class="form-grid">
                    <div class="form-field" style="grid-column: 1 / -1;">
                        <div class="profile-photo-upload">
                            <div id="photo-preview" class="${previewClass}" ${previewStyle}></div>
                            <div class="avatar-actions">
                                <button type="button" class="btn btn-secondary" id="upload-photo-btn"><i class="fa-solid fa-camera"></i> Upload photo</button>
                                <button type="button" class="btn btn-link" id="remove-photo-btn">Remove</button>
                                <input type="file" id="photo-input" accept="image/*" hidden>
                            </div>
                            <small class="subtle">Accepted: jpg, png. Large images may be slow to save.</small>
                        </div>
                    </div>
                </div>
            </div>

            <input type="hidden" id="editEmployeeId" name="editEmployeeId" value="">
        </div>
    `;
    renderModal('Add New Employee', formHTML, 'save-employee-btn');
    setTimeout(() => initPhotoUploader(null), 50);
};

export const handleAddEmployee = async (e) => {
    e.preventDefault();
    if (!getEmployeeAccess().canManageEmployees) {
        alert('You have view-only access to employees.');
        return;
    }

    try {
        // Fetch the next employee ID from backend
        const response = await fetch(`${API_BASE_URL}/api/employees/last-id`);
        const data = await response.json();

        if (!data.success) {
            alert('Failed to generate employee ID');
            return;
        }

        // Debug: Log form values
        const contactNoValue = document.getElementById('contactNo').value;
        const addressValue = document.getElementById('address').value;

        console.log('🔍 DEBUG - Form Values:');
        console.log('Contact No field value:', contactNoValue);
        console.log('Address field value:', addressValue);

        const statusValue = document.getElementById('status').value;
        const dojValue = document.getElementById('doj')?.value || '';

        const payload = {
            employee_id: data.next_id,
            first_name: document.getElementById('firstName').value,
            last_name: document.getElementById('lastName').value,
            email: document.getElementById('email').value,
            address: addressValue,
            contact_number: contactNoValue,
            department: document.getElementById('department').value,
            designation: document.getElementById('designation').value,
            doj: dojValue || (statusValue === 'Active' ? new Date().toISOString().split('T')[0] : ''),
            active: statusValue === 'Active',
            employee_flag: document.getElementById('employeeFlag').value || 'Employee',
            profile_picture: photoDraft.cleared ? null : cleanDataUrl(photoDraft.dataUrl)
        };

        console.log('🔍 DEBUG - Payload:', payload);

        await createEmployee(payload);

        // Re-fetch to pull the saved Dataverse base64 (crc6f_profilepicture) and update cards/header.
        closeModal();
        await renderEmployeesPage();
    } catch (err) {
        console.error('Failed to create employee:', err);
        alert(`Failed to create employee: ${err.message || err}`);
    }
};

export const showEditEmployeeModal = (employeeId) => {
    if (!getEmployeeAccess().canManageEmployees) {
        alert('You have view-only access to employees.');
        return;
    }
    const emp = (state.employees || []).find(x => x.id === employeeId);
    if (!emp) {
        alert('Employee not found');
        return;
    }
    const existingPhoto = normalizePhoto(emp.photo || emp.profile_picture || emp.avatarUrl);
    photoDraft = { dataUrl: null, cleared: false };
    initialPhotoRef = existingPhoto || null;
    const [firstPrefill, ...lastParts] = (emp.name || '').split(' ');
    const lastPrefill = lastParts.join(' ');
    const flagPrefill = emp.employeeFlag || 'Employee';
    const hasPhoto = !!existingPhoto;
    const previewClass = hasPhoto ? 'avatar-preview has-photo' : 'avatar-preview';
    const previewStyle = hasPhoto ? `style="background-image:url('${existingPhoto}');"` : '';

    const formHTML = `
        <div class="modal-form modern-form leave-form">
            <div class="form-section">
                <div class="form-section-header">
                    <div>
                        <p class="form-eyebrow">Personal info</p>
                        <h3>Employee details</h3>
                    </div>
                    <p class="form-section-copy">Update the core employee information.</p>
                </div>
                <div class="form-grid two-col">
                    <div class="form-field with-icon">
                        <label class="form-label" for="firstName">First Name</label>
                        <div class="input-wrapper">
                            <i class="fa-solid fa-user"></i>
                            <input class="input-control" type="text" id="firstName" name="firstName" value="${firstPrefill || ''}" placeholder="John" required>
                        </div>
                    </div>
                    <div class="form-field with-icon">
                        <label class="form-label" for="lastName">Last Name</label>
                        <div class="input-wrapper">
                            <i class="fa-solid fa-user"></i>
                            <input class="input-control" type="text" id="lastName" name="lastName" value="${lastPrefill || ''}" placeholder="Doe">
                        </div>
                    </div>
                    <div class="form-field with-icon">
                        <label class="form-label" for="email">Email</label>
                        <div class="input-wrapper">
                            <i class="fa-solid fa-envelope"></i>
                            <input class="input-control" type="email" id="email" name="email" value="${emp.email || ''}" placeholder="name@company.com" required>
                        </div>
                    </div>
                    <div class="form-field with-icon">
                        <label class="form-label" for="contactNo">Contact No</label>
                        <div class="input-wrapper">
                            <i class="fa-solid fa-phone"></i>
                            <input class="input-control" type="tel" id="contactNo" name="contactNo" value="${emp.contactNumber || ''}" placeholder="(+91) 98765 43210" required>
                        </div>
                        <p class="helper-text">Used for emergency contact and communication.</p>
                    </div>
                </div>
            </div>

            <div class="form-section">
                <div class="form-section-header">
                    <div>
                        <p class="form-eyebrow">Work & contact</p>
                        <h3>Professional details</h3>
                    </div>
                </div>
                <div class="form-grid two-col">
                    <div class="form-field with-icon">
                        <label class="form-label" for="address">Address</label>
                        <div class="input-wrapper">
                            <i class="fa-solid fa-location-dot"></i>
                            <input class="input-control" type="text" id="address" name="address" value="${emp.location || ''}" placeholder="Street, City">
                        </div>
                    </div>
                    <div class="form-field with-icon">
                        <label class="form-label" for="designation">Designation</label>
                        <div class="input-wrapper">
                            <i class="fa-solid fa-briefcase"></i>
                            <input class="input-control" type="text" id="designation" name="designation" value="${emp.jobTitle || ''}" placeholder="UI Designer" required>
                        </div>
                    </div>
                    <div class="form-field with-icon">
                        <label class="form-label" for="department">Department</label>
                        <div class="input-wrapper">
                            <i class="fa-solid fa-building-user"></i>
                            <input class="input-control" type="text" id="department" name="department" value="${emp.department || ''}" placeholder="Engineering">
                        </div>
                    </div>
                    <div class="form-field with-icon">
                        <label class="form-label" for="status">Status</label>
                        <div class="input-wrapper">
                            <i class="fa-solid fa-signal"></i>
                            <select class="input-control" id="status" name="status" required>
                                <option value="Active" ${emp.status === 'Active' ? 'selected' : ''}>Active</option>
                                <option value="Inactive" ${emp.status !== 'Active' ? 'selected' : ''}>Inactive</option>
                            </select>
                        </div>
                    </div>
                    <div class="form-field with-icon">
                        <label class="form-label" for="employeeFlag">Employee Flag</label>
                        <div class="input-wrapper">
                            <i class="fa-solid fa-user-tag"></i>
                            <select class="input-control" id="employeeFlag" name="employeeFlag" required>
                                <option value="Employee" ${flagPrefill === 'Employee' ? 'selected' : ''}>Employee</option>
                                <option value="Intern" ${flagPrefill === 'Intern' ? 'selected' : ''}>Intern</option>
                            </select>
                        </div>
                        <p class="helper-text">Flag interns to auto-appear in the Interns module.</p>
                    </div>
                </div>
            </div>

            <div class="form-section">
                <div class="form-section-header">
                    <div>
                        <p class="form-eyebrow">Profile photo</p>
                        <h3>Avatar</h3>
                    </div>
                    <p class="form-section-copy">Upload a square image (recommended). Max ~1MB.</p>
                </div>
                <div class="form-grid">
                    <div class="form-field" style="grid-column: 1 / -1;">
                        <div class="profile-photo-upload">
                            <div id="photo-preview" class="${previewClass}" ${previewStyle}></div>
                            <div class="avatar-actions">
                                <button type="button" class="btn btn-secondary" id="upload-photo-btn"><i class="fa-solid fa-camera"></i> Upload photo</button>
                                <button type="button" class="btn btn-link" id="remove-photo-btn">Remove</button>
                                <input type="file" id="photo-input" accept="image/*" hidden>
                            </div>
                            <small class="subtle">Accepted: jpg, png. Large images may be slow to save.</small>
                        </div>
                    </div>
                </div>
            </div>

            <input type="hidden" id="editEmployeeId" name="editEmployeeId" value="${emp.id}">
        </div>
    `;

    renderModal('Edit Employee', formHTML, 'update-employee-btn');
    setTimeout(() => initPhotoUploader(existingPhoto || null), 50);
};

export const handleUpdateEmployee = (e) => {
    e.preventDefault();
    if (!getEmployeeAccess().canManageEmployees) {
        alert('You have view-only access to employees.');
        return;
    }
    const employee_id = document.getElementById('editEmployeeId').value;
    const payload = {
        employee_id,

        first_name: document.getElementById('firstName').value,
        last_name: document.getElementById('lastName').value,
        email: document.getElementById('email').value,
        contact_number: document.getElementById('contactNo').value,
        address: document.getElementById('address').value,
        department: document.getElementById('department').value,
        designation: document.getElementById('designation').value,
        active: document.getElementById('status').value === 'Active',
        employee_flag: document.getElementById('employeeFlag').value || 'Employee',
    };

    // Only send profile_picture when changed or explicitly cleared
    if (photoDraft.cleared) {
        payload.profile_picture = null;
    } else if (photoDraft.dataUrl) {
        payload.profile_picture = cleanDataUrl(photoDraft.dataUrl);
    } else if (initialPhotoRef) {
        // Preserve existing photo explicitly so backend keeps it (dataverse update may ignore omitted field)
        payload.profile_picture = cleanDataUrl(initialPhotoRef);
    }

    updateEmployee(employee_id, payload)
        .then((updated) => {
            try { if (state?.cache?.employees) state.cache.employees = {}; } catch {}
            const photoDataFromServer = updated?.photo || updated?.profile_picture || null;
            const photoNormalized = normalizePhoto(photoDataFromServer) || normalizePhoto(cleanDataUrl(payload.profile_picture)) || null;
            const idx = state.employees.findIndex((x) => x.id === employee_id);
            if (idx >= 0) {
                state.employees[idx] = {
                    ...state.employees[idx],
                    name: `${payload.first_name || ''} ${payload.last_name || ''}`.trim(),

                    email: payload.email,
                    location: payload.address,
                    jobTitle: payload.designation,
                    contactNumber: payload.contact_number,
                    department: payload.department,
                    status: payload.active ? 'Active' : 'Inactive',
                    employeeFlag: payload.employee_flag || state.employees[idx].employeeFlag,
                    photo: photoNormalized !== null ? photoNormalized : state.employees[idx].photo,
                };
            }
            if (state.user && (state.user.id === employee_id || state.user.employee_id === employee_id)) {
                if (photoNormalized !== null) state.user.avatarUrl = photoNormalized;
                applyHeaderAvatar();
            }

            closeModal();
            renderEmployeesPage();
        })
        .catch((err) => {
            console.error('Failed to update employee:', err);
            alert(`Failed to update employee: ${err.message || err}`);
        });
};

export const handleDeleteEmployee = (employeeId) => {
    if (!getEmployeeAccess().canManageEmployees) {
        alert('You have view-only access to employees.');
        return;
    }
    if (!employeeId) return;
    const confirmed = confirm('Are you sure you want to delete this employee?');
    if (!confirmed) return;
    deleteEmployee(employeeId)
        .then(() => {
            try { if (state?.cache?.employees) state.cache.employees = {}; } catch {}
            state.employees = (state.employees || []).filter((e) => e.id !== employeeId);
            renderEmployeesPage();
        })
        .catch((err) => {
            console.error('Failed to delete employee:', err);
            alert(`Failed to delete employee: ${err.message || err}`);
        });
};

export const showBulkUploadModal = () => {
    if (!getEmployeeAccess().canManageEmployees) {
        alert('You have view-only access to employees.');
        return;
    }
    const formHTML = `
        <div class="form-group bulk-upload-field">
            <input type="file" id="csvFile" accept=".csv" required>
            <label for="csvFile">Upload CSV File</label>
            <small class="csv-format-hint">
                CSV format: employee_id, first_name, last_name, email, address, contact_number, department, designation, doj, active
            </small>
        </div>
        <div id="upload-preview" style="margin-top: 16px; max-height: 200px; overflow-y: auto;"></div>
    `;
    renderModal('Bulk Upload Employees', formHTML, 'upload-csv-btn');

    parsedEmployees = [];
    setTimeout(() => {
        const fileInput = document.getElementById('csvFile');
        const submitBtn = document.getElementById('upload-csv-btn');
        if (submitBtn) {
            submitBtn.textContent = 'Upload';
            submitBtn.disabled = true;
        }
        if (fileInput) {
            fileInput.addEventListener('change', handleCSVPreview);
        }
    }, 100);
};

export const handleCSVPreview = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
        const text = event.target.result || '';
        const rows = parseCSVText(text);
        const preview = document.getElementById('upload-preview');
        const submitBtn = document.getElementById('upload-csv-btn');
        parsedEmployees = [];
        if (!rows || rows.length < 2) {
            if (preview) preview.innerHTML = `<p class="error-message">No data found in CSV</p>`;
            if (submitBtn) submitBtn.disabled = true;
            return;
        }
        const headersRaw = rows[0].map(h => h.replace(/^"|"$/g, '').replace(/^\ufeff/, ''));
        const maxPreview = 20;
        const norm = (s) => (s || '').toString().replace(/^\ufeff/, '').trim().toLowerCase();
        const headerIndex = (names) => {
            const set = new Set(names.map(norm));
            for (let idx = 0; idx < headersRaw.length; idx++) {
                if (set.has(norm(headersRaw[idx]))) return idx;
            }
            return -1;
        };
        const hasEmployeeId = headerIndex(['employee_id', 'emp_id', 'employee id']) !== -1;
        const idx = {
            id: headerIndex(['employee_id', 'emp_id', 'employee id']),
            first: headerIndex(['first_name', 'first name', 'firstname']),
            last: headerIndex(['last_name', 'last name', 'lastname', 'surname']),
            email: headerIndex(['email', 'e-mail']),
            address: headerIndex(['address', 'addr', 'residential address']),
            contact: headerIndex(['contact_number', 'contact number', 'mobile', 'phone', 'phone number', 'mobile number', 'contactno', 'contact no']),
            dept: headerIndex(['department', 'dept']),
            desig: headerIndex(['designation', 'title', 'role']),
            doj: headerIndex(['doj', 'date of joining', 'date_of_joining', 'joining date']),
            active: headerIndex(['active', 'status'])
        };
        for (let i = 1; i < rows.length; i++) {
            const values = rows[i].map(v => v.replace(/^"|"$/g, ''));
            if (!values || values.length === 0 || values.every(v => v === '')) continue;
            let empData = {};
            const pick = (i, fallback) => (i >= 0 ? values[i] : (fallback ?? ''));
            if (hasEmployeeId) {
                empData = {
                    employee_id: pick(idx.id, values[0]),
                    first_name: pick(idx.first, values[1]),
                    last_name: pick(idx.last, values[2]),
                    email: pick(idx.email, values[3]),
                    address: pick(idx.address, values[4]),
                    contact_number: pick(idx.contact, values[5]),
                    department: pick(idx.dept, values[6]),
                    designation: pick(idx.desig, values[7]),
                    doj: pick(idx.doj, values[8]),
                    active: (() => { const v = pick(idx.active, values[9]); return (v || '').toLowerCase() === 'true' || v === '1'; })()
                };
            } else {
                empData = {
                    employee_id: '',
                    first_name: pick(idx.first, values[0]),
                    last_name: pick(idx.last, values[1]),
                    email: pick(idx.email, values[2]),
                    address: pick(idx.address, values[3]),
                    contact_number: pick(idx.contact, values[4]),
                    department: pick(idx.dept, values[5]),
                    designation: pick(idx.desig, values[6]),
                    doj: pick(idx.doj, values[7]),
                    active: (() => { const v = pick(idx.active, values[8]); return (v || '').toLowerCase() === 'true' || v === '1'; })()
                };
            }
            // Heuristic fix: if address looks like a phone number and contact looks like an address, swap them
            const looksPhone = (s) => (s || '').replace(/[^0-9]/g, '').length >= 7 && (s || '').replace(/[^0-9]/g, '').length <= 15;
            const looksAddress = (s) => /[,\n]|\d{3,}[^\d]|[A-Za-z]{3,}/.test(s || '');
            if (looksPhone(empData.address) && looksAddress(empData.contact_number)) {
                const tmp = empData.address;
                empData.address = empData.contact_number;
                empData.contact_number = tmp;
            }
            parsedEmployees.push(empData);
        }
        // Majority-based safeguard swap if most rows appear inverted
        const looksPhone = (s) => (s || '').replace(/[^0-9]/g, '').length >= 7 && (s || '').replace(/[^0-9]/g, '').length <= 15;
        const looksAddress = (s) => /[,\n]|\d{3,}[^\d]|[A-Za-z]{3,}/.test(s || '');
        let inverted = 0;
        for (const emp of parsedEmployees) {
            if (looksPhone(emp.address) && looksAddress(emp.contact_number)) inverted++;
        }
        if (inverted > parsedEmployees.length * 0.6) {
            for (const emp of parsedEmployees) {
                const tmp = emp.address; emp.address = emp.contact_number; emp.contact_number = tmp;
            }
        } else {
            for (const emp of parsedEmployees) {
                if (looksPhone(emp.address) && looksAddress(emp.contact_number)) {
                    const tmp = emp.address; emp.address = emp.contact_number; emp.contact_number = tmp;
                }
            }
        }
        const count = parsedEmployees.length;
        if (count === 0) {
            if (preview) preview.innerHTML = `<p class="error-message">No valid employee records found in CSV</p>`;
            if (submitBtn) submitBtn.disabled = true;
            return;
        }
        const previewHeaders = ['Employee ID', 'First Name', 'Last Name', 'Email', 'Contact Number', 'Address', 'Department', 'Designation', 'DOJ', 'Active'];
        const headerHtml = `<thead><tr>${previewHeaders.map(h => `<th>${h}</th>`).join('')}</tr></thead>`;
        const rowsHtml = parsedEmployees.slice(0, maxPreview).map(emp => `
            <tr>
                <td>${emp.employee_id || '<em>Auto-generated</em>'}</td>
                <td>${emp.first_name || ''}</td>
                <td>${emp.last_name || ''}</td>
                <td>${emp.email || ''}</td>
                <td>${(emp.contact_number || '').replace(/\r?\n/g, ' ')}</td>
                <td>${(emp.address || '').replace(/\r?\n/g, ' ')}</td>
                <td>${emp.department || ''}</td>
                <td>${emp.designation || ''}</td>
                <td>${emp.doj || ''}</td>
                <td>${emp.active ? 'true' : 'false'}</td>
            </tr>
        `).join('');
        const tableHtml = `
            <div class="success-message-preview">Found ${count} employees. Previewing first ${Math.min(count, maxPreview)} rows</div>
            <div class="table-container"><table class="table">${headerHtml}<tbody>${rowsHtml}</tbody></table></div>
        `;
        if (preview) preview.innerHTML = tableHtml;
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = `Confirm Upload (${count})`;
        }
    };
    reader.readAsText(file);
};

export const handleBulkUpload = async (e) => {
    e.preventDefault();
    if (!getEmployeeAccess().canManageEmployees) {
        alert('You have view-only access to employees.');
        return;
    }

    if (!parsedEmployees || parsedEmployees.length === 0) {
        const fileInput = document.getElementById('csvFile');
        const file = fileInput?.files[0];
        if (!file) {
            alert('Please select a CSV file');
            return;
        }
        const reader = new FileReader();
        reader.onload = async (event) => {
            try {
                const text = event.target.result || '';
                const rows = parseCSVText(text);
                const employees = [];
                if (!rows || rows.length < 2) {
                    alert('No valid employee records found in CSV');
                    return;
                }
                const headersRaw = rows[0].map(h => h.replace(/^"|"$/g, '').replace(/^\ufeff/, ''));
                const norm = (s) => (s || '').toString().replace(/^\ufeff/, '').trim().toLowerCase();
                const headerIndex = (names) => {
                    const set = new Set(names.map(norm));
                    for (let idx = 0; idx < headersRaw.length; idx++) {
                        if (set.has(norm(headersRaw[idx]))) return idx;
                    }
                    return -1;
                };
                const hasEmployeeId = headerIndex(['employee_id', 'emp_id', 'employee id']) !== -1;
                const idx = {
                    id: headerIndex(['employee_id', 'emp_id', 'employee id']),
                    first: headerIndex(['first_name', 'first name', 'firstname']),
                    last: headerIndex(['last_name', 'last name', 'lastname', 'surname']),
                    email: headerIndex(['email', 'e-mail']),
                    address: headerIndex(['address', 'addr', 'residential address']),
                    contact: headerIndex(['contact_number', 'contact number', 'mobile', 'phone', 'phone number', 'mobile number', 'contactno', 'contact no']),
                    dept: headerIndex(['department', 'dept']),
                    desig: headerIndex(['designation', 'title', 'role']),
                    doj: headerIndex(['doj', 'date of joining', 'date_of_joining', 'joining date']),
                    active: headerIndex(['active', 'status'])
                };
                for (let i = 1; i < rows.length; i++) {
                    const values = rows[i].map(v => v.replace(/^\"|\"$/g, ''));
                    if (!values || values.length === 0 || values.every(v => v === '')) continue;
                    const pick = (i, fallback) => (i >= 0 ? values[i] : (fallback ?? ''));
                    if (hasEmployeeId && values.length >= 10) {
                        employees.push({
                            employee_id: pick(idx.id, values[0]),
                            first_name: pick(idx.first, values[1]),
                            last_name: pick(idx.last, values[2]),
                            email: pick(idx.email, values[3]),
                            address: pick(idx.address, values[4]),
                            contact_number: pick(idx.contact, values[5]),
                            department: pick(idx.dept, values[6]),
                            designation: pick(idx.desig, values[7]),
                            doj: pick(idx.doj, values[8]),
                            active: (() => { const v = pick(idx.active, values[9]); return (v || '').toLowerCase() === 'true' || v === '1'; })()
                        });
                    } else if (!hasEmployeeId && values.length >= 9) {
                        employees.push({
                            employee_id: '',
                            first_name: pick(idx.first, values[0]),
                            last_name: pick(idx.last, values[1]),
                            email: pick(idx.email, values[2]),
                            address: pick(idx.address, values[3]),
                            contact_number: pick(idx.contact, values[4]),
                            department: pick(idx.dept, values[5]),
                            designation: pick(idx.desig, values[6]),
                            doj: pick(idx.doj, values[7]),
                            active: (() => { const v = pick(idx.active, values[8]); return (v || '').toLowerCase() === 'true' || v === '1'; })()
                        });
                    }
                }
                // Apply the same heuristic swap on the collected employees
                const looksPhone = (s) => (s || '').replace(/[^0-9]/g, '').length >= 7 && (s || '').replace(/[^0-9]/g, '').length <= 15;
                const looksAddress = (s) => /[,\n]|\d{3,}[^\d]|[A-Za-z]{3,}/.test(s || '');
                let inverted = 0;
                for (const emp of employees) {
                    if (looksPhone(emp.address) && looksAddress(emp.contact_number)) inverted++;
                }
                if (inverted > employees.length * 0.6) {
                    for (const emp of employees) {
                        const tmp = emp.address; emp.address = emp.contact_number; emp.contact_number = tmp;
                    }
                } else {
                    for (const emp of employees) {
                        if (looksPhone(emp.address) && looksAddress(emp.contact_number)) {
                            const tmp = emp.address; emp.address = emp.contact_number; emp.contact_number = tmp;
                        }
                    }
                }
                if (employees.length === 0) {
                    alert('No valid employee records found in CSV');
                    return;
                }
                await submitBulkEmployees(employees);
            } catch (err) {
                alert(`Failed to process CSV: ${err.message}`);
            }
        };
        reader.readAsText(file);
        return;
    }
    await submitBulkEmployees(parsedEmployees);
};

const submitBulkEmployees = async (employees) => {
    try {
        const response = await fetch(`${API_BASE_URL}/api/employees/bulk`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ employees })
        });
        const result = await response.json();

        if (response.ok && result.success) {
            if (result.errors && result.errors.length > 0) {
                const errorMsg = result.errors.slice(0, 3).join('\n');
                const moreErrors = result.errors.length > 3 ? `\n... and ${result.errors.length - 3} more errors (check console)` : '';
                alert(`Partial Upload:
${result.message}

First 3 Errors:
${errorMsg}${moreErrors}`);
                closeModal();
                await renderEmployeesPage('', 1);
            } else {
                closeModal();
                await renderEmployeesPage('', 1);
                alert(`Successfully uploaded ${result.count || employees.length} employees to Dataverse!`);
            }
        } else {
            // Check if it's a duplicate error
            if (result.duplicates && result.duplicates.length > 0) {
                const dupList = result.duplicates.slice(0, 10).join(', ');
                const moreDups = result.duplicates.length > 10 ? `\n... and ${result.duplicates.length - 10} more` : '';
                alert(`⚠️ DUPLICATE EMPLOYEE IDs DETECTED!

${result.message}

Duplicate IDs:
${dupList}${moreDups}

Please remove or update these employees before uploading.`);
            } else {
                alert(`${result.error || 'Failed to upload employees'}`);
            }
        }
    } catch (err) {
        alert(`Failed to upload: ${err.message}`);
    }
};

export const showBulkDeleteModal = () => {
    if (!getEmployeeAccess().canManageEmployees) {
        alert('You have view-only access to employees.');
        return;
    }
    bulkDeleteFilter = '';
    bulkDeleteSelected = new Set();
    bulkDeleteSortType = 'id';
    bulkDeleteSortOrder = 'asc';
    const formHTML = `
        <div class="form-group bulk-action-row">
            <label class="bulk-select-all bulk-select-all-left">
                <input type="checkbox" id="bulk-delete-select-all" /> Select All
            </label>
        </div>
        <div id="bulk-delete-table" class="table-container" style="max-height:300px; overflow:auto;"><div class="loading-placeholder">Loading all employees...</div></div>
        <div style="display:flex; gap:8px; justify-content:space-between; margin-top:12px;">
            <button type="button" class="btn" id="bulk-restore-recently-deleted" ${hasDeletedEmployees ? '' : 'disabled'}>View Deleted Records</button>
            <button type="submit" id="bulk-delete-confirm-btn" class="btn btn-danger">Delete Selected</button>
        </div>
    `;
    renderModal('Bulk Delete Employees', formHTML, 'bulk-delete-confirm-btn');
    setTimeout(async () => {
        // Fetch ALL employees for bulk delete preview (up to backend limit)
        try {
            // Check if deleted employees exist in backend
            const deletedEmps = await fetchDeletedEmployees();
            hasDeletedEmployees = deletedEmps.length > 0;

            const { items } = await listEmployees(1, 5000);
            bulkDeleteEmployees = (items || []).map(e => ({
                id: e.employee_id,
                name: `${e.first_name || ''} ${e.last_name || ''}`.trim(),
                location: e.address || '',
                jobTitle: e.designation || '',
                contactNumber: e.contact_number || '',
                department: e.department || '',
                status: (e.active === true || e.active === 'true' || e.active === 1 || e.active === 'Active') ? 'Active' : 'Inactive'
            }));
        } catch (err) {
            console.error('Failed to load all employees for bulk delete:', err);
            // Fallback to currently loaded page if all fetch fails
            bulkDeleteEmployees = (state.employees || []).slice();
        }
        renderBulkDeleteTable();
        const sortType = document.getElementById('bulk-delete-sort-type');
        const sortBtn = document.getElementById('bulk-delete-sort-btn');
        const selectAll = document.getElementById('bulk-delete-select-all');
        const restoreBtn = document.getElementById('bulk-restore-recently-deleted');
        const submit = document.getElementById('bulk-delete-confirm-btn');

        if (sortType) sortType.addEventListener('change', handleBulkDeleteSortTypeChange);
        if (sortBtn) sortBtn.addEventListener('click', handleBulkDeleteSort);
        if (selectAll) selectAll.addEventListener('change', handleBulkDeleteToggleSelectAll);
        if (restoreBtn) {
            restoreBtn.disabled = !hasDeletedEmployees;
            restoreBtn.addEventListener('click', () => {
                closeModal();
                window.location.hash = '#/employees/bulk-delete';
            });
        }
    }, 50);
};

const renderBulkDeleteTable = () => {
    const container = document.getElementById('bulk-delete-table');
    if (!container) return;
    let list = (bulkDeleteEmployees || []).slice();

    // Apply sorting
    list.sort((a, b) => {
        let aVal, bVal;
        switch (bulkDeleteSortType) {
            case 'name':
                aVal = (a.name || '').toLowerCase();
                bVal = (b.name || '').toLowerCase();
                break;
            case 'department':
                aVal = (a.department || '').toLowerCase();
                bVal = (b.department || '').toLowerCase();
                break;
            case 'designation':
                aVal = (a.jobTitle || '').toLowerCase();
                bVal = (b.jobTitle || '').toLowerCase();
                break;
            case 'id':
            default:
                aVal = (a.id || '').toLowerCase();
                bVal = (b.id || '').toLowerCase();
                break;
        }

        if (bulkDeleteSortOrder === 'asc') {
            return aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
        } else {
            return aVal > bVal ? -1 : aVal < bVal ? 1 : 0;
        }
    });
    const rows = list.map(e => {
        const checked = bulkDeleteSelected.has(e.id) ? 'checked' : '';
        return `
            <tr>
                <td><input type="checkbox" class="bulk-row-check" data-id="${e.id}" ${checked} /></td>
                <td>${e.id}</td>
                <td>${e.name || ''}</td>
                <td>${e.department || ''}</td>
                <td>${e.jobTitle || ''}</td>
            </tr>
        `;
    }).join('');
    container.innerHTML = `
        <table class="table">
            <thead><tr><th></th><th>Employee ID</th><th>Name</th><th>Department</th><th>Designation</th></tr></thead>
            <tbody>${rows || `<tr><td colspan="5" class="placeholder-text">No employees match the filter.</td></tr>`}</tbody>
        </table>
    `;
    container.querySelectorAll('.bulk-row-check').forEach(cb => {
        cb.addEventListener('change', handleBulkDeleteRowToggle);
    });
    const selectAll = document.getElementById('bulk-delete-select-all');
    if (selectAll) {
        const allIds = list.map(e => e.id);
        const allSelected = allIds.length > 0 && allIds.every(id => bulkDeleteSelected.has(id));
        selectAll.checked = allSelected;
        selectAll.indeterminate = !allSelected && Array.from(bulkDeleteSelected).some(id => allIds.includes(id));
    }
};

// New function to render deleted employees table
const renderDeletedEmployeesTable = () => {
    const container = document.getElementById('deleted-employees-table');
    const countElement = document.getElementById('deleted-count');
    if (!container) return;

    let list = (currentDeletedEmployees || []).slice();

    // Apply search filter
    if (deletedSearchFilter) {
        const filter = deletedSearchFilter.toLowerCase();
        list = list.filter(emp => {
            const name = `${emp.first_name || ''} ${emp.last_name || ''}`.trim();
            return (emp.employee_id || '').toLowerCase().includes(filter) ||
                name.toLowerCase().includes(filter);
        });
    }

    const rows = list.map(emp => {
        const checked = restoreSelected.has(emp.employee_id) ? 'checked' : '';
        const name = `${emp.first_name || ''} ${emp.last_name || ''}`.trim();
        return `
            <tr>
                <td><input type="checkbox" class="deleted-row-check" data-id="${emp.employee_id}" ${checked} /></td>
                <td>${emp.employee_id || ''}</td>
                <td>${name}</td>
                <td>${emp.department || ''}</td>
                <td>${emp.designation || ''}</td>
                <td>
                    <button type="button" class="btn btn-warning btn-sm" onclick="handleRestoreSingle('${emp.employee_id}')">
                        <i class="fa-solid fa-rotate-left"></i> Restore
                    </button>
                </td>
            </tr>
        `;
    }).join('');

    container.innerHTML = `
        <table class="table">
            <thead><tr><th></th><th>Employee ID</th><th>Name</th><th>Department</th><th>Designation</th><th>Action</th></tr></thead>
            <tbody>${rows || `<tr><td colspan="6" class="placeholder-text">No deleted employees found.</td></tr>`}</tbody>
        </table>
    `;

    // Update count
    if (countElement) {
        countElement.textContent = list.length;
    }

    // Update button states
    const restoreSelectedBtn = document.getElementById('restore-selected-btn');
    const restoreAllBtn = document.getElementById('restore-all-btn');

    if (restoreSelectedBtn) {
        restoreSelectedBtn.disabled = restoreSelected.size === 0;
    }
    if (restoreAllBtn) {
        restoreAllBtn.disabled = list.length === 0;
    }

    // Add event listeners to checkboxes
    container.querySelectorAll('.deleted-row-check').forEach(checkbox => {
        checkbox.addEventListener('change', handleDeletedRowToggle);
    });
};

export const handleBulkDeleteSortTypeChange = (e) => {
    bulkDeleteSortType = e.target.value || 'id';
    renderBulkDeleteTable();
};

// New event handlers for deleted employees functionality
let deletedSearchFilter = '';

export const handleDeletedSearch = (e) => {
    deletedSearchFilter = e.target.value || '';
    renderDeletedEmployeesTable();
};

export const handleDeletedSelectAll = (e) => {
    const checked = !!e.target.checked;
    const filtered = (currentDeletedEmployees || []).filter(emp => {
        const f = (deletedSearchFilter || '').toLowerCase();
        const name = `${emp.first_name || ''} ${emp.last_name || ''}`.trim();
        return !f || (emp.employee_id || '').toLowerCase().includes(f) || name.toLowerCase().includes(f);
    });

    if (checked) {
        filtered.forEach(emp => restoreSelected.add(emp.employee_id));
    } else {
        filtered.forEach(emp => restoreSelected.delete(emp.employee_id));
    }
    renderDeletedEmployeesTable();
};

export const handleDeletedRowToggle = (e) => {
    const id = e.target.getAttribute('data-id');
    if (!id) return;

    if (e.target.checked) {
        restoreSelected.add(id);
    } else {
        restoreSelected.delete(id);
    }
    renderDeletedEmployeesTable();
};

export const handleRestoreSingle = async (employeeId) => {
    if (!employeeId) return;

    try {
        const response = await fetch(`${API_BASE_URL}/api/deleted-employees/restore`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ employee_ids: [employeeId] })
        });

        const result = await response.json();

        if (response.ok && result.success) {
            alert(`Successfully restored employee ${employeeId}`);
            // Refresh the data
            currentDeletedEmployees = await fetchDeletedEmployees();
            hasDeletedEmployees = currentDeletedEmployees.length > 0;
            renderDeletedEmployeesTable();
            // Also refresh the active employees table
            const { items } = await listEmployees(1, 5000);
            bulkDeleteEmployees = (items || []).map(e => ({
                id: e.employee_id,
                name: `${e.first_name || ''} ${e.last_name || ''}`.trim(),
                location: e.address || '',
                jobTitle: e.designation || '',
                contactNumber: e.contact_number || '',
                department: e.department || '',
                status: (e.active === true || e.active === 'true' || e.active === 1 || e.active === 'Active') ? 'Active' : 'Inactive'
            }));
            renderBulkDeleteTable();
        } else {
            alert(`Failed to restore employee: ${result.error || 'Unknown error'}`);
        }
    } catch (err) {
        console.error('Error restoring employee:', err);
        alert(`Failed to restore employee: ${err.message}`);
    }
};

// Make handleRestoreSingle available globally for onclick handlers
window.handleRestoreSingle = handleRestoreSingle;

export const handleRestoreSelected = async () => {
    const ids = Array.from(restoreSelected);
    if (ids.length === 0) {
        alert('Select at least one employee to restore');
        return;
    }

    try {
        const response = await fetch(`${API_BASE_URL}/api/deleted-employees/restore`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ employee_ids: ids })
        });

        const result = await response.json();

        if (response.ok && result.success) {
            let message = result.message || `Successfully restored ${result.restored} employee(s)`;
            if (result.errors && result.errors.length > 0) {
                message += "\n\nErrors:\n" + result.errors.slice(0, 3).join("\n");
                if (result.errors.length > 3) {
                    message += `\n... and ${result.errors.length - 3} more errors`;
                }
            }
            alert(message);

            // Refresh the data
            currentDeletedEmployees = await fetchDeletedEmployees();
            hasDeletedEmployees = currentDeletedEmployees.length > 0;
            restoreSelected.clear();
            renderDeletedEmployeesTable();

            // Also refresh the active employees table
            const { items } = await listEmployees(1, 5000);
            bulkDeleteEmployees = (items || []).map(e => ({
                id: e.employee_id,
                name: `${e.first_name || ''} ${e.last_name || ''}`.trim(),
                location: e.address || '',
                jobTitle: e.designation || '',
                contactNumber: e.contact_number || '',
                department: e.department || '',
                status: (e.active === true || e.active === 'true' || e.active === 1 || e.active === 'Active') ? 'Active' : 'Inactive'
            }));
            renderBulkDeleteTable();
        } else {
            alert(`Failed to restore employees: ${result.error || 'Unknown error'}`);
        }
    } catch (err) {
        console.error('Error restoring employees:', err);
        alert(`Failed to restore employees: ${err.message}`);
    }
};

export const handleBulkDeleteSort = () => {
    // Toggle sort order
    bulkDeleteSortOrder = bulkDeleteSortOrder === 'asc' ? 'desc' : 'asc';

    // Update button icon
    const sortBtn = document.getElementById('bulk-delete-sort-btn');
    if (sortBtn) {
        const icon = sortBtn.querySelector('i');
        if (icon) {
            icon.className = bulkDeleteSortOrder === 'asc' ? 'fa-solid fa-arrow-up-short-wide' : 'fa-solid fa-arrow-down-wide-short';
        }
    }

    renderBulkDeleteTable();
};

export const handleBulkDeleteToggleSelectAll = (e) => {
    const checked = !!e.target.checked;
    const list = (bulkDeleteEmployees || []);
    if (checked) list.forEach(emp => bulkDeleteSelected.add(emp.id));
    else list.forEach(emp => bulkDeleteSelected.delete(emp.id));
    renderBulkDeleteTable();
};

export const handleBulkDeleteRowToggle = (e) => {
    const id = e.target.getAttribute('data-id');
    if (!id) return;
    if (e.target.checked) bulkDeleteSelected.add(id); else bulkDeleteSelected.delete(id);
    renderBulkDeleteTable();
};

export const handleBulkDeleteConfirm = async (e) => {
    e.preventDefault();
    if (!getEmployeeAccess().canManageEmployees) {
        alert('You have view-only access to employees.');
        return;
    }
    const ids = Array.from(bulkDeleteSelected);
    if (ids.length === 0) {
        alert('Select at least one employee');
        return;
    }
    // Build toDelete from the full bulk list so preview matches deletions
    const toDelete = (bulkDeleteEmployees || []).filter(emp => ids.includes(emp.id));
    lastDeletedEmployees = toDelete.map(emp => ({
        employee_id: emp.id,
        first_name: (emp.name || '').split(' ')[0] || '',
        last_name: (emp.name || '').split(' ').slice(1).join(' ') || '',
        email: '',
        contact_number: emp.contactNumber || '',
        address: emp.location || '',
        department: emp.department || '',
        designation: emp.jobTitle || '',
        doj: '',
        active: false
    }));

    // Append deleted employees to CSV storage (before attempting delete)
    await appendToDeletedCSV(lastDeletedEmployees);

    // Track deletion results
    let successCount = 0;
    let alreadyDeletedCount = 0;
    let errorCount = 0;

    for (const id of ids) {
        try {
            await deleteEmployee(id);
            successCount++;
        } catch (err) {
            // Check if error is "not found" (already deleted)
            const errMsg = err.message || String(err);
            if (errMsg.includes('not found') || errMsg.includes('Does Not Exist') || errMsg.includes('404')) {
                alreadyDeletedCount++;
            } else {
                errorCount++;
                console.error('Delete failed for', id, err);
            }
        }
    }

    // Remove from local caches
    state.employees = state.employees.filter(emp => !ids.includes(emp.id));
    bulkDeleteEmployees = bulkDeleteEmployees.filter(emp => !ids.includes(emp.id));

    // Show appropriate message
    let message = '';
    if (successCount > 0) {
        message += `Successfully deleted ${successCount} employee${successCount > 1 ? 's' : ''}`;
    }
    if (alreadyDeletedCount > 0) {
        if (message) message += '\n';
        message += `${alreadyDeletedCount} employee${alreadyDeletedCount > 1 ? 's were' : ' was'} already deleted`;
    }
    if (errorCount > 0) {
        if (message) message += '\n';
        message += `${errorCount} deletion${errorCount > 1 ? 's' : ''} failed (check console)`;
    }
    if (!message) {
        message = `Processed ${ids.length} employee${ids.length > 1 ? 's' : ''}`;
    }
    message += '\n\nAll selected employees have been saved to restore history.';

    alert(message);

    // Stay on current view and enable restore button
    const restoreBtn = document.getElementById('bulk-restore-recently-deleted');
    if (restoreBtn) restoreBtn.disabled = hasDeletedEmployees ? false : true;
    // If on full-page bulk delete route, refresh that page
    if (window.location.hash === '#/employees/bulk-delete') {
        // Refresh deleted employees data
        currentDeletedEmployees = await fetchDeletedEmployees();
        hasDeletedEmployees = currentDeletedEmployees.length > 0;
        renderDeletedEmployeesTable();
        renderBulkDeleteTable();
        return;
    }
    // If modal is open, just refresh the table without closing
    renderBulkDeleteTable();
};

const buildEmployeesCSV = (employees) => {
    const headers = ['employee_id', 'first_name', 'last_name', 'email', 'address', 'contact_number', 'department', 'designation', 'doj', 'active'];
    const rows = employees.map(e => [
        e.employee_id || '',
        e.first_name || '',
        e.last_name || '',
        e.email || '',
        e.address || '',
        e.contact_number || '',
        e.department || '',
        e.designation || '',
        e.doj || '',
        e.active ? 'true' : 'false'
    ].map(v => String(v).includes(',') ? `"${String(v).replace(/"/g, '""')}"` : String(v)).join(','));
    return `${headers.join(',')}` + '\n' + rows.join('\n');
};

const triggerDownloadCSV = (filename, csv) => {
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
};

const appendToDeletedCSV = async (employees) => {
    if (!employees || employees.length === 0) return;

    try {
        const response = await fetch(`${API_BASE_URL}/api/deleted-employees/append`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ employees })
        });

        const result = await response.json();
        if (response.ok && result.success) {
            console.log(`✅ Appended ${employees.length} employees to backend CSV`);
            hasDeletedEmployees = true;
        } else {
            console.error('Failed to append to deleted employees CSV:', result.error);
        }
    } catch (err) {
        console.error('Error appending to deleted employees CSV:', err);
    }
};

const fetchDeletedEmployees = async () => {
    try {
        const response = await fetch(`${API_BASE_URL}/api/deleted-employees`);
        const result = await response.json();

        if (response.ok && result.success) {
            hasDeletedEmployees = result.count > 0;
            return result.employees || [];
        } else {
            console.error('Failed to fetch deleted employees:', result.error);
            return [];
        }
    } catch (err) {
        console.error('Error fetching deleted employees:', err);
        return [];
    }
};

export const handleExportDeletedCSV = () => {
    if (!lastDeletedEmployees.length) { alert('No deleted employees to export'); return; }
    triggerDownloadCSV('deleted_employees.csv', buildEmployeesCSV(lastDeletedEmployees));
};

// TEST FUNCTION - Manually restore all deleted employees (for debugging)
window.testRestoreAll = async () => {
    console.log('TEST: Starting manual restore of all deleted employees');
    const allDeleted = await fetchDeletedEmployees();
    console.log('TEST: Found', allDeleted.length, 'deleted employees');

    if (allDeleted.length === 0) {
        alert('No deleted employees to restore');
        return;
    }

    const allIds = allDeleted.map(emp => emp.employee_id);

    try {
        const response = await fetch(`${API_BASE_URL}/api/deleted-employees/restore`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ employee_ids: allIds })
        });

        const result = await response.json();

        if (response.ok && result.success) {
            console.log(`TEST: Restored ${result.restored} employees`);
            alert(`Test complete: Restored ${result.restored} employees`);
            hasDeletedEmployees = false;
            await renderEmployeesPage('', 1);
        } else {
            alert(`Test failed: ${result.error}`);
        }
    } catch (err) {
        console.error('TEST: Error:', err);
        alert(`Test failed: ${err.message}`);
    }
};

export const showRestoreRecentlyDeletedModal = async () => {
    // Clear selections when opening modal
    restoreSelected.clear();
    restoreFilter = '';

    console.log('🔓 Opening restore modal - cleared selections');

    currentDeletedEmployees = await fetchDeletedEmployees();
    console.log('📊 Loaded', currentDeletedEmployees.length, 'deleted employees');
    console.log('✅ restoreSelected initialized:', restoreSelected);

    if (!currentDeletedEmployees.length) {
        alert('No deleted employees to restore');
        return;
    }

    const formHTML = `
        <div class="form-group" style="display:flex; gap:12px; align-items:center;">
            <input type="text" id="restore-search" placeholder="Search by Employee ID or Name" style="flex:1;" />
            <label style="display:flex; align-items:center; gap:6px;">
                <input type="checkbox" id="restore-select-all" /> Select All
            </label>
        </div>
        <div id="restore-preview-table" class="table-container" style="max-height:500px; overflow:auto;">
            <div class="loading-placeholder">Loading deleted employees...</div>
        </div>
        <div style="display:flex; justify-content:space-between; align-items:center; margin-top:12px;">
            <div class="muted-info-text">
                Total deleted employees: ${currentDeletedEmployees.length}
            </div>
            <button type="button" id="restore-all-btn" class="btn btn-warning">
                <i class="fa-solid fa-rotate-left"></i> Restore All
            </button>
        </div>
    `;

    renderModal('Restore Recently Deleted Employees', formHTML, 'restore-confirm-btn', 'large');

    setTimeout(() => {
        renderRestorePreviewTable();

        const search = document.getElementById('restore-search');
        const selectAll = document.getElementById('restore-select-all');
        const submitBtn = document.getElementById('restore-confirm-btn');
        const restoreAllBtn = document.getElementById('restore-all-btn');

        if (submitBtn) {
            submitBtn.textContent = 'Restore Selected';
            // Add a click listener to debug
            submitBtn.addEventListener('click', (e) => {
                console.log('🖱️ Restore Selected button clicked!');
                console.log('📦 restoreSelected at click time:', restoreSelected);
                console.log('📋 Array from Set:', Array.from(restoreSelected));
                console.log('🔢 Size:', restoreSelected.size);
            });
        }

        if (search) search.addEventListener('input', (e) => {
            restoreFilter = e.target.value || '';
            renderRestorePreviewTable();
        });

        if (selectAll) selectAll.addEventListener('change', (e) => {
            const checked = !!e.target.checked;
            const filtered = currentDeletedEmployees.filter(emp => {
                const f = (restoreFilter || '').toLowerCase();
                const name = `${emp.first_name} ${emp.last_name}`.trim();
                return !f || (emp.employee_id || '').toLowerCase().includes(f) || name.toLowerCase().includes(f);
            });
            console.log('Select all clicked:', checked, 'Filtered employees:', filtered.length);
            if (checked) filtered.forEach(emp => restoreSelected.add(emp.employee_id));
            else filtered.forEach(emp => restoreSelected.delete(emp.employee_id));
            console.log('Selected IDs after select-all:', Array.from(restoreSelected));
            renderRestorePreviewTable();
        });

        if (restoreAllBtn) restoreAllBtn.addEventListener('click', handleRestoreAll);
    }, 50);
};

const handleRestoreCheckboxChange = (e) => {
    const target = e.target;

    // Check if it's a restore checkbox
    if (!target || target.type !== 'checkbox') return;
    if (!target.classList.contains('restore-row-check')) return;

    const id = target.getAttribute('data-id');
    if (!id) {
        console.warn('Checkbox has no data-id attribute');
        return;
    }

    console.log('Restore checkbox changed for:', id, 'Checked:', target.checked);

    if (target.checked) {
        restoreSelected.add(id);
    } else {
        restoreSelected.delete(id);
    }

    console.log('Currently selected IDs:', Array.from(restoreSelected));

    // Update select-all checkbox state
    const selectAll = document.getElementById('restore-select-all');
    if (selectAll && currentDeletedEmployees.length > 0) {
        const filtered = currentDeletedEmployees.filter(emp => {
            const f = (restoreFilter || '').toLowerCase();
            const name = `${emp.first_name} ${emp.last_name}`.trim();
            return !f || (emp.employee_id || '').toLowerCase().includes(f) || name.toLowerCase().includes(f);
        });
        const allIds = filtered.map(e => e.employee_id);
        const allSelected = allIds.length > 0 && allIds.every(id => restoreSelected.has(id));
        selectAll.checked = allSelected;
        selectAll.indeterminate = !allSelected && Array.from(restoreSelected).some(id => allIds.includes(id));
    }
};

const renderRestorePreviewTable = () => {
    const container = document.getElementById('restore-preview-table');
    if (!container) return;

    const filtered = currentDeletedEmployees.filter(emp => {
        const f = (restoreFilter || '').toLowerCase();
        const name = `${emp.first_name} ${emp.last_name}`.trim();
        return !f || (emp.employee_id || '').toLowerCase().includes(f) || name.toLowerCase().includes(f);
    });

    const rows = filtered.map(emp => {
        const checked = restoreSelected.has(emp.employee_id) ? 'checked' : '';
        const name = `${emp.first_name} ${emp.last_name}`.trim();
        return `
            <tr>
                <td><input type="checkbox" class="restore-row-check" data-id="${emp.employee_id}" ${checked} /></td>
                <td>${emp.employee_id}</td>
                <td>${name}</td>
                <td>${emp.email || ''}</td>
                <td>${emp.contact_number || ''}</td>
                <td>${emp.address || ''}</td>
                <td>${emp.department || ''}</td>
                <td>${emp.designation || ''}</td>
                <td>${emp.doj || ''}</td>
                <td>${emp.active ? 'Active' : 'Inactive'}</td>
            </tr>
        `;
    }).join('');

    container.innerHTML = `
        <table class="table">
            <thead>
                <tr>
                    <th style="width:40px;"></th>
                    <th>Employee ID</th>
                    <th>Name</th>
                    <th>Email</th>
                    <th>Contact No</th>
                    <th>Address</th>
                    <th>Department</th>
                    <th>Designation</th>
                    <th>DOJ</th>
                    <th>Status</th>
                </tr>
            </thead>
            <tbody>${rows || `<tr><td colspan="10" class="placeholder-text">No deleted employees match the filter.</td></tr>`}</tbody>
        </table>
    `;

    // Use event delegation on the container instead of individual checkboxes
    console.log('📋 Rendering restore table with', filtered.length, 'employees');
    const checkboxes = container.querySelectorAll('.restore-row-check');
    console.log('✅ Found', checkboxes.length, 'checkboxes in table');
    console.log('🔍 Currently selected:', Array.from(restoreSelected));

    // Remove old listeners and add new ones (event delegation)
    container.removeEventListener('change', handleRestoreCheckboxChange);
    container.addEventListener('change', handleRestoreCheckboxChange);

    // ALSO add direct listeners to each checkbox as a fallback
    checkboxes.forEach(checkbox => {
        checkbox.addEventListener('change', (e) => {
            const id = e.target.getAttribute('data-id');
            console.log('🔘 Direct checkbox event for:', id, 'Checked:', e.target.checked);

            if (e.target.checked) {
                restoreSelected.add(id);
            } else {
                restoreSelected.delete(id);
            }

            console.log('📦 Updated restoreSelected:', Array.from(restoreSelected));
        });
    });

    console.log('✅ Event listeners attached (delegation + direct)');

    const selectAll = document.getElementById('restore-select-all');
    if (selectAll) {
        const allIds = filtered.map(e => e.employee_id);
        const allSelected = allIds.length > 0 && allIds.every(id => restoreSelected.has(id));
        selectAll.checked = allSelected;
        selectAll.indeterminate = !allSelected && Array.from(restoreSelected).some(id => allIds.includes(id));
    }
};

const handleRestoreAll = async () => {
    if (!currentDeletedEmployees || currentDeletedEmployees.length === 0) {
        alert('No deleted employees to restore');
        return;
    }

    if (!confirm(`Are you sure you want to restore all ${currentDeletedEmployees.length} deleted employees?`)) {
        return;
    }

    console.log('Restoring all deleted employees:', currentDeletedEmployees.length);

    const allIds = currentDeletedEmployees.map(emp => emp.employee_id);

    try {
        const response = await fetch(`${API_BASE_URL}/api/deleted-employees/restore`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ employee_ids: allIds })
        });

        const result = await response.json();

        if (response.ok && result.success) {
            let message = result.message || `Successfully restored ${result.restored} employee(s)`;
            if (result.errors && result.errors.length > 0) {
                message += "\n\nErrors:\n" + result.errors.slice(0, 3).join("\n");
                if (result.errors.length > 3) {
                    message += `\n... and ${result.errors.length - 3} more errors`;
                }
            }
            alert(message);

            // Refresh deleted employees data
            currentDeletedEmployees = await fetchDeletedEmployees();
            hasDeletedEmployees = currentDeletedEmployees.length > 0;
            restoreSelected.clear();

            // If on full-page bulk delete route, refresh that page
            if (window.location.hash === '#/employees/bulk-delete') {
                renderDeletedEmployeesTable();
                // Also refresh the active employees table
                const { items } = await listEmployees(1, 5000);
                bulkDeleteEmployees = (items || []).map(e => ({
                    id: e.employee_id,
                    name: `${e.first_name || ''} ${e.last_name || ''}`.trim(),
                    location: e.address || '',
                    jobTitle: e.designation || '',
                    contactNumber: e.contact_number || '',
                    department: e.department || '',
                    status: (e.active === true || e.active === 'true' || e.active === 1 || e.active === 'Active') ? 'Active' : 'Inactive'
                }));
                renderBulkDeleteTable();
            } else {
                closeModal();
                await renderEmployeesPage('', 1);
            }
        } else {
            alert(`Failed to restore employees: ${result.error || 'Unknown error'}`);
        }
    } catch (err) {
        console.error('Error restoring all employees:', err);
        alert(`Failed to restore employees: ${err.message}`);
    }
};

export const handleRestoreConfirm = async (e) => {
    e.preventDefault();

    console.log('🚀 Restore confirm triggered');
    console.log('📊 restoreSelected Set:', restoreSelected);
    console.log('📋 Selected IDs array:', Array.from(restoreSelected));
    console.log('🔢 Number of selected:', restoreSelected.size);

    const ids = Array.from(restoreSelected);

    if (ids.length === 0) {
        console.error('❌ No employees selected! restoreSelected is empty');
        alert('Select at least one employee to restore');
        return;
    }

    console.log('✅ Proceeding with restore of', ids.length, 'employees:', ids);

    try {
        const response = await fetch(`${API_BASE_URL}/api/deleted-employees/restore`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ employee_ids: ids })
        });

        let result;
        try {
            result = await response.json();
        } catch (jsonErr) {
            console.error('Failed to parse JSON response:', jsonErr);
            alert(`Server error: Failed to parse response (status ${response.status})`);
            return;
        }

        if (response.ok && result.success) {
            let message = result.message || `Successfully restored ${result.restored} employee(s)`;

            if (result.errors && result.errors.length > 0) {
                message += "\n\nErrors:\n" + result.errors.slice(0, 3).join("\n");
                if (result.errors.length > 3) {
                    message += `\n... and ${result.errors.length - 3} more errors`;
                }
            }

            // Update hasDeletedEmployees flag
            hasDeletedEmployees = result.remaining > 0;
            currentDeletedEmployees = await fetchDeletedEmployees();

            alert(message);
            closeModal();
            await renderEmployeesPage('', 1);
        } else {
            console.error('Backend error:', result);
            alert(`Failed to restore employees:\n${result.error || 'Unknown error'}\n\nCheck backend console for details.`);
        }
    } catch (err) {
        console.error('Error restoring employees:', err);
        alert(`Failed to restore employees: ${err.message}\n\nCheck backend console for details.`);
    }
};

export const handleRestoreLastDeleted = async () => {
    if (!lastDeletedEmployees.length) { alert('Nothing to restore'); return; }
    for (const emp of lastDeletedEmployees) {
        try { await createEmployee(emp); } catch (err) { console.error('Restore failed for', emp.employee_id, err); }
    }
    alert(`Restored ${lastDeletedEmployees.length} employees`);
    lastDeletedEmployees = [];
    // Refresh current context
    if (window.location.hash === '#/employees/bulk-delete') {
        await renderBulkDeletePage();
        return;
    }
    // Update modal view if present
    renderBulkDeleteTable();
};

export const handleRestoreFromCSV = async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (ev) => {
        const raw = ev.target.result || '';
        const csv = String(raw).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        const lines = csv.split('\n').filter(l => l.trim());
        if (lines.length < 2) { alert('CSV empty'); return; }
        const restored = [];
        for (let i = 1; i < lines.length; i++) {
            const v = lines[i].split(',').map(x => x.trim().replace(/^"|"$/g, ''));
            if (v.length >= 10) restored.push({
                employee_id: v[0], first_name: v[1], last_name: v[2], email: v[3], contact_number: v[5], address: v[4], department: v[6], designation: v[7], doj: v[8], active: (v[9] || '').toLowerCase() === 'true' || v[9] === '1'
            });
        }
        if (!restored.length) { alert('No valid rows to restore'); return; }
        for (const emp of restored) { try { await createEmployee(emp); } catch (err) { console.error('Restore failed for', emp.employee_id, err); } }
        alert(`Restored ${restored.length} employees`);
        await renderEmployeesPage('', 1);
    };
    reader.readAsText(file);
};