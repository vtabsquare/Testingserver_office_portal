// roleSettingsApi.js - API calls for Role Settings

import { API_BASE_URL } from '../config.js';

/**
 * Fetch all role permissions from the backend
 * @returns {Promise<Array>} List of permission objects
 */
export async function fetchAllRolePermissions() {
    try {
        const base = API_BASE_URL.replace(/\/$/, '');
        const res = await fetch(`${base}/api/role-permissions`, {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' }
        });
        
        if (!res.ok) {
            throw new Error(`Failed to fetch: ${res.status}`);
        }
        
        const data = await res.json();
        return data.permissions || [];
    } catch (error) {
        console.error('[ROLE-SETTINGS] Error fetching permissions:', error);
        return [];
    }
}

/**
 * Update a specific role permission
 * @param {string} roleKey - 'L1', 'L2', 'L3', 'L4'
 * @param {string} permissionType - 'application' or 'function'
 * @param {string} permissionKey - e.g., 'home', 'manage_leave_settings'
 * @param {boolean} enabled - true or false
 * @returns {Promise<boolean>} Success status
 */
export async function updateRolePermission(roleKey, permissionType, permissionKey, enabled) {
    try {
        const base = API_BASE_URL.replace(/\/$/, '');
        const res = await fetch(`${base}/api/role-permissions`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                role_key: roleKey,
                permission_type: permissionType,
                permission_key: permissionKey,
                enabled: enabled
            })
        });
        
        if (!res.ok) {
            throw new Error(`Failed to update: ${res.status}`);
        }
        
        const data = await res.json();
        return data.success;
    } catch (error) {
        console.error('[ROLE-SETTINGS] Error updating permission:', error);
        return false;
    }
}

/**
 * Seed default permissions (should only be needed once or when resetting)
 * @returns {Promise<boolean>} Success status
 */
export async function seedDefaultPermissions() {
    try {
        const base = API_BASE_URL.replace(/\/$/, '');
        const res = await fetch(`${base}/api/role-permissions/seed`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });
        
        if (!res.ok) {
            throw new Error(`Failed to seed: ${res.status}`);
        }
        
        const data = await res.json();
        return data.success;
    } catch (error) {
        console.error('[ROLE-SETTINGS] Error seeding permissions:', error);
        return false;
    }
}

export async function fetchCustomRoles() {
    try {
        const base = API_BASE_URL.replace(/\/$/, '');
        const res = await fetch(`${base}/api/custom-roles`, {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' }
        });
        if (!res.ok) throw new Error(`Failed to fetch custom roles: ${res.status}`);
        const data = await res.json();
        return data.roles || [];
    } catch (error) {
        console.error('[ROLE-SETTINGS] Error fetching custom roles:', error);
        return [];
    }
}

export async function createCustomRole(roleName) {
    try {
        const base = API_BASE_URL.replace(/\/$/, '');
        const res = await fetch(`${base}/api/custom-roles`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ role_name: roleName })
        });
        if (!res.ok) throw new Error(`Failed to create custom role: ${res.status}`);
        const data = await res.json();
        return data.role;
    } catch (error) {
        console.error('[ROLE-SETTINGS] Error creating custom role:', error);
        return null;
    }
}

export async function deleteCustomRole(roleKey) {
    try {
        const base = API_BASE_URL.replace(/\/$/, '');
        const res = await fetch(`${base}/api/custom-roles/${roleKey}`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' }
        });
        if (!res.ok) throw new Error(`Failed to delete custom role: ${res.status}`);
        const data = await res.json();
        return data.success;
    } catch (error) {
        console.error('[ROLE-SETTINGS] Error deleting custom role:', error);
        return false;
    }
}
