// utils/roleSettings.js
import { getUserAccessContext } from './accessControl.js';
import { fetchAllRolePermissions } from '../features/roleSettingsApi.js';

let permissionsCache = null;
let isLoading = false;
let loadPromise = null;

// Default permissions applied before backend responds or if it fails
const DEFAULT_PERMISSIONS = {
    // Admin (L3) gets everything by default
    'L3': {
        applications: ['home', 'admin_dashboard', 'employee', 'employees', 'interns', 'team_management', 'inbox', 'onboarding', 'time_tracker', 'time_my_tasks', 'time_my_timesheet', 'time_team_timesheet', 'time_clients', 'time_projects', 'attendance_tracker', 'attendance_my', 'attendance_team', 'attendance_holidays', 'leave_tracker', 'leave_my', 'leave_team', 'compoff', 'assets', 'settings', 'leave_settings', 'login_settings', 'faceauth_settings', 'role_settings', 'faceauth_admin'],
        functions: ['view_admin_dashboard', 'view_employee_directory', 'view_interns', 'manage_onboarding', 'view_team_timesheet', 'manage_clients', 'view_team_attendance', 'view_team_leaves', 'manage_leave_settings', 'manage_login_settings', 'manage_faceauth_settings', 'manage_role_settings']
    },
    // Manager (L2) gets team-oriented things
    'L2': {
        applications: ['home', 'employee', 'employees', 'interns', 'inbox', 'time_tracker', 'time_my_tasks', 'time_my_timesheet', 'time_team_timesheet', 'time_clients', 'time_projects', 'attendance_tracker', 'attendance_my', 'attendance_team', 'attendance_holidays', 'leave_tracker', 'leave_my', 'leave_team', 'compoff', 'assets'],
        functions: ['view_employee_directory', 'view_interns', 'view_team_timesheet', 'manage_clients', 'view_team_attendance', 'view_team_leaves']
    },
    // Team Lead (L4) gets slightly less than manager
    'L4': {
        applications: ['home', 'employee', 'employees', 'time_tracker', 'time_my_tasks', 'time_my_timesheet', 'time_team_timesheet', 'time_projects', 'attendance_tracker', 'attendance_my', 'attendance_team', 'attendance_holidays', 'leave_tracker', 'leave_my', 'leave_team', 'compoff', 'assets'],
        functions: ['view_employee_directory', 'view_team_timesheet', 'view_team_attendance', 'view_team_leaves']
    },
    // User (L1) gets basic access
    'L1': {
        applications: ['home', 'time_tracker', 'time_my_tasks', 'time_my_timesheet', 'time_projects', 'attendance_tracker', 'attendance_my', 'attendance_holidays', 'leave_tracker', 'leave_my', 'compoff', 'assets'],
        functions: []
    }
};

/**
 * Load permissions from backend into cache.
 * Returns a promise that resolves when loading is complete.
 */
export async function loadRolePermissions(forceRefresh = false) {
    if (permissionsCache && !forceRefresh) return permissionsCache;
    if (isLoading && loadPromise) return loadPromise;

    isLoading = true;
    loadPromise = (async () => {
        try {
            const data = await fetchAllRolePermissions();
            
            // Rebuild cache structure from flat array
            const newCache = { L1: { applications: [], functions: [] }, L2: { applications: [], functions: [] }, L3: { applications: [], functions: [] }, L4: { applications: [], functions: [] } };
            
            if (data && data.length > 0) {
                for (const row of data) {
                    if (!newCache[row.role_key]) continue;
                    
                    if (row.enabled) {
                        if (row.permission_type === 'application') {
                            newCache[row.role_key].applications.push(row.permission_key);
                        } else if (row.permission_type === 'function') {
                            newCache[row.role_key].functions.push(row.permission_key);
                        }
                    }
                }
                permissionsCache = newCache;
            } else {
                // If backend returns nothing, fallback to defaults
                console.warn('[ROLE-SETTINGS] No permissions returned from backend, using defaults.');
                permissionsCache = JSON.parse(JSON.stringify(DEFAULT_PERMISSIONS));
            }
        } catch (e) {
            console.error('[ROLE-SETTINGS] Failed to load permissions, falling back to defaults.', e);
            permissionsCache = JSON.parse(JSON.stringify(DEFAULT_PERMISSIONS));
        } finally {
            isLoading = false;
        }
        return permissionsCache;
    })();
    
    return loadPromise;
}

/**
 * Get current permissions cache or default if not loaded
 */
export function getRolePermissions() {
    return permissionsCache || DEFAULT_PERMISSIONS;
}

/**
 * Check if the current user can view a specific application (sidebar item).
 * @param {string} appKey - The key of the application
 * @returns {boolean}
 */
export function canViewApplication(appKey) {
    const { role } = getUserAccessContext();
    const currentRole = role || 'L1';
    
    // Always allow admin bypass as a safety net
    if (currentRole === 'L3') return true;
    
    const perms = getRolePermissions();
    if (perms[currentRole] && perms[currentRole].applications) {
        return perms[currentRole].applications.includes(appKey);
    }
    
    return false;
}

/**
 * Check if the current user can use a specific function.
 * @param {string} functionKey - The key of the function
 * @returns {boolean}
 */
export function canUseFunction(functionKey) {
    const { role } = getUserAccessContext();
    const currentRole = role || 'L1';
    
    // Always allow admin bypass as a safety net
    if (currentRole === 'L3') return true;
    
    const perms = getRolePermissions();
    if (perms[currentRole] && perms[currentRole].functions) {
        return perms[currentRole].functions.includes(functionKey);
    }
    
    return false;
}
