import sys
import re

file_path = r"c:\Users\91733\Documents\Office_portal-dynamic settings\Testingserver_office_portal\pages\shared.js"

with open(file_path, 'r', encoding='utf-8', errors='surrogateescape') as f:
    content = f.read()

# 1. Imports and variable
import_str = "import { isAdminUser, isManagerOrAdmin } from '../utils/accessControl.js';"
new_import_str = "import { isAdminUser, isManagerOrAdmin } from '../utils/accessControl.js';\nimport { canUseFunction } from '../utils/roleSettings.js';"
if new_import_str not in content:
    content = content.replace(import_str, new_import_str)

var_str = "let currentInboxCategory = 'leaves';"
new_var_str = "let currentInboxCategory = 'leaves';\nlet inboxActionMode = false;"
if new_var_str not in content:
    content = content.replace(var_str, new_var_str)

# 2. showInboxModeModal function
modal_fn = """
const showInboxModeModal = () => {
    return new Promise((resolve) => {
        const modalId = 'inbox-mode-modal-' + Date.now();
        const modalHtml = `
            <div id="${modalId}" class="inbox-mode-modal-overlay" style="position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0, 0, 0, 0.5); z-index: 9999; display: flex; align-items: center; justify-content: center;">
                <div class="inbox-mode-modal-content" style="background: var(--surface-color, #fff); padding: 30px; border-radius: 16px; max-width: 500px; width: 90%; box-shadow: 0 10px 25px rgba(0,0,0,0.2);">
                    <h3 style="margin-top:0; font-size: 20px; font-weight: 600; color: var(--text-primary);">Inbox Access Mode</h3>
                    <p style="color: var(--text-secondary); margin-bottom: 20px; font-size: 14px;">Please select how you want to access the inbox.</p>
                    <div style="display:flex; gap: 16px;">
                        <div class="inbox-mode-option" id="mode-view-only" style="flex:1; border: 2px solid var(--border-color, #e5e7eb); border-radius: 12px; padding: 20px; cursor: pointer; text-align: center; transition: all 0.2s; background: var(--bg-color, #fff);">
                            <i class="fa-solid fa-eye" style="font-size: 32px; color: #3b82f6; margin-bottom: 12px;"></i>
                            <h4 style="margin: 0 0 8px 0; font-size: 16px;">View Only</h4>
                            <p style="margin: 0; font-size: 13px; color: var(--text-secondary);">Browse all approvals without taking action.</p>
                        </div>
                        <div class="inbox-mode-option" id="mode-action" style="flex:1; border: 2px solid var(--border-color, #e5e7eb); border-radius: 12px; padding: 20px; cursor: pointer; text-align: center; transition: all 0.2s; background: var(--bg-color, #fff);">
                            <i class="fa-solid fa-gavel" style="font-size: 32px; color: #10b981; margin-bottom: 12px;"></i>
                            <h4 style="margin: 0 0 8px 0; font-size: 16px;">Action Mode</h4>
                            <p style="margin: 0; font-size: 13px; color: var(--text-secondary);">Approve or reject pending requests.</p>
                        </div>
                    </div>
                </div>
            </div>
        `;
        document.body.insertAdjacentHTML('beforeend', modalHtml);
        
        const overlay = document.getElementById(modalId);
        
        const cleanup = () => {
            if (overlay) overlay.remove();
        };

        document.getElementById('mode-view-only').addEventListener('click', () => {
            cleanup();
            resolve('view_only');
        });

        document.getElementById('mode-action').addEventListener('click', () => {
            cleanup();
            resolve('action');
        });

        // Hover effects
        document.querySelectorAll('.inbox-mode-option').forEach(el => {
            el.addEventListener('mouseenter', e => {
                e.currentTarget.style.borderColor = e.currentTarget.id === 'mode-action' ? '#10b981' : '#3b82f6';
                e.currentTarget.style.transform = 'translateY(-2px)';
            });
            el.addEventListener('mouseleave', e => {
                e.currentTarget.style.borderColor = 'var(--border-color, #e5e7eb)';
                e.currentTarget.style.transform = 'translateY(0)';
            });
        });
    });
};
"""
if "showInboxModeModal" not in content:
    content = content.replace("export const renderInboxPage = async () => {", modal_fn + "\nexport const renderInboxPage = async () => {")

# 3. renderInboxPage logic
render_inbox_start = """    const isAdmin = isAdminUser();
    const canViewTeamQueues = isManagerOrAdmin();
    const showAwaitingTab = canViewTeamQueues;
    console.log('dY`  User is admin:', isAdmin, '| can view team queues:', canViewTeamQueues);"""

new_render_inbox_start = """    const isAdmin = isAdminUser();
    const canViewTeamQueues = isManagerOrAdmin();
    const showAwaitingTab = canViewTeamQueues;
    
    if (isAdmin) {
        inboxActionMode = true;
    } else if (canViewTeamQueues && canUseFunction('inbox_action_mode')) {
        const choice = await showInboxModeModal();
        inboxActionMode = (choice === 'action');
    } else {
        inboxActionMode = false;
    }
    
    console.log('dY`  User is admin:', isAdmin, '| can view team queues:', canViewTeamQueues, '| action mode:', inboxActionMode);"""

if "inboxActionMode = true;" not in content:
    content = content.replace(render_inbox_start, new_render_inbox_start)

# 4. Mode badge
static_content_start = """    const content = `
    <div class="inbox-container">
        <div class="inbox-sidebar">"""

new_static_content_start = """    const modeBadgeHtml = inboxActionMode ? 
        '<span style="padding: 4px 10px; border-radius: 999px; font-size: 12px; font-weight: 600; background: #d1fae5; color: #065f46;"><i class="fa-solid fa-gavel"></i> Action Mode</span>' : 
        '<span style="padding: 4px 10px; border-radius: 999px; font-size: 12px; font-weight: 600; background: #dbeafe; color: #1e3a8a;"><i class="fa-solid fa-eye"></i> View Only</span>';

    const content = `
    <div class="inbox-container" style="position: relative;">
        <div style="position:absolute; top: -35px; right: 20px; z-index: 10;">
            ${modeBadgeHtml}
        </div>
        <div class="inbox-sidebar">"""

if "modeBadgeHtml" not in content:
    content = content.replace(static_content_start, new_static_content_start)

# 5. showActions replacements
content = content.replace("const showActions = currentInboxTab === 'awaiting' && isAdmin;", "const showActions = currentInboxTab === 'awaiting' && inboxActionMode;")
content = content.replace("const showActions = isAdmin && currentInboxTab === 'awaiting';", "const showActions = inboxActionMode && currentInboxTab === 'awaiting';")
content = content.replace("if (currentInboxTab === 'awaiting' && isAdmin) {", "if (currentInboxTab === 'awaiting' && inboxActionMode) {")
content = content.replace("if (isAdmin && currentInboxTab === 'awaiting') {", "if (inboxActionMode && currentInboxTab === 'awaiting') {")

# 6. completed tab replacements
content = content.replace("} else if (currentInboxTab === 'completed' && isAdmin) {", "} else if (currentInboxTab === 'completed' && canViewTeamQueues) {")

with open(file_path, 'w', encoding='utf-8', errors='surrogateescape') as f:
    f.write(content)

print("Updates applied successfully.")
