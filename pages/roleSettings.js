// roleSettings.js - Role Settings page for admin to manage permissions

import { getPageContentHTML } from '../utils.js';
import { isAdminUser } from '../utils/accessControl.js';
import { canUseFunction, getRolePermissions } from '../utils/roleSettings.js';
import { fetchAllRolePermissions, updateRolePermission, seedDefaultPermissions, fetchCustomRoles, createCustomRole, deleteCustomRole } from '../features/roleSettingsApi.js';
import { renderSettingsLayout } from '../components/settingsLayout.js';

let cachedPermissions = {};
let activeRole = 'L1';
let isUpdating = false;
let isEditMode = false;

const DEFAULT_ROLES = [
    { key: 'L1', name: 'User' },
    { key: 'L2', name: 'Manager' },
    { key: 'L4', name: 'Team Lead' },
    { key: 'L3', name: 'Admin' }
];

let activeRoles = [...DEFAULT_ROLES];

const APPLICATIONS_GROUPS = [
    {
        category: 'Core Applications',
        icon: 'fa-solid fa-cube',
        items: [
            { key: 'home', name: 'Home', icon: 'fa-house', desc: 'Main landing page' },
            { key: 'admin_dashboard', name: 'Admin Dashboard', icon: 'fa-chart-line', desc: 'Overview of system metrics' },
            { key: 'inbox', name: 'Inbox', icon: 'fa-inbox', desc: 'Centralized messages and approvals' },
            { key: 'onboarding', name: 'Onboarding', icon: 'fa-user-plus', desc: 'New employee onboarding process' }
        ]
    },
    {
        category: 'Employee Directory',
        icon: 'fa-solid fa-users',
        items: [
            { key: 'employee', name: 'Employee (Group)', icon: 'fa-users', desc: 'Parent menu for directory' },
            { key: 'employees', name: 'Employees List', icon: 'fa-address-card', desc: 'Full employee directory' },
            { key: 'interns', name: 'Interns List', icon: 'fa-user-graduate', desc: 'Directory of interns' },
            { key: 'team_management', name: 'Team Management', icon: 'fa-sitemap', desc: 'View and manage team structure' }
        ]
    },
    {
        category: 'Time & Projects',
        icon: 'fa-solid fa-clock',
        items: [
            { key: 'time_tracker', name: 'Time Tracker (Group)', icon: 'fa-clock', desc: 'Parent menu for time' },
            { key: 'time_my_tasks', name: 'My Tasks', icon: 'fa-list-check', desc: 'Personal task management' },
            { key: 'time_my_timesheet', name: 'My Timesheet', icon: 'fa-calendar-days', desc: 'Log personal hours' },
            { key: 'time_team_timesheet', name: 'Team Timesheet', icon: 'fa-people-group', desc: 'Review team hours' },
            { key: 'time_clients', name: 'Clients', icon: 'fa-handshake', desc: 'Manage client details' },
            { key: 'time_projects', name: 'Projects', icon: 'fa-folder-open', desc: 'Manage project details' }
        ]
    },
    {
        category: 'Attendance & Leaves',
        icon: 'fa-solid fa-calendar-check',
        items: [
            { key: 'attendance_tracker', name: 'Attendance Tracker (Group)', icon: 'fa-calendar-check', desc: 'Parent menu for attendance' },
            { key: 'attendance_my', name: 'My Attendance', icon: 'fa-user-clock', desc: 'Personal attendance logs' },
            { key: 'attendance_team', name: 'Team Attendance', icon: 'fa-users-viewfinder', desc: 'Review team attendance' },
            { key: 'attendance_holidays', name: 'Holidays', icon: 'fa-umbrella-beach', desc: 'Company holiday calendar' },
            { key: 'leave_tracker', name: 'Leave Tracker (Group)', icon: 'fa-plane-departure', desc: 'Parent menu for leaves' },
            { key: 'leave_my', name: 'My Leaves', icon: 'fa-calendar-minus', desc: 'Personal leave management' },
            { key: 'leave_team', name: 'Team Leaves', icon: 'fa-users-slash', desc: 'Review team leaves' },
            { key: 'compoff', name: 'Comp Off', icon: 'fa-arrow-right-arrow-left', desc: 'Manage compensatory time off' }
        ]
    },
    {
        category: 'System & Settings',
        icon: 'fa-solid fa-gear',
        items: [
            { key: 'assets', name: 'Assets', icon: 'fa-laptop', desc: 'Company asset management' },
            { key: 'settings', name: 'Settings (Group)', icon: 'fa-gear', desc: 'Parent menu for settings' },
            { key: 'leave_settings', name: 'Leave Settings', icon: 'fa-sliders', desc: 'Configure leave types and rules' },
            { key: 'shift_settings', name: 'Shift Settings', icon: 'fa-business-time', desc: 'Configure shift timings and weekly offs' },
            { key: 'login_settings', name: 'Login Settings', icon: 'fa-shield-halved', desc: 'Security and session controls' },
            { key: 'faceauth_settings', name: 'FaceAuth Settings', icon: 'fa-face-viewfinder', desc: 'Facial recognition settings' },
            { key: 'role_settings', name: 'Role Settings', icon: 'fa-user-shield', desc: 'Access and permission controls' },
            { key: 'faceauth_admin', name: 'FaceAuth Admin', icon: 'fa-camera', desc: 'Face authentication dashboard' }
        ]
    }
];

const FUNCTIONS_GROUPS = [
    {
        category: 'Dashboard & General',
        icon: 'fa-solid fa-chart-pie',
        items: [
            { key: 'view_admin_dashboard', name: 'View Admin Dashboard', icon: 'fa-chart-line', desc: 'Access system metrics dashboard' },
            { key: 'manage_onboarding', name: 'Manage Onboarding', icon: 'fa-user-plus', desc: 'Process new employee setups' },
            { key: 'manage_clients', name: 'Manage Clients', icon: 'fa-handshake', desc: 'Add or edit client details' }
        ]
    },
    {
        category: 'Directory Access',
        icon: 'fa-solid fa-address-book',
        items: [
            { key: 'view_employee_directory', name: 'View Employee Directory', icon: 'fa-address-card', desc: 'Access full employee profiles' },
            { key: 'view_interns', name: 'View Interns', icon: 'fa-user-graduate', desc: 'Access intern profiles' },
            { key: 'manage_team_hierarchy', name: 'Manage Team Hierarchy', icon: 'fa-sitemap', desc: 'Edit team structure and managers' }
        ]
    },
    {
        category: 'Team Management',
        icon: 'fa-solid fa-users-gear',
        items: [
            { key: 'view_team_timesheet', name: 'View Team Timesheet', icon: 'fa-business-time', desc: 'Review team logged hours' },
            { key: 'view_team_attendance', name: 'View Team Attendance', icon: 'fa-users-viewfinder', desc: 'Review team attendance records' },
            { key: 'view_team_leaves', name: 'View Team Leaves', icon: 'fa-users-slash', desc: 'Review team leave requests' }
        ]
    },
    {
        category: 'System Administration',
        icon: 'fa-solid fa-sliders',
        items: [
            { key: 'manage_leave_settings', name: 'Manage Leave Settings', icon: 'fa-gear', desc: 'Modify leave rules and allocations' },
            { key: 'manage_shift_settings', name: 'Manage Shift Settings', icon: 'fa-business-time', desc: 'Modify shift timings and weekly offs' },
            { key: 'manage_login_settings', name: 'Manage Login Settings', icon: 'fa-shield-halved', desc: 'Modify security policies' },
            { key: 'manage_faceauth_settings', name: 'Manage FaceAuth Settings', icon: 'fa-face-viewfinder', desc: 'Configure facial recognition' },
            { key: 'manage_role_settings', name: 'Manage Role Settings', icon: 'fa-user-shield', desc: 'Modify role-based access control' }
        ]
    }
];

function transformApiDataToCache(apiData) {
    const cache = {};
    activeRoles.forEach(r => {
        cache[r.key] = { applications: [], functions: [] };
    });
    
    if (apiData && apiData.length > 0) {
        apiData.forEach(row => {
            if (!cache[row.role_key]) {
                cache[row.role_key] = { applications: [], functions: [] };
            }
            if (row.enabled) {
                if (row.permission_type === 'application') {
                    cache[row.role_key].applications.push(row.permission_key);
                } else if (row.permission_type === 'function') {
                    cache[row.role_key].functions.push(row.permission_key);
                }
            }
        });
        return cache;
    }
    
    // Fallback to default permissions if API returns empty
    const defaultPerms = JSON.parse(JSON.stringify(getRolePermissions()));
    return { ...cache, ...defaultPerms };
}

async function handleToggle(e) {
    const toggle = e.target.closest('.role-toggle-switch');
    if (!toggle || isUpdating) return;
    
    // Don't allow changing Admin permissions
    if (activeRole === 'L3') {
        showToast('Admin permissions cannot be modified.', 'info');
        return;
    }
    
    const permType = toggle.dataset.type;
    const permKey = toggle.dataset.key;
    const isEnabled = toggle.classList.contains('active');
    const newState = !isEnabled;
    
    isUpdating = true;
    toggle.style.opacity = '0.5';
    
    const success = await updateRolePermission(activeRole, permType, permKey, newState);
    
    if (success) {
        // Update UI
        if (newState) {
            toggle.classList.add('active');
        } else {
            toggle.classList.remove('active');
        }
        
        // Update local cache
        const cacheList = cachedPermissions[activeRole][permType + 's'];
        if (newState && !cacheList.includes(permKey)) {
            cacheList.push(permKey);
        } else if (!newState && cacheList.includes(permKey)) {
            const idx = cacheList.indexOf(permKey);
            cacheList.splice(idx, 1);
        }
        
        showToast(`Permission updated successfully.`, 'success');
    } else {
        showToast('Failed to update permission.', 'error');
    }
    
    toggle.style.opacity = '1';
    isUpdating = false;
}

function renderTabs() {
    return `
        <div class="role-tabs-container" style="display: flex; gap: 8px; margin-bottom: 24px; border-bottom: 1px solid var(--border-color); padding-bottom: 1px;">
            ${activeRoles.map(r => `
                <button class="role-tab ${r.key === activeRole ? 'active' : ''}" data-role="${r.key}">
                    ${r.name}
                </button>
            `).join('')}
            <button class="role-tab" id="add-custom-role-btn" style="padding: 8px 16px; border: 1px dashed var(--primary-color); background: transparent; color: var(--primary-color); font-weight: bold;">
                <i class="fa-solid fa-plus"></i> New Role
            </button>
        </div>
    `;
}

function renderGroups(title, type, groups, permissions) {
    const isAdmin = activeRole === 'L3';
    
    // Filter groups and items if not in edit mode
    let displayGroups = groups;
    if (!isEditMode && !isAdmin) {
        displayGroups = groups.map(group => {
            return {
                ...group,
                items: group.items.filter(item => permissions.includes(item.key))
            };
        }).filter(group => group.items.length > 0);
    }
    
    return `
        <div class="role-section-wrapper">
            <h3 class="role-main-title">${title}</h3>
            ${displayGroups.length === 0 ? '<p class="placeholder-text" style="margin-bottom: 24px;">No access granted in this category.</p>' : ''}
            ${displayGroups.map(group => `
                <div class="role-section">
                    <h4 class="role-category-title"><i class="${group.icon}"></i> ${group.category}</h4>
                    <div class="role-items-grid">
                        ${group.items.map(item => {
                            const isEnabled = permissions.includes(item.key);
                            return `
                                <div class="role-item-card">
                                    <div class="role-item-header">
                                        <div class="role-item-icon-wrapper">
                                            <i class="fa-solid ${item.icon}"></i>
                                        </div>
                                        <div class="role-item-info">
                                            <span class="role-item-name">${item.name}</span>
                                            <span class="role-item-desc">${item.desc}</span>
                                        </div>
                                        ${isEditMode || isAdmin ? `
                                        <div class="role-toggle-switch ${isEnabled ? 'active' : ''} ${isAdmin ? 'disabled' : ''}" 
                                             data-type="${type}" 
                                             data-key="${item.key}"
                                             title="${isAdmin ? 'Admin permissions cannot be modified' : 'Toggle access'}">
                                            <div class="role-toggle-slider"></div>
                                        </div>
                                        ` : `
                                        <div class="status-badge compact present" style="margin-top: 4px; border-radius: 12px; padding: 2px 8px;"><i class="fa-solid fa-check" style="font-size: 10px;"></i> Enabled</div>
                                        `}
                                    </div>
                                    <div class="role-item-footer">
                                        <span class="role-item-key" title="System Key">${item.key}</span>
                                    </div>
                                </div>
                            `;
                        }).join('')}
                    </div>
                </div>
            `).join('')}
        </div>
    `;
}

function renderContent() {
    const rolePerms = cachedPermissions[activeRole] || { applications: [], functions: [] };
    
    return `
        ${activeRole === 'L3' ? `
            <div class="role-alert info">
                <i class="fa-solid fa-circle-info"></i>
                <span>Admin permissions are locked and have full access to all applications and functions.</span>
            </div>
        ` : ''}
        ${renderGroups('Sidebar Applications', 'application', APPLICATIONS_GROUPS, rolePerms.applications)}
        <hr class="role-divider" />
        ${renderGroups('Functions', 'function', FUNCTIONS_GROUPS, rolePerms.functions)}
    `;
}

function showToast(message, type = 'info') {
    const existing = document.getElementById('role-toast');
    if (existing) existing.remove();
    
    const toast = document.createElement('div');
    toast.id = 'role-toast';
    const bgColor = type === 'success' ? '#10b981' : type === 'error' ? '#ef4444' : '#3b82f6';
    
    toast.style.cssText = `
        position: fixed;
        bottom: 24px;
        right: 24px;
        background: ${bgColor};
        color: white;
        padding: 12px 20px;
        border-radius: 8px;
        box-shadow: 0 4px 12px rgba(0,0,0,0.15);
        z-index: 9999;
        font-size: 14px;
        animation: slideIn 0.3s ease;
    `;
    toast.textContent = message;
    
    document.body.appendChild(toast);
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(10px)';
        toast.style.transition = 'all 0.3s ease';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

export async function renderRoleSettingsPage() {
    const container = document.getElementById('app-content');
    if (!container) return;
    
    if (!canUseFunction('manage_role_settings')) {
        container.innerHTML = getPageContentHTML('Settings', renderSettingsLayout('role-settings', `
            <div class="card" style="padding: 40px; text-align: center;">
                <i class="fa-solid fa-lock" style="font-size: 48px; color: #e74c3c; margin-bottom: 16px;"></i>
                <h2>Access Denied</h2>
                <p>Only administrators can access Role Settings.</p>
            </div>
        `));
        return;
    }
    
    // Show loading state
    container.innerHTML = getPageContentHTML('Settings', renderSettingsLayout('role-settings', `
        <div class="card">
            <h3><i class="fa-solid fa-user-shield"></i> Role Settings</h3>
            <p class="allocation-description">Manage access to applications and functions across different roles.</p>
            <div style="text-align: center; padding: 40px;">
                <i class="fa-solid fa-spinner fa-spin" style="font-size: 24px; color: var(--primary-color);"></i>
                <p style="margin-top: 12px; color: var(--text-secondary);">Loading permissions...</p>
            </div>
        </div>
    `));
    
    // Fetch data
    const [apiData, customRoles] = await Promise.all([
        fetchAllRolePermissions(),
        fetchCustomRoles()
    ]);
    
    activeRoles = [...DEFAULT_ROLES, ...customRoles];
    cachedPermissions = transformApiDataToCache(apiData);
    
    const renderFullPage = () => {
        const isAdmin = activeRole === 'L3';
        container.innerHTML = getPageContentHTML('Settings', renderSettingsLayout('role-settings', `
            <div class="card role-settings-card">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px;">
                    <div>
                        <h3 style="margin: 0;"><i class="fa-solid fa-user-shield"></i> Role Settings</h3>
                        <p class="allocation-description" style="margin: 4px 0 0 0;">Manage access to applications and functions across different roles. Changes take effect on the next page reload.</p>
                    </div>
                
                <div class="role-controls" style="display: flex; gap: 10px;">
                    ${isAdmin ? '' : `
                        <button class="btn btn-outline" id="edit-role-btn">
                            <i class="fa-solid ${isEditMode ? 'fa-check' : 'fa-pen-to-square'}"></i> ${isEditMode ? 'Done Editing' : 'Edit Access'}
                        </button>
                    `}
                    ${isAdmin ? `
                        <button class="btn btn-outline" id="seed-permissions-btn" title="Restore default settings">
                            <i class="fa-solid fa-seedling"></i> Restore Defaults
                        </button>
                    ` : ''}
                    ${activeRole.startsWith('C_') ? `
                        <button class="btn btn-outline" id="delete-custom-role-btn" style="color: #dc2626; border-color: #fca5a5;">
                            <i class="fa-solid fa-trash"></i> Delete Role
                        </button>
                    ` : ''}
                </div>
            </div>    
                ${renderTabs()}
                <div id="role-content-container" class="role-content-area">
                    ${renderContent()}
                </div>
            </div>
        `));
        
        // Tab clicks
        document.querySelectorAll('.role-tab:not(#add-custom-role-btn)').forEach(tab => {
            tab.addEventListener('click', (e) => {
                document.querySelectorAll('.role-tab').forEach(t => t.classList.remove('active'));
                e.target.classList.add('active');
                activeRole = e.target.dataset.role;
                isEditMode = false; // Reset edit mode on tab switch
                renderFullPage(); // Re-render whole page to update edit button state
            });
        });

        // Add custom role click
        const addCustomRoleBtn = document.getElementById('add-custom-role-btn');
        if (addCustomRoleBtn) {
            addCustomRoleBtn.addEventListener('click', () => {
                const roleName = prompt("Enter the name for the new custom role:");
                if (roleName && roleName.trim()) {
                    addCustomRoleBtn.disabled = true;
                    addCustomRoleBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
                    
                    createCustomRole(roleName.trim()).then(async (newRole) => {
                        if (newRole) {
                            showToast(`Role ${roleName} created successfully!`, 'success');
                            // Refresh data
                            const [apiData, customRoles] = await Promise.all([
                                fetchAllRolePermissions(),
                                fetchCustomRoles()
                            ]);
                            activeRoles = [...DEFAULT_ROLES, ...customRoles];
                            cachedPermissions = transformApiDataToCache(apiData);
                            activeRole = newRole.key; // switch to it
                            isEditMode = true; // default to edit mode for new role
                            renderFullPage();
                        } else {
                            showToast('Failed to create custom role.', 'error');
                            addCustomRoleBtn.disabled = false;
                            addCustomRoleBtn.innerHTML = '<i class="fa-solid fa-plus"></i> New Role';
                        }
                    });
                }
            });
        }
        
        // Edit clicks
        const editBtn = document.getElementById('edit-role-btn');
        if (editBtn) {
            editBtn.addEventListener('click', () => {
                isEditMode = !isEditMode;
                renderFullPage();
            });
        }
        
        // Seed clicks
        const seedBtn = document.getElementById('seed-permissions-btn');
        if (seedBtn) {
            seedBtn.addEventListener('click', async () => {
                if (!confirm('Are you sure you want to restore default permissions? This will override any custom changes.')) return;
                
                seedBtn.disabled = true;
                seedBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Restoring...';
                
                const success = await seedDefaultPermissions();
                if (success) {
                    showToast('Default permissions restored successfully.', 'success');
                    const newData = await fetchAllRolePermissions();
                    cachedPermissions = transformApiDataToCache(newData);
                    renderFullPage();
                } else {
                    showToast('Failed to restore default permissions.', 'error');
                }
                
                seedBtn.disabled = false;
                seedBtn.innerHTML = '<i class="fa-solid fa-seedling"></i> Restore Defaults';
            });
        }
        
        // Delete custom role clicks
        const deleteBtn = document.getElementById('delete-custom-role-btn');
        if (deleteBtn) {
            deleteBtn.addEventListener('click', async () => {
                const roleToDelete = activeRoles.find(r => r.key === activeRole);
                if (!roleToDelete) return;
                
                if (!confirm(`Are you sure you want to delete the custom role '${roleToDelete.name}'? This cannot be undone, and users with this role might lose access until reassigned.`)) return;
                
                deleteBtn.disabled = true;
                deleteBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Deleting...';
                
                const success = await deleteCustomRole(activeRole);
                if (success) {
                    showToast(`Role ${roleToDelete.name} deleted successfully!`, 'success');
                    
                    // Refresh data
                    const [apiData, customRoles] = await Promise.all([
                        fetchAllRolePermissions(),
                        fetchCustomRoles()
                    ]);
                    activeRoles = [...DEFAULT_ROLES, ...customRoles];
                    cachedPermissions = transformApiDataToCache(apiData);
                    activeRole = 'L1'; // switch back to User tab
                    isEditMode = false;
                    renderFullPage();
                } else {
                    showToast('Failed to delete custom role.', 'error');
                    deleteBtn.disabled = false;
                    deleteBtn.innerHTML = '<i class="fa-solid fa-trash"></i> Delete Role';
                }
            });
        }
    };
    
    renderFullPage();
    
    // Use delegation for toggle clicks since DOM updates on tab switch
    document.addEventListener('click', async (e) => {
        // Find if click was on or within a toggle
        let target = e.target;
        if (target.classList.contains('role-toggle-slider')) {
            target = target.parentElement;
        }
        
        if (target.classList && target.classList.contains('role-toggle-switch')) {
            await handleToggle({ target });
        }
    });
}
