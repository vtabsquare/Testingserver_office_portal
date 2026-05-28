import { canViewApplication } from '../utils/roleSettings.js';

export const renderSettingsLayout = (activeId, contentHTML) => {
    
    // Define the settings menu items
    const settingsItems = [
        { id: 'leave-settings', path: '#/leave-settings', icon: 'fa-sliders', title: 'Leave Settings', req: 'leave_settings' },
        { id: 'shift-settings', path: '#/shift-settings', icon: 'fa-business-time', title: 'Shift Settings', req: 'shift_settings' },
        { id: 'login-settings', path: '#/login-settings', icon: 'fa-shield-halved', title: 'Login Settings', req: 'login_settings' },
        { id: 'faceauth-settings', path: '#/faceauth-settings', icon: 'fa-face-viewfinder', title: 'FaceAuth Settings', req: 'faceauth_settings' },
        { id: 'role-settings', path: '#/role-settings', icon: 'fa-user-shield', title: 'Role Settings', req: 'role_settings' }
    ];

    // Filter items based on permissions
    const visibleItems = settingsItems.filter(item => canViewApplication(item.req));

    // Generate Sidebar HTML
    const sidebarHTML = visibleItems.map(item => `
        <a href="${item.path}" class="settings-nav-item ${activeId === item.id ? 'active' : ''}">
            <i class="fa-solid ${item.icon}"></i>
            <span>${item.title}</span>
        </a>
    `).join('');

    return `
        <div class="settings-wrapper" style="display: flex; gap: 24px; min-height: calc(100vh - 120px);">
            <!-- Settings Sidebar -->
            <div class="settings-sidebar card" style="width: 250px; flex-shrink: 0; padding: 16px; align-self: flex-start;">
                <h3 style="margin-bottom: 20px; font-size: 1.1rem; color: var(--text-primary);"><i class="fa-solid fa-gear" style="margin-right: 8px;"></i>Settings</h3>
                <nav class="settings-nav" style="display: flex; flex-direction: column; gap: 6px;">
                    ${sidebarHTML}
                </nav>
            </div>
            
            <!-- Settings Content Area -->
            <div class="settings-content" style="flex: 1; min-width: 0;">
                ${contentHTML}
            </div>
        </div>
        
        <style>
            .settings-nav-item {
                display: flex;
                align-items: center;
                gap: 12px;
                padding: 10px 14px;
                border-radius: 8px;
                color: var(--text-secondary);
                text-decoration: none;
                font-weight: 500;
                transition: all 0.2s ease;
            }
            .settings-nav-item:hover {
                background: var(--bg-color);
                color: var(--text-primary);
            }
            .settings-nav-item.active {
                background: var(--primary-color-light, rgba(79, 70, 229, 0.1));
                color: var(--primary-color, #4f46e5);
                font-weight: 600;
            }
            .settings-nav-item i {
                font-size: 1.1rem;
                width: 20px;
                text-align: center;
            }
        </style>
    `;
};
