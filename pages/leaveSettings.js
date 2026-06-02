// leaveSettings.js - Leave Settings page for admin to manage leave allocation types
import { state } from '../state.js';
import { getPageContentHTML } from '../utils.js';
import { listEmployees } from '../features/employeeApi.js';
import { renderModal, closeModal } from '../components/modal.js';
import { isAdminUser, isL2OrL3User } from '../utils/accessControl.js';
import { canUseFunction, canViewApplication } from '../utils/roleSettings.js';
import { API_BASE_URL } from '../config.js';
import { renderSettingsLayout } from '../components/settingsLayout.js';

const API_BASE = `${API_BASE_URL}/api`;

// Leave allocation types configuration (defaults)
const LEAVE_ALLOCATION_TYPES = [
    {
        type: 'Type 1',
        experience: 3, // 3+ years
        casualLeave: 6,
        sickLeave: 6,
        totalQuota: 12
    },
    {
        type: 'Type 2',
        experience: 2, // 2+ years
        casualLeave: 4,
        sickLeave: 4,
        totalQuota: 8
    },
    {
        type: 'Type 3',
        experience: 1, // 1+ years
        casualLeave: 3,
        sickLeave: 3,
        totalQuota: 6
    }
];

// Live allocation types state (loaded from backend API, shared across all admins)
let allocationTypes = [...LEAVE_ALLOCATION_TYPES];

// Optimistic update overrides — stores recently saved allocation values
// that may not yet be reflected in Dataverse GET responses (eventual consistency).
const pendingAllocationOverrides = {};

// Load allocation types from backend API
const loadAllocationTypes = async () => {
    try {
        const response = await fetch(`${API_BASE}/leave-allocation-types`);
        if (response.ok) {
            const data = await response.json();
            if (data.success && Array.isArray(data.types) && data.types.length) {
                allocationTypes = data.types.map(t => ({ ...t }));
                console.log('✅ Loaded allocation types from backend:', allocationTypes);
            }
        }
    } catch (err) {
        console.error('Failed to load allocation types from backend:', err);
        allocationTypes = [...LEAVE_ALLOCATION_TYPES];
    }
};

// Initialize allocation types on module load
loadAllocationTypes();

// Parse date from various formats (Dataverse can return different formats)
const parseDate = (dateString) => {
    if (!dateString) return null;

    // Handle different date formats from Dataverse
    let date = null;

    try {
        // Try direct parsing first
        date = new Date(dateString);
        if (!isNaN(date.getTime())) {
            return date;
        }

        // Try parsing ISO date format (YYYY-MM-DD)
        if (typeof dateString === 'string' && dateString.includes('-')) {
            const parts = dateString.split('T')[0]; // Remove time part if present
            date = new Date(parts);
            if (!isNaN(date.getTime())) {
                return date;
            }
        }

        // Try parsing DD/MM/YYYY format
        if (typeof dateString === 'string' && dateString.includes('/')) {
            const parts = dateString.split('/');
            if (parts.length === 3) {
                // Assume DD/MM/YYYY format
                const day = parseInt(parts[0]);
                const month = parseInt(parts[1]) - 1; // Month is 0-indexed
                const year = parseInt(parts[2]);
                date = new Date(year, month, day);
                if (!isNaN(date.getTime())) {
                    return date;
                }
            }
        }

        console.warn(`Could not parse date: ${dateString}`);
        return null;
    } catch (error) {
        console.error(`Error parsing date: ${dateString}`, error);
        return null;
    }
};

// Calculate employee experience in years from date of joining
const calculateExperience = (dateOfJoining) => {
    if (!dateOfJoining) return 0;

    try {
        const joinDate = parseDate(dateOfJoining);

        // Check if date is valid
        if (!joinDate || isNaN(joinDate.getTime())) {
            console.warn(`Invalid date of joining: ${dateOfJoining}`);
            return 0;
        }

        const currentDate = new Date();

        // Ensure join date is not in the future
        if (joinDate > currentDate) {
            console.warn(`Date of joining is in the future: ${dateOfJoining}`);
            return 0;
        }

        const diffInMs = currentDate - joinDate;
        const diffInYears = diffInMs / (1000 * 60 * 60 * 24 * 365.25);

        return Math.max(0, Math.floor(diffInYears));
    } catch (error) {
        console.error(`Error calculating experience for date: ${dateOfJoining}`, error);
        return 0;
    }
};

// Determine allocation type based on experience using current configuration
const getAllocationType = (experienceYears) => {
    const types = [...allocationTypes].sort((a, b) => (b.experience || 0) - (a.experience || 0));
    for (const t of types) {
        const threshold = Number(t.experience || 0);
        if (experienceYears >= threshold) return t;
    }
    return types[types.length - 1] || allocationTypes[allocationTypes.length - 1] || LEAVE_ALLOCATION_TYPES[LEAVE_ALLOCATION_TYPES.length - 1];
};

// Format date for display
const formatDate = (dateString) => {
    if (!dateString) return 'N/A';

    try {
        const date = parseDate(dateString);
        if (!date || isNaN(date.getTime())) {
            // Show raw value for debugging
            console.warn(`Could not format date, showing raw value: ${dateString}`);
            return `Raw: ${dateString}`;
        }

        return date.toLocaleDateString('en-GB', {
            day: '2-digit',
            month: '2-digit',
            year: 'numeric'
        });
    } catch (error) {
        console.error(`Error formatting date: ${dateString}`, error);
        return `Error: ${dateString}`;
    }
};

// Render allocation types table (with edit actions)
const renderAllocationTypesTable = () => {
    const rows = allocationTypes.map((type, index) => `
        <tr>
            <td><strong>${type.type}</strong></td>
            <td>${type.experience}+</td>
            <td>${type.casualLeave}</td>
            <td>${type.sickLeave}</td>
            <td><strong>${type.totalQuota}</strong></td>
            <td>
                <button type="button" class="icon-btn" title="Edit allocation type" onclick="window.handleEditAllocationType(${index}, this)">
                    <i class="fa-solid fa-pen-to-square"></i>
                </button>
            </td>
        </tr>
    `).join('');

    return `
        <div class="card">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem;">
                <div>
                    <h3><i class="fa-solid fa-table"></i> Leave Allocation Types</h3>
                    <p class="allocation-description">Configure leave quotas based on employee experience.</p>
                </div>
                <button type="button" class="btn btn-primary" onclick="window.handleAddAllocationType()" style="height: 40px;">
                    <i class="fa-solid fa-plus"></i> Add Leave Type
                </button>
            </div>
            <div class="table-container">
                <table class="table">
                    <thead>
                        <tr>
                            <th>Allocation Type</th>
                            <th>Experience (Years)</th>
                            <th>Casual Leave</th>
                            <th>Sick Leave</th>
                            <th>Total Quota</th>
                            <th>Actions</th>
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

// Global Edit Allocation Type modal (rendered at page root, not inside the table card)
const renderEditAllocationTypeModal = () => {
    return '';
};

// Open edit modal for a specific allocation type
// "triggerEl" is the button that was clicked; we use its position to anchor the popup nearby.
const handleEditAllocationType = (index, triggerEl) => {
    const idx = Number(index);
    if (Number.isNaN(idx) || idx < 0 || idx >= allocationTypes.length) return;
    const current = allocationTypes[idx];

    const total = Number(current.totalQuota || (current.casualLeave || 0) + (current.sickLeave || 0));

    const formHTML = `
        <div class="modal-form modern-form team-modal">
            <div class="form-section">
                <div class="form-section-header">
                    <div>
                        <p class="form-eyebrow">LEAVE SETTINGS</p>
                        <h3>Edit allocation type</h3>
                    </div>
                </div>
                
                <input type="hidden" id="edit-type-index" value="${idx}" />
                
                <div class="form-field">
                    <label class="form-label" for="edit-type-name">Allocation Type</label>
                    <input id="edit-type-name" class="input-control" type="text" required value="${current.type || ''}" />
                </div>
                
                <div class="form-field">
                    <label class="form-label" for="edit-type-experience">Experience (Years)</label>
                    <input id="edit-type-experience" class="input-control" type="number" min="0" step="1" required value="${Number(current.experience || 0)}" />
                </div>
                
                <div class="form-field">
                    <label class="form-label">Leave Quotas</label>
                    <div class="form-grid two-col">
                        <div class="leave-type-card">
                            <div class="leave-type-label">Casual Leave</div>
                            <input id="edit-type-casual" type="number" min="0" step="1" class="input-control center-input" required value="${Number(current.casualLeave || 0)}" />
                        </div>
                        <div class="leave-type-card">
                            <div class="leave-type-label">Sick Leave</div>
                            <input id="edit-type-sick" type="number" min="0" step="1" class="input-control center-input" required value="${Number(current.sickLeave || 0)}" />
                        </div>
                    </div>
                </div>
                
                <div class="form-field">
                    <label class="form-label">Total Quota</label>
                    <p id="edit-type-total" class="total-quota-display">${total}</p>
                </div>
            </div>
        </div>
    `;

    renderModal('Edit Allocation Type', formHTML, [
        {
            id: 'cancel-edit-type-btn',
            text: 'Cancel',
            className: 'btn-secondary',
            type: 'button',
        },
        {
            id: 'save-edit-type-btn',
            text: 'Save Changes',
            className: 'btn-primary',
            type: 'button',
        },
    ]);

    const casualInput = document.getElementById('edit-type-casual');
    const sickInput = document.getElementById('edit-type-sick');
    const totalEl = document.getElementById('edit-type-total');

    const updateTotal = () => {
        const cl = Math.max(0, Number(casualInput?.value || 0));
        const sl = Math.max(0, Number(sickInput?.value || 0));
        if (totalEl) {
            totalEl.textContent = String(cl + sl);
        }
    };

    if (casualInput && sickInput && totalEl) {
        casualInput.addEventListener('input', updateTotal);
        sickInput.addEventListener('input', updateTotal);
    }

    const saveButton = document.getElementById('save-edit-type-btn');
    const cancelButton = document.getElementById('cancel-edit-type-btn');

    if (saveButton) {
        saveButton.onclick = () => {
            saveEditedAllocationType();
        };
    }

    if (cancelButton) {
        cancelButton.onclick = () => {
            closeEditTypeModal();
        };
    }
};

const closeEditTypeModal = () => {
    closeModal();
};

// Handle add new allocation type
const handleAddAllocationType = () => {
    const formHTML = `
        <div class="modal-form modern-form team-modal">
            <div class="form-section">
                <div class="form-section-header">
                    <div>
                        <p class="form-eyebrow">LEAVE SETTINGS</p>
                        <h3>Add new allocation type</h3>
                    </div>
                </div>
                
                <div class="form-field">
                    <label class="form-label" for="new-type-name">Allocation Type Name *</label>
                    <input id="new-type-name" class="input-control" type="text" required placeholder="e.g., Type 4" />
                </div>
                
                <div class="form-field">
                    <label class="form-label" for="new-type-experience">Experience (Years) *</label>
                    <input id="new-type-experience" class="input-control" type="number" min="0" step="1" required placeholder="e.g., 5" />
                </div>
                
                <div class="form-field">
                    <label class="form-label">Leave Quotas</label>
                    <div class="form-grid two-col">
                        <div class="leave-type-card">
                            <div class="leave-type-label">Casual Leave *</div>
                            <input id="new-type-casual" type="number" min="0" step="1" class="input-control center-input" required placeholder="0" />
                        </div>
                        <div class="leave-type-card">
                            <div class="leave-type-label">Sick Leave *</div>
                            <input id="new-type-sick" type="number" min="0" step="1" class="input-control center-input" required placeholder="0" />
                        </div>
                    </div>
                </div>
                
                <div class="form-field">
                    <label class="form-label">Total Quota</label>
                    <p id="new-type-total" class="total-quota-display">0</p>
                </div>
            </div>
        </div>
    `;

    renderModal('Add Leave Type', formHTML, [
        {
            id: 'cancel-add-type-btn',
            text: 'Cancel',
            className: 'btn-secondary',
            type: 'button',
        },
        {
            id: 'save-add-type-btn',
            text: 'Add Leave Type',
            className: 'btn-primary',
            type: 'button',
        },
    ]);

    const casualInput = document.getElementById('new-type-casual');
    const sickInput = document.getElementById('new-type-sick');
    const totalEl = document.getElementById('new-type-total');

    const updateTotal = () => {
        const cl = Math.max(0, Number(casualInput?.value || 0));
        const sl = Math.max(0, Number(sickInput?.value || 0));
        if (totalEl) {
            totalEl.textContent = String(cl + sl);
        }
    };

    if (casualInput && sickInput && totalEl) {
        casualInput.addEventListener('input', updateTotal);
        sickInput.addEventListener('input', updateTotal);
    }

    const saveButton = document.getElementById('save-add-type-btn');
    const cancelButton = document.getElementById('cancel-add-type-btn');

    if (saveButton) {
        saveButton.onclick = () => {
            saveNewAllocationType();
        };
    }

    if (cancelButton) {
        cancelButton.onclick = () => {
            closeModal();
        };
    }
};

const saveNewAllocationType = async () => {
    const name = document.getElementById('new-type-name')?.value?.trim();
    const experience = Math.max(0, Number(document.getElementById('new-type-experience')?.value || 0));
    const casualLeave = Math.max(0, Number(document.getElementById('new-type-casual')?.value || 0));
    const sickLeave = Math.max(0, Number(document.getElementById('new-type-sick')?.value || 0));

    if (!name) {
        alert('Please enter an allocation type name');
        return;
    }

    // Check if type name already exists
    const exists = allocationTypes.some(t => t.type.toLowerCase() === name.toLowerCase());
    if (exists) {
        alert('An allocation type with this name already exists. Please use a different name.');
        return;
    }

    const totalQuota = casualLeave + sickLeave;

    const newType = {
        type: name,
        experience,
        casualLeave,
        sickLeave,
        totalQuota,
    };

    // Save to backend API
    try {
        const response = await fetch(`${API_BASE}/leave-allocation-types`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(newType)
        });
        
        if (response.ok) {
            const data = await response.json();
            if (data.success) {
                console.log('✅ New allocation type saved to backend:', newType);
                // Reload types from backend to ensure consistency
                await loadAllocationTypes();
                closeModal();
                alert(`✅ Leave type "${name}" added successfully!`);
                
                // Invalidate employee cache
                try { if (state?.cache?.employees) state.cache.employees = {}; } catch { }
                
                // Re-render page to show new type
                renderLeaveSettingsPage();
            } else {
                alert(`❌ Failed to save leave type: ${data.error || 'Unknown error'}`);
            }
        } else {
            const data = await response.json().catch(() => ({}));
            alert(`❌ Failed to save leave type: ${data.error || response.statusText}`);
        }
    } catch (err) {
        console.error('Failed to save to backend:', err);
        alert(`❌ Failed to save leave type: ${err.message}`);
    }
};

const saveEditedAllocationType = async () => {
    const idx = Number(document.getElementById('edit-type-index').value);
    if (Number.isNaN(idx) || idx < 0 || idx >= allocationTypes.length) return;

    const name = document.getElementById('edit-type-name').value.trim();
    const experience = Math.max(0, Number(document.getElementById('edit-type-experience').value || 0));
    const casualLeave = Math.max(0, Number(document.getElementById('edit-type-casual').value || 0));
    const sickLeave = Math.max(0, Number(document.getElementById('edit-type-sick').value || 0));
    const totalQuota = casualLeave + sickLeave;

    const typeName = allocationTypes[idx].type;
    const updatedType = {
        type: name || typeName,
        experience,
        casualLeave,
        sickLeave,
        totalQuota,
    };

    // Save to backend API
    try {
        const response = await fetch(`${API_BASE}/leave-allocation-types/${encodeURIComponent(typeName)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(updatedType)
        });
        
        if (response.ok) {
            console.log('✅ Allocation type updated in backend');
            // Reload types from backend to ensure consistency
            await loadAllocationTypes();
            closeEditTypeModal();
            // Invalidate employee cache so the employee table re-fetches fresh data
            try { if (state?.cache?.employees) state.cache.employees = {}; } catch { }
            // Re-render page so both tables use updated configuration
            renderLeaveSettingsPage();
        } else {
            const data = await response.json().catch(() => ({}));
            alert(`❌ Failed to update leave type: ${data.error || response.statusText}`);
        }
    } catch (err) {
        console.error('Failed to update in backend:', err);
        alert(`❌ Failed to update leave type: ${err.message}`);
    }
};

// Dynamically match CL/SL values to an allocation type from the live config
const matchAllocationType = (cl, sl) => {
    for (const t of allocationTypes) {
        if (Number(t.casualLeave) === Number(cl) && Number(t.sickLeave) === Number(sl)) {
            return t.type;
        }
    }
    return 'Custom';
};

// Handle edit allocation
const handleEditAllocation = async (employeeId, name, currentCL, currentSL, allocationType) => {
    console.log('✏️ Editing allocation for:', employeeId);

    // Determine current allocation type dynamically from live config
    const currentType = matchAllocationType(currentCL, currentSL);

    const total = currentCL + currentSL;

    // Build dropdown options dynamically from allocationTypes config
    const typeOptions = allocationTypes.map(t => {
        const isSelected = t.type === currentType ? 'selected' : '';
        return `<option value="${t.type}" ${isSelected}>${t.type} (${t.experience}+ years) - CL: ${t.casualLeave}, SL: ${t.sickLeave}</option>`;
    }).join('');
    // Add Custom option if current values don't match any type
    const customOption = currentType === 'Custom'
        ? `<option value="Custom" selected>Custom - CL: ${currentCL}, SL: ${currentSL}</option>`
        : '';

    const formHTML = `
        <div class="modal-form modern-form leave-form">
            <div class="form-section">
                <div class="form-section-header">
                    <div>
                        <p class="form-eyebrow">LEAVE SETTINGS</p>
                        <h3>Edit leave allocation</h3>
                    </div>
                </div>
                <input type="hidden" id="edit-employee-id" value="${employeeId}" />
                <div class="form-grid-2-col">
                    <div class="form-field">
                        <label class="form-label" for="edit-employee-name">Employee</label>
                        <input type="text" id="edit-employee-name" class="input-control" value="${name || ''}" readonly />
                    </div>
                    <div class="form-field">
                        <label class="form-label" for="edit-allocation-type">Allocation Type</label>
                        <select id="edit-allocation-type" class="input-control" required onchange="window.updateAllocationTypeValues()">
                            ${typeOptions}
                            ${customOption}
                        </select>
                    </div>
                    <div class="form-field">
                        <label class="form-label" for="edit-casual-leave-display">Casual Leave</label>
                        <input type="number" id="edit-casual-leave-display" class="input-control" value="${currentCL}" min="0" oninput="window.updateTotalQuota()" />
                    </div>
                    <div class="form-field">
                        <label class="form-label" for="edit-sick-leave-display">Sick Leave</label>
                        <input type="number" id="edit-sick-leave-display" class="input-control" value="${currentSL}" min="0" oninput="window.updateTotalQuota()" />
                    </div>
                    <div class="form-field">
                        <label class="form-label" for="edit-total-quota">Total Quota</label>
                        <input type="number" id="edit-total-quota" class="input-control" value="${total}" readonly />
                    </div>
                </div>
            </div>
        </div>
    `;

    renderModal('Edit Leave Allocation', formHTML, [
        {
            id: 'cancel-edit-allocation-btn',
            text: 'Cancel',
            className: 'btn-secondary',
            type: 'button',
        },
        {
            id: 'save-edit-allocation-btn',
            text: 'Save Changes',
            className: 'btn-primary',
            type: 'button',
        },
    ]);

    const saveButton = document.getElementById('save-edit-allocation-btn');
    const cancelButton = document.getElementById('cancel-edit-allocation-btn');

    if (saveButton) {
        saveButton.onclick = () => {
            saveEditedAllocation();
        };
    }

    if (cancelButton) {
        cancelButton.onclick = () => {
            closeEditModal();
        };
    }
};

// Update leave values when allocation type changes (reads from live allocationTypes config)
const updateAllocationTypeValues = () => {
    const typeSelect = document.getElementById('edit-allocation-type');
    const selectedType = typeSelect.value;

    // Look up values from the live allocationTypes config
    const matched = allocationTypes.find(t => t.type === selectedType);
    let cl, sl;
    if (matched) {
        cl = Number(matched.casualLeave);
        sl = Number(matched.sickLeave);
    } else {
        // Custom type — keep current input values
        cl = Number(document.getElementById('edit-casual-leave-display')?.value || 0);
        sl = Number(document.getElementById('edit-sick-leave-display')?.value || 0);
    }

    const casualInput2 = document.getElementById('edit-casual-leave-display');
    const sickInput2 = document.getElementById('edit-sick-leave-display');
    const totalInput2 = document.getElementById('edit-total-quota');
    if (casualInput2) casualInput2.value = cl;
    if (sickInput2) sickInput2.value = sl;
    if (totalInput2) totalInput2.value = cl + sl;
};

// Update total quota when CL or SL changes manually
const updateTotalQuota = () => {
    const casualInput = document.getElementById('edit-casual-leave-display');
    const sickInput = document.getElementById('edit-sick-leave-display');
    const totalInput = document.getElementById('edit-total-quota');
    
    if (casualInput && sickInput && totalInput) {
        const cl = Number(casualInput.value) || 0;
        const sl = Number(sickInput.value) || 0;
        totalInput.value = cl + sl;
    }
};

// Save edited allocation (reads actual values from the displayed input fields)
const saveEditedAllocation = async () => {
    const employeeId = document.getElementById('edit-employee-id').value;

    // Read CL and SL directly from the displayed input fields (now editable)
    const casualLeave = Number(document.getElementById('edit-casual-leave-display')?.value || 0);
    const sickLeave = Number(document.getElementById('edit-sick-leave-display')?.value || 0);

    console.log(`💾 Saving allocation for ${employeeId}: CL=${casualLeave}, SL=${sickLeave}`);

    try {
        const response = await fetch(`${API_BASE}/employee-leave-allocation/${employeeId}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                casualLeave,
                sickLeave
            })
        });

        const result = await response.json();
        console.log(`📥 API response for ${employeeId}:`, result);

        if (result.success) {
            // Close modal FIRST (before any alert or re-render)
            closeEditModal();

            // Store optimistic override so the table shows correct values
            // even if Dataverse GET still returns stale data
            const empKey = (employeeId || '').trim().toUpperCase();
            pendingAllocationOverrides[empKey] = {
                casual_leave: casualLeave,
                sick_leave: sickLeave,
                total: casualLeave + sickLeave,
                timestamp: Date.now()
            };
            console.log(`📌 Stored optimistic override for ${empKey}:`, pendingAllocationOverrides[empKey]);

            // Invalidate employee cache so the re-render fetches fresh data
            try { if (state?.cache?.employees) state.cache.employees = {}; } catch { }

            // Full page re-render (will use optimistic overrides for recently saved employees)
            console.log(`🔄 Re-rendering leave settings page after update for ${employeeId}...`);
            await renderLeaveSettingsPage();
            console.log(`✅ Re-render complete for ${employeeId}`);
        } else {
            alert(`❌ Error: ${result.error || 'Failed to update leave allocation'}`);
        }
    } catch (error) {
        console.error('Error updating leave allocation:', error);
        alert('❌ Error updating leave allocation. Please try again.');
    }
};

// Close edit modal
const closeEditModal = () => {
    closeModal();
};

// Render employee allocation table
const renderEmployeeAllocationTable = async () => {
    try {
        const allEmployees = await listEmployees(1, 5000);
        const employees = allEmployees.items || [];

        if (employees.length === 0) {
            return `
                <div class="card">
                    <h3><i class="fa-solid fa-users"></i> Employee Leave Allocations</h3>
                    <p class="placeholder-text">No employees found.</p>
                </div>
            `;
        }

        // Fetch stored leave allocations from database
        console.log('📊 Fetching stored leave allocations from database...');
        let storedAllocations = {};
        try {
            // Add aggressive cache busting to ensure fresh data
            const timestamp = Date.now();
            const random = Math.random().toString(36).substring(7);
            const cacheBuster = `?_t=${timestamp}&_r=${random}`;
            console.log('🔍 Cache buster:', cacheBuster);
            
            const allocResponse = await fetch(`${API_BASE}/employee-leave-allocations${cacheBuster}`, {
                cache: 'no-store',
                headers: {
                    'Accept': 'application/json',
                    'Cache-Control': 'no-cache',
                    'Pragma': 'no-cache'
                }
            });
            
            if (!allocResponse.ok) {
                throw new Error(`HTTP ${allocResponse.status}: ${allocResponse.statusText}`);
            }
            
            const allocData = await allocResponse.json();
            console.log('📥 Raw API response:', allocData);
            
            if (allocData.success && allocData.allocations) {
                storedAllocations = allocData.allocations;
                console.log('✅ Fetched stored allocations for', Object.keys(storedAllocations).length, 'employees');
                console.log('🔍 Stored allocation keys:', Object.keys(storedAllocations));
                console.log('🔍 Sample stored allocation:', Object.values(storedAllocations)[0]);
            } else {
                console.warn('⚠️ API returned success=false or no allocations:', allocData);
            }
        } catch (err) {
            console.error('❌ Failed to fetch stored allocations:', err);
            console.warn('⚠️ Will use calculated values as fallback');
        }

        // Process employees - use stored values if available, otherwise calculate
        console.log('📊 Processing employees for leave allocation:', employees.length);
        console.log('🔍 First 3 employee IDs:', employees.slice(0, 3).map(e => e.employee_id));
        console.log('🔍 Stored allocations available:', Object.keys(storedAllocations).length);

        const employeeAllocations = employees.map(emp => {
            const empId = emp.employee_id;
            const dateOfJoining = emp.doj || emp.date_of_joining;
            const experience = calculateExperience(dateOfJoining);
            
            // Check if we have stored allocation for this employee
            // Try both exact match and normalized versions
            let stored = storedAllocations[empId] || 
                        storedAllocations[empId?.toUpperCase()] || 
                        storedAllocations[empId?.trim()];
            
            // Apply optimistic overrides for recently saved employees
            // These take priority over stale Dataverse data
            const overrideKey = (empId || '').trim().toUpperCase();
            const override = pendingAllocationOverrides[overrideKey];
            if (override) {
                console.log(`📌 Applying optimistic override for ${empId}: CL=${override.casual_leave}, SL=${override.sick_leave}`);
                stored = {
                    ...(stored || {}),
                    casual_leave: override.casual_leave,
                    sick_leave: override.sick_leave,
                    total: override.total
                };
                // Clear override after 30 seconds (Dataverse should have propagated by then)
                if (Date.now() - override.timestamp > 30000) {
                    delete pendingAllocationOverrides[overrideKey];
                }
            }
            
            let casualLeave, sickLeave, totalQuota, allocationType;
            
            if (stored) {
                // Use stored values from database (or optimistic override)
                casualLeave = stored.casual_leave;
                sickLeave = stored.sick_leave;
                totalQuota = stored.total || (casualLeave + sickLeave);
                
                // Determine type dynamically from live allocationTypes config
                allocationType = matchAllocationType(casualLeave, sickLeave);
                
                console.log(`✓ ${empId}: Using stored allocation (${allocationType})`);
            } else {
                // Calculate based on experience (fallback)
                const allocation = getAllocationType(experience);
                casualLeave = allocation.casualLeave;
                sickLeave = allocation.sickLeave;
                totalQuota = allocation.totalQuota;
                allocationType = allocation.type;
                
                console.log(`⚠ ${empId}: No stored allocation, using calculated (${allocationType})`);
            }

            return {
                employeeId: empId,
                name: `${emp.first_name || ''} ${emp.last_name || ''}`.trim(),
                dateOfJoining: dateOfJoining,
                experience,
                allocationType,
                casualLeave,
                sickLeave,
                totalQuota
            };
        });

        // Sort by employee ID
        employeeAllocations.sort((a, b) => (a.employeeId || '').localeCompare(b.employeeId || ''));

        return `
            <div class="card">
                <h3><i class="fa-solid fa-users"></i> Employee Leave Allocations</h3>
                <p class="allocation-description">Current leave allocations for all employees based on their experience.</p>
                <div class="table-container">
                    <table class="table">
                        <thead>
                            <tr>
                                <th>Employee ID</th>
                                <th>Employee Name</th>
                                <th>Date of Joining</th>
                                <th>Experience</th>
                                <th>Allocation Type</th>
                                <th>Casual Leave</th>
                                <th>Sick Leave</th>
                                <th>Total Quota</th>
                                <th>Actions</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${employeeAllocations.map(emp => `
                                <tr>
                                    <td><strong>${emp.employeeId}</strong></td>
                                    <td>${emp.name}</td>
                                    <td>${formatDate(emp.dateOfJoining)}</td>
                                    <td>${emp.experience} year${emp.experience !== 1 ? 's' : ''}</td>
                                    <td><span class="status-badge ${emp.allocationType.toLowerCase().replace(' ', '-')}">${emp.allocationType}</span></td>
                                    <td>${emp.casualLeave}</td>
                                    <td>${emp.sickLeave}</td>
                                    <td><strong>${emp.totalQuota}</strong></td>
                                    <td>
                                        <button class="btn-icon" onclick="window.handleEditAllocation('${emp.employeeId}', '${emp.name}', ${emp.casualLeave}, ${emp.sickLeave}, '${emp.allocationType}')" title="Edit Allocation">
                                            <i class="fa-solid fa-pen-to-square"></i>
                                        </button>
                                    </td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                </div>
                <div class="allocation-note">
                    <strong>Note:</strong> Leave allocations are automatically calculated based on employee experience.
                    Experience is calculated from the date of joining to the current date. You can manually override allocations using the Edit button.
                </div>
            </div>
        `;

    } catch (error) {
        console.error('❌ Error loading employee allocations:', error);
        return `
            <div class="card">
                <h3><i class="fa-solid fa-users"></i> Employee Leave Allocations</h3>
                <p class="placeholder-text error-message">Error loading employee data.</p>
            </div>
        `;
    }
};

// Render Leave Settings page (Admin Only)
export const renderLeaveSettingsPage = async () => {
    console.log('⚙️ Rendering Leave Settings Page...');

    // Load latest allocation types from backend
    await loadAllocationTypes();

    // Check if user has permission
    if (!canUseFunction('manage_leave_settings') && !canViewApplication('leave_settings')) {
        const content = `
            <div class="card">
                <div class="access-denied-content">
                    <i class="fa-solid fa-lock fa-3x error-icon"></i>
                    <h3 class="error-heading">Access Denied</h3>
                    <p>You don't have permission to manage these settings. Please ask your administrator to grant you access.</p>
                    
                </div>
            </div>
        `;
        document.getElementById('app-content').innerHTML = getPageContentHTML('Settings', renderSettingsLayout('leave-settings', content));
        return;
    }

    // Show loading state
    const loadingContent = `
        ${renderAllocationTypesTable()}
        <div class="card">
            <h3><i class="fa-solid fa-users"></i> Employee Leave Allocations</h3>
            <p class="placeholder-text">⏳ Loading employee allocations...</p>
        </div>
        ${renderEditAllocationTypeModal()}
    `;

    document.getElementById('app-content').innerHTML = getPageContentHTML('Settings', renderSettingsLayout('leave-settings', loadingContent));

    // Load employee allocation table
    try {
        const employeeTable = await renderEmployeeAllocationTable();
        const finalContent = `
            ${renderAllocationTypesTable()}
            ${employeeTable}
            ${renderEditAllocationTypeModal()}
        `;

        document.getElementById('app-content').innerHTML = getPageContentHTML('Settings', renderSettingsLayout('leave-settings', finalContent));
        console.log('✅ Leave Settings page loaded successfully');

    } catch (error) {
        console.error('❌ Error loading leave settings:', error);
        const errorContent = `
            ${renderAllocationTypesTable()}
            <div class="card">
                <h3><i class="fa-solid fa-users"></i> Employee Leave Allocations</h3>
                <p class="placeholder-text error-message">Error loading employee data.</p>
            </div>
            ${renderEditAllocationTypeModal()}
        `;
        document.getElementById('app-content').innerHTML = getPageContentHTML('Settings', renderSettingsLayout('leave-settings', errorContent));
    }
};

// Export functions to window for onclick handlers
if (typeof window !== 'undefined') {
    window.handleEditAllocation = handleEditAllocation;
    window.closeEditModal = closeEditModal;
    window.saveEditedAllocation = saveEditedAllocation;
    window.updateAllocationTypeValues = updateAllocationTypeValues;
    window.updateTotalQuota = updateTotalQuota;
    window.handleEditAllocationType = handleEditAllocationType;
    window.closeEditTypeModal = closeEditTypeModal;
    window.saveEditedAllocationType = saveEditedAllocationType;
    window.handleAddAllocationType = handleAddAllocationType;
    window.saveNewAllocationType = saveNewAllocationType;
}

// Export dummy function for compatibility
export const handleEditLeave = async (e) => {
    console.log('Edit leave function called - not implemented in new leave settings');
};
