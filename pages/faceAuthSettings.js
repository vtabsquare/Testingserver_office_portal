// faceAuthSettings.js - FaceAuth Settings page for admin to manage face verification requirements

import { state } from '../state.js';
import { getPageContentHTML } from '../utils.js';
import { isAdminUser } from '../utils/accessControl.js';
import { canUseFunction } from '../utils/roleSettings.js';
import { API_BASE_URL } from '../config.js';
import { renderSettingsLayout } from '../components/settingsLayout.js';

let cachedEmployees = [];
let isLoading = false;

async function fetchFaceAuthSettings() {
    try {
        const base = API_BASE_URL.replace(/\/$/, '');
        const res = await fetch(`${base}/api/faceauth-settings`, {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' }
        });
        
        if (!res.ok) {
            throw new Error(`Failed to fetch: ${res.status}`);
        }
        
        const data = await res.json();
        return data.employees || [];
    } catch (error) {
        console.error('[FACEAUTH-SETTINGS] Error fetching:', error);
        return [];
    }
}

async function updateFaceAuthSetting(employeeId, faceAuthRequired) {
    try {
        const base = API_BASE_URL.replace(/\/$/, '');
        const res = await fetch(`${base}/api/faceauth-settings/${employeeId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ face_auth_required: faceAuthRequired })
        });
        
        if (!res.ok) {
            throw new Error(`Failed to update: ${res.status}`);
        }
        
        const data = await res.json();
        return data.success;
    } catch (error) {
        console.error('[FACEAUTH-SETTINGS] Error updating:', error);
        return false;
    }
}

function renderEmployeeRow(emp) {
    const isEnabled = emp.face_auth_required;
    const statusClass = isEnabled ? 'active' : 'locked';
    const statusText = isEnabled ? 'Required' : 'Not Required';
    
    return `
        <tr data-employee-id="${emp.employee_id}">
            <td>
                <div style="display:flex; flex-direction:column; line-height:1.35;">
                    <span style="font-weight:600; color:var(--text-primary); font-size:14px;">
                        ${emp.name || 'Unknown'}
                    </span>
                    <span style="font-size:12px; color:var(--text-secondary);">
                        ${emp.email || ''}
                    </span>
                </div>
            </td>
            <td>${emp.employee_id || '-'}</td>
            <td>
                <span class="status-badge ${statusClass}">${statusText}</span>
            </td>
            <td>
                <div class="table-actions">
                    <button class="btn ${isEnabled ? 'btn-secondary' : 'btn-primary'} faceauth-toggle-btn" 
                            data-employee-id="${emp.employee_id}" 
                            data-enabled="${isEnabled}"
                            style="padding: 6px 12px; font-size: 12px;">
                        <i class="fa-solid ${isEnabled ? 'fa-toggle-on' : 'fa-toggle-off'}"></i>
                        ${isEnabled ? 'Disable' : 'Enable'}
                    </button>
                </div>
            </td>
        </tr>
    `;
}

function renderTable(employees) {
    if (!employees || employees.length === 0) {
        return `<p class="placeholder-text">No employees found.</p>`;
    }
    
    const rows = employees.map(emp => renderEmployeeRow(emp)).join('');
    
    return `
        <div class="table-container">
            <table class="table">
                <thead>
                    <tr>
                        <th>Employee</th>
                        <th>ID</th>
                        <th>Face Auth Status</th>
                        <th>Actions</th>
                    </tr>
                </thead>
                <tbody id="faceauth-employees-tbody">
                    ${rows}
                </tbody>
            </table>
        </div>
    `;
}

async function handleToggleClick(e) {
    const btn = e.target.closest('.faceauth-toggle-btn');
    if (!btn) return;
    
    const employeeId = btn.dataset.employeeId;
    const currentEnabled = btn.dataset.enabled === 'true';
    const newEnabled = !currentEnabled;
    
    // Disable button during update
    btn.disabled = true;
    btn.style.opacity = '0.5';
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Updating...';
    
    const success = await updateFaceAuthSetting(employeeId, newEnabled);
    
    if (success) {
        // Update the cached data
        const emp = cachedEmployees.find(e => e.employee_id === employeeId);
        if (emp) {
            emp.face_auth_required = newEnabled;
        }
        
        // Re-render the row
        const row = document.querySelector(`tr[data-employee-id="${employeeId}"]`);
        if (row) {
            row.outerHTML = renderEmployeeRow({ ...emp, face_auth_required: newEnabled });
        }
        
        // Show success message
        showToast(`Face verification ${newEnabled ? 'enabled' : 'disabled'} for ${emp?.name || employeeId}`, 'success');
    } else {
        // Re-enable button on failure
        btn.disabled = false;
        btn.style.opacity = '1';
        btn.innerHTML = `<i class="fa-solid ${currentEnabled ? 'fa-toggle-on' : 'fa-toggle-off'}"></i> ${currentEnabled ? 'Disable' : 'Enable'}`;
        showToast('Failed to update setting', 'error');
    }
}

function showToast(message, type = 'info') {
    // Remove existing toast
    const existing = document.getElementById('faceauth-toast');
    if (existing) existing.remove();
    
    const toast = document.createElement('div');
    toast.id = 'faceauth-toast';
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

export async function renderFaceAuthSettings() {
    const container = document.getElementById('app-content');
    if (!container) return;
    
    // Admin-only access
    if (!canUseFunction('manage_faceauth_settings')) {
        container.innerHTML = getPageContentHTML('Settings', renderSettingsLayout('faceauth-settings', `
            <div class="card" style="padding: 40px; text-align: center;">
                <i class="fa-solid fa-lock" style="font-size: 48px; color: #e74c3c; margin-bottom: 16px;"></i>
                <h2>Access Denied</h2>
                <p>Only administrators can access FaceAuth settings.</p>
            </div>
        `));
        return;
    }
    
    // Show loading state
    container.innerHTML = getPageContentHTML('Settings', renderSettingsLayout('faceauth-settings', `
        <div class="card">
            <h3><i class="fa-solid fa-shield-halved"></i> FaceAuth Settings</h3>
            <p class="allocation-description">Manage face verification requirements for employees.</p>
            <div style="text-align: center; padding: 40px;">
                <i class="fa-solid fa-spinner fa-spin" style="font-size: 24px; color: var(--primary-color);"></i>
                <p style="margin-top: 12px; color: var(--text-secondary);">Loading employees...</p>
            </div>
        </div>
    `));
    
    // Fetch data
    isLoading = true;
    cachedEmployees = await fetchFaceAuthSettings();
    isLoading = false;
    
    // Render full page
    container.innerHTML = getPageContentHTML('Settings', renderSettingsLayout('faceauth-settings', `
        <div class="card">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
                <div>
                    <h3 style="margin: 0;"><i class="fa-solid fa-shield-halved"></i> FaceAuth Settings</h3>
                    <p class="allocation-description" style="margin: 4px 0 0 0;">Manage face verification requirements for employees.</p>
                </div>
                <div style="display: flex; align-items: center; gap: 12px;">
                    <span style="font-size: 13px; color: var(--text-secondary);">${cachedEmployees.length} employees</span>
                    <button id="refresh-faceauth-btn" class="btn btn-secondary" style="padding: 8px 14px;">
                        <i class="fa-solid fa-arrows-rotate"></i> Refresh
                    </button>
                </div>
            </div>
            
            <div style="background: #fef3c7; border: 1px solid #fcd34d; border-radius: 8px; padding: 12px 16px; margin-bottom: 20px;">
                <div style="display: flex; align-items: flex-start; gap: 10px;">
                    <i class="fa-solid fa-circle-info" style="color: #d97706; margin-top: 2px;"></i>
                    <div style="font-size: 13px; color: #92400e;">
                        <strong>About Face Verification</strong><br>
                        When enabled, employees must verify their face during login. Disable for employees without camera access.
                    </div>
                </div>
            </div>
            
            <div id="faceauth-table-container">
                ${renderTable(cachedEmployees)}
            </div>
        </div>
    `));
    
    // Add event listeners
    document.addEventListener('click', handleToggleClick);
    
    const refreshBtn = document.getElementById('refresh-faceauth-btn');
    if (refreshBtn) {
        refreshBtn.addEventListener('click', async () => {
            refreshBtn.disabled = true;
            refreshBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Refreshing...';
            
            cachedEmployees = await fetchFaceAuthSettings();
            
            const tableContainer = document.getElementById('faceauth-table-container');
            if (tableContainer) {
                tableContainer.innerHTML = renderTable(cachedEmployees);
            }
            
            refreshBtn.disabled = false;
            refreshBtn.innerHTML = '<i class="fa-solid fa-arrows-rotate"></i> Refresh';
            
            showToast('Settings refreshed', 'success');
        });
    }
}

export function cleanupFaceAuthSettings() {
    document.removeEventListener('click', handleToggleClick);
}
