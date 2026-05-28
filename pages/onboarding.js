import { state } from '../state.js';
import { getPageContentHTML } from '../utils.js';
import { API_BASE_URL } from '../config.js';
import { isManagerOrAdmin } from '../utils/accessControl.js';
import { canViewApplication } from '../utils/roleSettings.js';

const getStageStatus = (record, stageNum, currentStage) => {
    const ok = (v) => String(v || '').trim().length > 0;
    const personalDone = ok(record?.firstname) && ok(record?.lastname) && ok(record?.email) && ok(record?.contact) && ok(record?.address) && ok(record?.department) && ok(record?.designation);
    const interviewScheduled = ok(record?.interview_date);
    const mailSent = record?.mail_status === 'Sent';
    const mailYes = record?.mail_reply === 'Yes';
    const docsUploaded = hasUploadedDocuments(record);
    const docsVerified = String(record?.document_status || '').trim().toLowerCase() === 'verified';
    const progressStage = getStageNumber(record?.progress_step);
    const onboardingDone = progressStage > 4 || !!record?.converted_to_master;
    const completed = record?.progress_step === 'Completed' || docsVerified;
    switch (stageNum) {
        case 1: return personalDone ? 'completed' : (currentStage === 1 ? 'in_progress' : 'pending');
        case 2: return mailSent ? 'completed' : ((interviewScheduled || currentStage === 2) ? 'in_progress' : 'pending');
        case 3: return (mailYes && docsUploaded) ? 'completed' : ((mailSent || currentStage === 3) ? 'in_progress' : 'pending');
        case 4: return onboardingDone ? 'completed' : (currentStage === 4 ? 'in_progress' : 'pending');
        case 5: return completed ? 'completed' : (currentStage === 5 ? 'in_progress' : 'pending');
        default: return 'pending';
    }
};

const getDocumentList = (record) => {
    const raw = record?.document_urls || '';
    try {
        const arr = Array.isArray(raw) ? raw : JSON.parse(raw || '[]');
        return Array.isArray(arr) ? arr : [];
    } catch (_) {
        return [];
    }
};

const hasUploadedDocuments = (record) => getDocumentList(record).length > 0;

// Simple in-memory flag to control when Stage 5 verification is allowed in the current session
let stage5DocsEnabled = false;

// ==================== STAGE 3 AUTO-POLL (Offer Acceptance) ====================
let stage3PollTimer = null;
const stopStage3Polling = () => { try { if (stage3PollTimer) clearInterval(stage3PollTimer); stage3PollTimer = null; } catch (_) { } };
const startStage3Polling = (record) => {
    stopStage3Polling();
    try {
        const shouldPoll = record && record.mail_status === 'Sent' && (!record.mail_reply || record.mail_reply === 'Pending');
        if (!shouldPoll) return;
        const doCheck = async () => {
            try {
                const response = await fetch(`${API_BASE}/onboarding/${record.id}/check-email`);
                if (!response.ok) return;
                const result = await response.json().catch(() => ({ success: false }));
                if (!result.success) return;
                const reply = (result && (result.reply || (result.data && result.data.reply))) || '';
                if (reply === 'Yes' || reply === 'No') {
                    // Persist reply to backend so UI reflects latest state
                    try {
                        await fetch(`${API_BASE}/onboarding/${record.id}/mail-reply`, {
                            method: 'PUT',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ mail_reply: reply })
                        });
                    } catch (_e) { }
                    // Re-render only when explicit terminal reply is received
                    showOnboardingForm(record.id, 3);
                    stopStage3Polling();
                }
            } catch (_) { }
        };
        // Immediate check and then interval
        doCheck();
        stage3PollTimer = setInterval(doCheck, 15000);
    } catch (_) { }
};

// ==================== STAGE 4: DOJ & POLICY LETTER ====================
const handleDOJPolicySubmit = async (e) => {
    e.preventDefault();
    if (!currentOnboardingRecord?.id) { showToast('No onboarding record found', 'error'); return; }
    const fd = new FormData(e.target);
    const doj = fd.get('doj');
    if (!doj) { showToast('Please select Date of Joining', 'error'); return; }

    // Build a lightweight modal for file upload
    const modal = document.createElement('div');
    modal.id = 'policy-upload-modal';
    modal.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,.45); display:flex; align-items:center; justify-content:center; z-index:9999; padding:16px;';
    modal.innerHTML = `
      <div class="card" style="width:100%; max-width:520px; border-radius:12px; padding:16px;">
        <div style="display:flex; align-items:center; justify-content:space-between;">
          <h3 style="margin:0;">Send Policy Letter</h3>
          <button type="button" class="modal-close" style="background:transparent; border:none; font-size:20px; cursor:pointer;">✕</button>
        </div>
        <div class="upload-description">Upload the files you want to email (e.g., Offer_Letter.pdf and Policy.pdf). The email will be sent only after upload.</div>
        <div style="margin-top:12px;">
          <label style="font-weight:600; display:block; margin-bottom:6px;">Attachments (PDF)</label>
          <input id="pl-attachments" type="file" accept="application/pdf" multiple />
        </div>
        <div class="doj-info">DOJ: <strong>${doj}</strong></div>
        <div style="display:flex; justify-content:flex-end; gap:10px; margin-top:16px;">
          <button type="button" class="btn btn-light modal-close">Cancel</button>
          <button type="button" id="pl-send-btn" class="btn btn-primary"><i class="fa-regular fa-paper-plane"></i> Upload & Send</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
    const close = () => { try { modal.remove(); } catch (_) { } };
    modal.addEventListener('click', (ev) => { if (ev.target.classList.contains('modal-close') || ev.target.id === 'policy-upload-modal') close(); });

    // Handle send
    document.getElementById('pl-send-btn')?.addEventListener('click', async () => {
        const input = document.getElementById('pl-attachments');
        if (!input || !input.files || input.files.length === 0) { showToast('Select at least one PDF file', 'info'); return; }
        const btn = document.getElementById('pl-send-btn');
        const original = btn.innerHTML; btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Sending...';
        try {
            const form = new FormData();
            form.set('doj', doj);
            Array.from(input.files).forEach(f => form.append('attachments', f));
            const url = `${API_BASE}/onboarding/${currentOnboardingRecord.id}/policy-letter-upload`;
            const res = await fetch(url, { method: 'POST', body: form });
            const json = await res.json().catch(() => ({ success: false }));
            if (!res.ok || !json.success) throw new Error(json.message || `HTTP ${res.status}`);
            showToast('Email sent with uploaded attachments', 'success');
            close();
            setTimeout(() => showOnboardingForm(currentOnboardingRecord.id, 4), 800);
        } catch (err) {
            console.error('[Policy Upload] Error:', err);
            showToast(`Failed to send email: ${err.message}`, 'error');
            btn.disabled = false; btn.innerHTML = original;
        }
    });
};

// ==================== STAGE 3: UPLOAD DOCUMENTS ====================
const handleStage3Upload = async () => {
    if (!currentOnboardingRecord?.id) {
        showToast('No onboarding record found', 'error');
        return;
    }
    try {
        const fileInput = document.getElementById('offer-document-upload');
        if (!fileInput || !fileInput.files || fileInput.files.length === 0) {
            showToast('Select at least one file to upload', 'info');
            return;
        }
        const formData = new FormData();
        Array.from(fileInput.files).forEach(f => formData.append('documents', f));
        const uploadRes = await fetch(`${API_BASE}/onboarding/${currentOnboardingRecord.id}/documents`, {
            method: 'POST',
            body: formData
        });
        const uploadJson = await uploadRes.json().catch(() => ({ success: false }));
        if (!uploadRes.ok || !uploadJson.success) throw new Error(uploadJson.message || `HTTP ${uploadRes.status}`);
        showToast('Documents uploaded successfully!', 'success');
        setTimeout(() => showOnboardingForm(currentOnboardingRecord.id, 3), 700);
    } catch (err) {
        console.error('Upload failed', err);
        showToast('Failed to upload documents', 'error');
    }
};

const handleStage3Delete = async () => {
    if (!currentOnboardingRecord?.id) {
        showToast('No onboarding record found', 'error');
        return;
    }
    const btn = document.getElementById('offer-delete-btn');
    if (!btn) return;
    if (!confirm('Delete all uploaded documents for this candidate? This cannot be undone.')) {
        return;
    }
    const original = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Deleting...';
    try {
        const res = await fetch(`${API_BASE}/onboarding/${currentOnboardingRecord.id}/documents`, {
            method: 'DELETE'
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok || !json.success) throw new Error(json.message || `HTTP ${res.status}`);
        showToast('Documents deleted successfully', 'success');
        setTimeout(() => showOnboardingForm(currentOnboardingRecord.id, 3), 700);
    } catch (err) {
        console.error('Delete documents failed', err);
        showToast('Failed to delete documents', 'error');
    } finally {
        btn.disabled = false;
        btn.innerHTML = original;
    }
};

// ==================== STAGE 1 UPDATE (EDIT EXISTING) ====================
const handleStage1UpdateSubmit = async (e) => {
    e.preventDefault();
    const formData = new FormData(e.target);
    const data = Object.fromEntries(formData.entries());

    if (!currentOnboardingRecord?.id) {
        showToast('No onboarding record found', 'error');
        return;
    }
    try {
        const res = await fetch(`${API_BASE}/onboarding/${currentOnboardingRecord.id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
        const json = await res.json();
        if (!res.ok || !json.success) throw new Error(json.message || `HTTP ${res.status}`);
        showToast('Personal information updated!', 'success');
        currentOnboardingRecord = json.record;
        window.toggleStage1Edit(false);
    } catch (err) {
        console.error('Update personal info failed', err);
        showToast('Failed to update personal information', 'error');
    }
};

// Gating helpers
const isPersonalComplete = (record) => {
    const ok = (v) => String(v || '').trim().length > 0;
    return ok(record?.firstname) && ok(record?.lastname) && ok(record?.email) && ok(record?.contact) && ok(record?.address) && ok(record?.department) && ok(record?.designation);
};

const canAccessStage = (stageNum, record) => {
    const progressStage = getStageNumber(record?.progress_step);
    switch (stageNum) {
        case 1: return true;
        case 2: return isPersonalComplete(record);
        case 3: return String(record?.mail_status || '').toLowerCase() === 'sent';
        case 4:
            return progressStage >= 4 || (String(record?.mail_reply || '').toLowerCase() === 'yes' && hasUploadedDocuments(record));
        case 5:
            return progressStage >= 5
                || String(record?.document_status || '').toLowerCase() === 'verified'
                || !!record?.converted_to_master
                || !!record?.employee_id
                || (hasUploadedDocuments(record) && !!record?.doj);
        default: return false;
    }
};

const getHeaderTheme = (status) => {
    if (status === 'completed') return { bg: '#eafaf2', border: '#10b981', badge: 'success', label: 'COMPLETED' };
    if (status === 'in_progress') return { bg: '#fef3c7', border: '#f59e0b', badge: 'warning', label: 'IN PROGRESS' };
    return { bg: '#fde7ea', border: '#ef4444', badge: 'danger', label: 'PENDING' };
};

const API_BASE = `${API_BASE_URL}/api`;

// Onboarding list batching state
const LIST_PAGE_SIZE = 12;
let onboardingListState = { all: [], rendered: 0, pageSize: LIST_PAGE_SIZE, lastQuery: '' };

// Bulk selection state and helpers
let onboardingSelection = new Set();
const isSelected = (id) => onboardingSelection.has(String(id));
const updateRenderedCheckboxes = () => {
    try {
        document.querySelectorAll('.onb-select').forEach(cb => {
            const id = cb.getAttribute('data-id');
            cb.checked = onboardingSelection.has(String(id));
        });
    } catch (_) { }
};
const syncSelectAllCheckbox = () => {
    try {
        const total = onboardingListState.all.length;
        const sel = onboardingSelection.size;
        const box = document.getElementById('onb-select-all');
        if (!box) return;
        box.indeterminate = sel > 0 && sel < total;
        box.checked = total > 0 && sel >= total;
    } catch (_) { }
};

// Manual document status save (without completion)
const handleDocumentStatusSubmit = async (e) => {
    e.preventDefault();
    if (!currentOnboardingRecord?.id) {
        showToast('No onboarding record found', 'error');
        return;
    }
    const formData = new FormData(e.target);
    const data = Object.fromEntries(formData.entries());
    try {
        const res = await fetch(`${API_BASE}/onboarding/${currentOnboardingRecord.id}/document-status`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
        const json = await res.json();
        if (!res.ok || !json.success) throw new Error(json.message || `HTTP ${res.status}`);
        showToast('Document status updated', 'success');
        currentOnboardingRecord.document_status = data.document_status;
        if (String(data.document_status || '').toLowerCase() === 'verified') {
            currentOnboardingRecord.progress_step = 'Completed';
        } else if (String(currentOnboardingRecord.progress_step || '').toLowerCase() === 'completed') {
            currentOnboardingRecord.progress_step = 'Physical Document Verification';
        }
        setTimeout(() => showOnboardingForm(currentOnboardingRecord.id, 5), 800);
    } catch (err) {
        console.error('Update document status failed', err);
        showToast('Failed to update document status', 'error');
    }
};

// Send onboarding mail with DOJ
const handleOnboardingMailSubmit = async (e) => {
    e.preventDefault();
    if (!currentOnboardingRecord?.id) {
        showToast('No onboarding record found', 'error');
        return;
    }
    const formData = new FormData(e.target);
    const data = Object.fromEntries(formData.entries());
    try {
        const res = await fetch(`${API_BASE}/onboarding/${currentOnboardingRecord.id}/onboarding-mail`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
        const json = await res.json();
        if (!res.ok || !json.success) throw new Error(json.message || `HTTP ${res.status}`);
        showToast('Onboarding mail sent', 'success');
    } catch (err) {
        console.error('Send onboarding mail failed', err);
        showToast('Failed to send onboarding mail', 'error');
    }
};

// A clickable version of the stepper for the modal, navigates to chosen stage for the record,
// and shows a completion timestamp beneath each completed stage.
const renderClickableStepper = (currentStage, record) => {
    const stages = [
        { num: 1, label: 'Personal Information', icon: 'fa-user' },
        { num: 2, label: 'Scheduling Interview', icon: 'fa-calendar-check' },
        { num: 3, label: 'Offer Acceptance', icon: 'fa-envelope' },
        { num: 4, label: 'Onboarding', icon: 'fa-id-card' },
        { num: 5, label: 'Physical Document Verification', icon: 'fa-file-shield' }
    ];
    const tsFor = (stageNum) => {
        switch (stageNum) {
            case 1: return record.personal_updated_at || record.created_at;
            case 2: return record.mail_updated_at || record.interview_updated_at || record.interview_date;
            case 3: return record.mail_updated_at || (record.mail_reply && record.mail_reply !== 'Pending' ? record.mail_updated_at : null);
            case 4: return record.completed_at || record.doj;
            case 5: return record.document_updated_at;
            default: return null;
        }
    };
    const item = (s, i) => {
        const stageStatus = getStageStatus(record, s.num, currentStage);
        const ts = tsFor(s.num);
        const tsHtml = ts ? `<div class="timestamp">${fmt(ts)}</div>` : '';
        return `
        <button onclick="window.gotoRecordStage('${record.id}', ${s.num})" class="stepper-item ${stageStatus === 'completed' ? 'completed' : ''} ${stageStatus === 'in_progress' ? 'active' : ''}"
            style="appearance:none; background:transparent; border:none; cursor:pointer; display:flex; align-items:center; gap:8px;">
            <div class="stepper-circle">${s.num}</div>
            <div class="stepper-label">
                <span><i class="fa-solid ${s.icon}" style="margin-right:6px;"></i>Stage ${s.num} - ${s.label}</span>
                ${tsHtml}
            </div>
        </button>
        ${i < stages.length - 1 ? '<div class="stepper-line"></div>' : ''}
    `;
    };
    return `<div class="stepper" style="display:flex; align-items:center; justify-content:space-between; margin-top:12px;">${stages.map((s, i) => item(s, i)).join('')}</div>`;
};

// ==================== CARD RENDERERS ====================
const computeProgress = (record) => {
    const stage = getStageNumber(record?.progress_step);
    const total = 20; // normalized to 20 steps for UI
    const map = { 1: 3, 2: 8, 3: 12, 4: 18, 5: 20 };
    const done = map[stage] || 1;
    const percent = Math.round((done / total) * 100);
    return { done, total, percent };
};

const renderStatusChip = (record) => {
    const kind = getStatusColor(record.document_status, record.mail_status, record);
    const styles = kind === 'success'
        ? 'background:var(--success-soft);color:var(--success);'
        : kind === 'warning'
            ? 'background:var(--warning-soft);color:var(--warning);'
            : 'background:var(--danger-soft);color:var(--danger);';
    return `<span style="display:inline-block; padding:6px 10px; border-radius:9999px; ${styles} font-weight:700;">${getStatusText(record)}</span>`;
};

const renderOnboardingCard = (record) => {
    const name = `${record.firstname || ''} ${record.lastname || ''}`.trim();
    const desg = record.designation || '';
    const dept = record.department || '';
    const email = record.email || '';
    const contact = record.contact || '';
    const started = record.doj || record.interview_date || record.created_at || '';
    const { percent } = computeProgress(record);
    const statusChip = renderStatusChip(record);
    const stageNum = getStageNumber(record?.progress_step);
    const stageNames = {
        1: 'Personal Information',
        2: 'Scheduling Interview',
        3: 'Offer Acceptance',
        4: 'Onboarding',
        5: 'Physical Document Verification'
    };
    const baseLabel = stageNames[stageNum] || (record.progress_step || 'Personal Information');
    const stepLabel = stageNum ? `Stage ${stageNum} - ${baseLabel}` : baseLabel;

    // Generate avatar initials
    const initials = name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase();

    // Generate avatar color (same logic as employees)
    const pastelColors = ['#bfdbfe', '#c7d2fe', '#fecdd3', '#fde68a', '#bbf7d0', '#fcd34d'];
    const getAvatarColor = (seed = '') => {
        let hash = 0;
        for (let i = 0; i < seed.length; i++) {
            hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
        }
        return pastelColors[hash % pastelColors.length];
    };

    return `
    <div class="employee-card onboarding-card" style="position:relative;">
        <input type="checkbox" class="onb-select" data-id="${record.id}" ${isSelected(record.id) ? 'checked' : ''} title="Select" style="position:absolute; top:12px; left:12px; width:20px; height:20px; cursor:pointer; z-index:10;" />
        <div class="employee-card-header">
            <div class="employee-card-info">
                <div class="employee-avatar" style="background:${getAvatarColor(record.id || name)}; border: 2px solid rgba(255, 255, 255, 0.3); box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15), inset 0 1px 2px rgba(255, 255, 255, 0.2); color: #1a1a1a; font-weight: 600;">${initials}</div>
                <div>
                    <div class="employee-name">${name || ''}</div>
                    <div class="employee-meta">${desg || ''}</div>
                    <div class="employee-meta subtle">${dept || ''}</div>
                </div>
            </div>
            ${statusChip}
        </div>
        <div class="employee-card-body">
            ${email ? `<div class="employee-card-detail"><i class="fa-solid fa-envelope"></i><span>${email}</span></div>` : ''}
            ${contact ? `<div class="employee-card-detail"><i class="fa-solid fa-phone"></i><span>${contact}</span></div>` : ''}
            ${started ? `<div class="employee-card-detail"><i class="fa-solid fa-calendar"></i><span>Started: ${started}</span></div>` : ''}
        </div>
        <div class="progress-section">
            <div class="progress-header">
                <div class="progress-label">Progress</div>
                <div class="progress-percent">${percent}%</div>
            </div>
            <div class="progress-track">
                <div class="progress-fill" style="width:${percent}%"></div>
            </div>
            <div class="progress-step">${stepLabel}</div>
        </div>
        <div class="employee-card-footer">
            <button class="icon-btn view-details-btn" title="View Details" onclick="window.viewOnboardingRecord('${record.id}')">
                <i class="fa-regular fa-eye"></i>
                <span>View Details</span>
            </button>
        </div>
    </div>`;
};

// ==================== DETAILS MODAL ====================
const openOnboardingDetails = async (recordId) => {
    try {
        const res = await fetch(`${API_BASE}/onboarding/${recordId}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        if (!json.success) throw new Error('Failed');
        const record = json.record;
        const modal = document.createElement('div');
        modal.id = 'onboarding-details-modal';
        modal.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,.4); display:flex; align-items:center; justify-content:center; z-index:10000; padding:20px;';
        modal.innerHTML = renderDetailsModal(record);
        document.body.appendChild(modal);
        // Close handlers
        modal.addEventListener('click', (e) => {
            if (e.target.id === 'onboarding-details-modal' || e.target.classList.contains('modal-close')) {
                modal.remove();
            }
        });
    } catch (e) {
        console.error('Open details failed', e);
        showToast('Failed to open details', 'error');
    }
};

const fmt = (v) => {
    if (!v) return '—';
    try { const d = new Date(v); if (!isNaN(+d)) return d.toLocaleString(); } catch (_) { }
    return String(v);
};

const renderDetailsModal = (record) => {
    const name = `${record.firstname || ''} ${record.lastname || ''}`.trim();
    const desg = record.designation || '';
    const { percent } = computeProgress(record);
    const statusChip = renderStatusChip(record);
    return `
    <div class="card onboarding-details-card">
        <div class="modal-header">
            <div>
                <div class="modal-title">${name}</div>
                <div class="modal-subtitle">${desg}</div>
                <div class="modal-description">Onboarding progress and details</div>
            </div>
            <button class="modal-close" title="Close">✕</button>
        </div>

        <div class="modal-content">
            <div class="progress-container">
                <div class="progress-overview">
                    <div class="progress-title">Overall Progress</div>
                    ${statusChip}
                </div>
                <div class="progress-track">
                    <div class="progress-fill" style="width:${percent}%"></div>
                </div>
                <div class="progress-percent-display">
                    <div class="progress-percent-value">${percent}%</div>
                </div>
                ${renderClickableStepper(getStageNumber(record.progress_step), record)}
            </div>
        </div>
    </div>`;
};

// Close modal and navigate to specific onboarding stage for the selected record
const gotoRecordStage = (recordId, stage) => {
    try {
        document.getElementById('onboarding-details-modal')?.remove();
    } catch (_) { }
    showOnboardingForm(recordId, stage);
};

// Current onboarding record being viewed/edited
let currentOnboardingRecord = null;

// ==================== MAIN PAGE RENDER ====================
export const renderOnboardingPage = async () => {
    if (!canViewApplication('onboarding')) {
        document.getElementById('app-content').innerHTML = `
            <div class="access-denied-card">
                <i class="fa-solid fa-lock access-denied-icon"></i>
                <h2 class="access-denied-title">Access Denied</h2>
                <p class="access-denied-message">You don't have permission to access the Onboarding module.</p>
                <p class="access-denied-submessage">Contact your administrator if you need access.</p>
                <button class="btn btn-primary" onclick="window.location.hash='#/'">
                    <i class="fa-solid fa-arrow-left"></i> Go Back to Home
                </button>
            </div>
        `;
        return;
    }

    const controls = `
        <div class="employee-controls">
            <div class="employee-control-actions">
                <button id="new-onboarding-btn" class="btn btn-primary"><i class="fa-solid fa-plus"></i> ADD NEW</button>
                <button id="onb-delete-selected" class="btn btn-danger"><i class="fa-solid fa-trash"></i> DELETE SELECTED</button>
            </div>
        </div>
    `;

    const content = `
        <div class="card employees-card-shell">
            <div class="page-controls">
                <div class="inline-search">
                    <i class="fa-solid fa-search"></i>
                    <input type="text" id="onboarding-search" placeholder="Search by name or email">
                </div>
            </div>
            <div id="onboarding-list-container">
                <div class="loading-spinner">Loading onboarding records...</div>
            </div>
        </div>
    `;

    document.getElementById('app-content').innerHTML = getPageContentHTML('Employee Onboarding', content, controls);

    // Event listeners
    document.getElementById('new-onboarding-btn').addEventListener('click', () => showOnboardingForm(null));

    // Debounced search to avoid frequent re-renders
    let _obSearchTimer;
    document.getElementById('onboarding-search').addEventListener('input', (e) => {
        const q = e.target.value || '';
        clearTimeout(_obSearchTimer);
        _obSearchTimer = setTimeout(() => loadOnboardingList(q), 300);
    });

    // Delete selected
    document.getElementById('onb-delete-selected')?.addEventListener('click', async () => {
        const ids = Array.from(onboardingSelection);
        if (ids.length === 0) { showToast('No records selected', 'info'); return; }
        if (!confirm(`Delete ${ids.length} selected record(s)? This cannot be undone.`)) return;
        const btn = document.getElementById('onb-delete-selected');
        const original = btn.innerHTML;
        btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Deleting...';
        let ok = 0, fail = 0;
        for (const id of ids) {
            try {
                const res = await fetch(`${API_BASE}/onboarding/${id}`, { method: 'DELETE' });
                const json = await res.json().catch(() => ({}));
                if (res.ok && json.success) ok++; else fail++;
            } catch (_) { fail++; }
        }
        showToast(`Deleted ${ok} of ${ids.length} records${fail ? ` (${fail} failed)` : ''}`, fail ? 'warning' : 'success');
        onboardingSelection.clear();
        await loadOnboardingList(onboardingListState.lastQuery || '');
        btn.disabled = false; btn.innerHTML = original;
    });

    // Load initial data
    await loadOnboardingList();
};

// ==================== LOAD ONBOARDING LIST ====================
// reuse global onboardingListState defined above
const loadOnboardingList = async (searchQuery = '') => {
    const container = document.getElementById('onboarding-list-container');
    if (container) {
        container.innerHTML = '<div class="loading-spinner">Refreshing onboarding records...</div>';
    }
    // Reset state for new query
    onboardingListState.lastQuery = searchQuery;
    onboardingListState.all = [];
    onboardingSelection.clear();
    onboardingListState.rendered = 0;
    onboardingListState.pageSize = LIST_PAGE_SIZE;
    try {
        const response = await fetch(`${API_BASE}/onboarding?search=${encodeURIComponent(searchQuery)}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        const records = (data.success && Array.isArray(data.records)) ? data.records : [];
        if (records.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <i class="fa-solid fa-inbox empty-state-icon"></i>
                    <p class="empty-state-text">No onboarding records found.</p>
                </div>`;
            return;
        }
        onboardingListState.all = records;
        container.innerHTML = `
            <div class="employee-card-grid" id="onb-grid"></div>
            <div style="display:flex; justify-content:center; margin:16px 0;">
                <button id="onb-load-more" class="btn btn-light"><i class="fa-solid fa-plus"></i> Load more</button>
            </div>`;
        const loadMoreBtn = document.getElementById('onb-load-more');
        const appendBatch = () => {
            const gridEl = document.getElementById('onb-grid');
            const start = onboardingListState.rendered;
            const end = Math.min(start + onboardingListState.pageSize, onboardingListState.all.length);
            const slice = onboardingListState.all.slice(start, end);
            const html = slice.map(renderOnboardingCard).join('');
            gridEl.insertAdjacentHTML('beforeend', html);
            onboardingListState.rendered = end;
            updateRenderedCheckboxes();
            syncSelectAllCheckbox();
            if (onboardingListState.rendered >= onboardingListState.all.length) {
                loadMoreBtn?.setAttribute('disabled', 'disabled');
                loadMoreBtn?.classList.add('disabled');
                loadMoreBtn && (loadMoreBtn.innerHTML = '<i class="fa-solid fa-check"></i> All loaded');
            }
        };
        // Delegate checkbox changes
        const listEl = document.getElementById('onboarding-list-container');
        listEl?.addEventListener('change', (ev) => {
            const t = ev.target;
            if (t && t.classList && t.classList.contains('onb-select')) {
                const id = String(t.getAttribute('data-id'));
                if (t.checked) onboardingSelection.add(id); else onboardingSelection.delete(id);
                syncSelectAllCheckbox();
            }
        });
        loadMoreBtn?.addEventListener('click', appendBatch);
        // Render first batch quickly, then the next batch in a micro delay for responsiveness
        appendBatch();
        setTimeout(() => appendBatch(), 0);
    } catch (error) {
        console.error('Error loading onboarding records:', error);
        container.innerHTML = `
            <div class="error-state">
                <i class="fa-solid fa-exclamation-triangle error-state-icon"></i>
                <p class="error-state-text">Failed to load onboarding records.</p>
            </div>`;
    }
};

// ==================== SHOW ONBOARDING FORM ====================
const showOnboardingForm = async (recordId = null, forceStage = null) => {
    let record = null;

    if (recordId) {
        try {
            const response = await fetch(`${API_BASE}/onboarding/${recordId}`);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();
            if (data.success) {
                record = data.record;
                currentOnboardingRecord = record;
            } else {
                showToast(data.message || 'Failed to load onboarding record', 'error');
                window.location.hash = '#/onboarding';
                return;
            }
        } catch (error) {
            console.error('Error loading onboarding record:', error);
            showToast('Failed to load onboarding record', 'error');
            return;
        }
    }

    const currentStage = forceStage || (record ? getStageNumber(record.progress_step) : 1);

    const progressPercent = Math.min(100, Math.max(0, (currentStage - 1) * 25));
    document.getElementById('app-content').innerHTML = `
        <div class="page-header">
            <button class="btn btn-secondary" onclick="window.goBackToOnboardingList()">
                <i class="fa-solid fa-arrow-left"></i> Back to List
            </button>
            <h1>Employee Onboarding Process</h1>
        </div>

        <!-- Progress Stepper -->
        <div class="onboarding-stepper">
            ${renderStepper(currentStage, record)}
        </div>

        <!-- Linear Progress Bar -->
        <div class="progress-container">
            <div class="progress-fill" style="width:${progressPercent}%"></div>
        </div>

        <!-- Stage Content -->
        <div id="stage-content" class="stage-content">
            <div id="stage-1" class="card">
                ${renderStage1PersonalInfo(record, currentStage)}
            </div>
            <div id="stage-row-23" class="stage-row">
                <div id="stage-2" class="card">
                    ${renderStage2Interview(record, currentStage)}
                </div>
                <div id="stage-3" class="card">
                    ${renderStage3MailConfirmation(record, currentStage)}
                </div>
            </div>
            <div id="stage-4" class="card">
                ${renderStage4Onboarding(record, currentStage)}
            </div>
            <div id="stage-5" class="card">
                ${renderStage5Verification(record, currentStage)}
            </div>
        </div>
    `;

    attachStageEventListeners(1, record);
    attachStageEventListeners(2, record);
    attachStageEventListeners(3, record);
    attachStageEventListeners(4, record);
    attachStageEventListeners(5, record);

    // Handle floating labels for inputs with pre-filled values
    setTimeout(() => {
        document.querySelectorAll('.form-group input, .form-group textarea, .form-group select').forEach(input => {
            const hasValue = input.value && input.value.trim() !== '';
            if (hasValue || input.hasAttribute('readonly')) {
                input.classList.add('has-value');
            }
            // Listen for changes to update the class
            input.addEventListener('input', function () {
                if (this.value && this.value.trim() !== '') {
                    this.classList.add('has-value');
                } else {
                    this.classList.remove('has-value');
                }
            });
        });
    }, 0);

    if (forceStage) {
        const el = document.getElementById(`stage-${forceStage}`);
        if (el) {
            try { el.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (_) { }
        }
    }
};

// ==================== RENDER STEPPER ====================
const renderStepper = (currentStage, record) => {
    const stages = [
        { num: 1, label: 'Personal Information', icon: 'fa-user' },
        { num: 2, label: 'Scheduling Interview', icon: 'fa-calendar-check' },
        { num: 3, label: 'Offer Acceptance', icon: 'fa-envelope' },
        { num: 4, label: 'Onboarding', icon: 'fa-id-card' },
        { num: 5, label: 'Physical Document Verification', icon: 'fa-file-shield' }
    ];

    const tsFor = (stageNum) => {
        if (!record) return null;
        switch (stageNum) {
            case 1: return record.personal_updated_at || record.created_at;
            case 2: return record.mail_updated_at || record.interview_updated_at || record.interview_date;
            case 3: return record.mail_updated_at;
            case 4: return record.completed_at || record.doj;
            case 5: return record.document_updated_at;
            default: return null;
        }
    };
    const milestoneData = (() => {
        if (!record) return null;
        const mailResponded = !!record?.mail_reply && record.mail_reply !== 'Pending';
        const docsUploadedCount = (() => {
            const raw = record?.document_urls || '';
            try {
                const arr = Array.isArray(raw) ? raw : JSON.parse(raw || '[]');
                return Array.isArray(arr) ? arr.length : 0;
            } catch (_) {
                return 0;
            }
        })();
        const docsUploaded = docsUploadedCount > 0;
        const milestoneCompleted = (mailResponded ? 1 : 0) + (docsUploaded ? 1 : 0);
        const milestonePercent = (milestoneCompleted / 2) * 100;
        return { mailResponded, docsUploaded, milestonePercent, docsUploadedCount };
    })();

    const renderMilestoneConnector = (data) => {
        if (!data) return '<div class="stepper-line"></div>';
        return `
            <div class="stepper-line" style="position:relative; flex:1; height:6px; border-radius:999px; background:#e2e8f0;">
                <div style="height:100%; width:${data.milestonePercent}%; background:#16a34a; border-radius:999px;"></div>
                <div style="position:absolute; top:-26px; left:25%; transform:translate(-50%, 0); font-size:14px; color:${data.mailResponded ? '#065f46' : '#94a3b8'}; text-align:center; line-height:1;">
                    <i class="fa-solid fa-envelope"></i>
                </div>
                <div style="position:absolute; top:-26px; left:75%; transform:translate(-50%, 0); font-size:14px; color:${data.docsUploaded ? '#065f46' : '#94a3b8'}; text-align:center; line-height:1;">
                    <i class="fa-solid fa-file-arrow-up"></i>
                </div>
                <div style="position:absolute; top:50%; left:25%; transform:translate(-50%, -50%); width:12px; height:12px; border-radius:50%; border:2px solid ${data.mailResponded ? '#16a34a' : '#94a3b8'}; background:${data.mailResponded ? '#16a34a' : '#f8fafc'};"></div>
                <div style="position:absolute; top:50%; left:75%; transform:translate(-50%, -50%); width:12px; height:12px; border-radius:50%; border:2px solid ${data.docsUploaded ? '#16a34a' : '#94a3b8'}; background:${data.docsUploaded ? '#16a34a' : '#f8fafc'};"></div>
            </div>`;
    };

    return `
        <div class="stepper onboarding-main-stepper">
            ${stages.map((stage, index) => `
                <div class="stepper-item ${getStageStatus(record, stage.num, currentStage) === 'completed' ? 'completed' : ''} ${getStageStatus(record, stage.num, currentStage) === 'in_progress' ? 'active' : ''} ${canAccessStage(stage.num, record) ? '' : 'disabled'}" ${canAccessStage(stage.num, record) ? `onclick="window.scrollToStage(${stage.num})"` : ''} title="${canAccessStage(stage.num, record) ? stage.label : 'Locked'}">
                    ${(() => {
            const ts = tsFor(stage.num);
            return ts ? `<span class="stepper-label-ts">${fmt(ts)}</span>` : '<span class="stepper-label-ts stepper-label-ts-empty"></span>';
        })()}
                    <div class="stepper-circle">
                        ${getStageStatus(record, stage.num, currentStage) === 'completed' ? '<i class="fa-solid fa-check"></i>' : stage.num}
                    </div>
                    <div class="stepper-label">
                        <span class="stepper-label-main"><i class="fa-solid ${stage.icon}"></i>Stage ${stage.num} - ${stage.label}</span>
                    </div>
                </div>
                ${index < stages.length - 1 ? (stage.num === 2 ? renderMilestoneConnector(milestoneData) : '<div class="stepper-line"></div>') : ''}
            `).join('')}
        </div>
    `;
};

// ==================== RENDER STAGE CONTENT ====================
const renderStageContent = (stage, record, currentStage) => {
    switch (stage) {
        case 1:
            return renderStage1PersonalInfo(record, currentStage);
        case 2:
            return renderStage2Interview(record, currentStage);
        case 3:
            return renderStage3MailConfirmation(record, currentStage);
        case 4:
            return renderStage4DocumentVerification(record, currentStage);
        case 5:
            return renderStage5Completed(record, currentStage);
        default:
            return renderStage1PersonalInfo(record, currentStage);
    }
};

// ==================== STAGE 1: PERSONAL INFORMATION ====================
let stage1EditMode = false;
window.toggleStage1Edit = (on) => { try { stage1EditMode = !!on; showOnboardingForm(currentOnboardingRecord?.id || null, 1); } catch (_) { } };

const renderStage1PersonalInfo = (record, currentStage) => {
    const status = getStageStatus(record, 1, currentStage);
    const theme = getHeaderTheme(status);
    const hasRecord = !!record?.id;
    const headerClass = status === 'completed' ? 'stage-header stage-header-completed' : 'stage-header';

    // View (summary) mode for existing records unless editing
    if (hasRecord && !stage1EditMode) {
        const name = `${record?.firstname || ''} ${record?.lastname || ''}`.trim();
        return `
            <div class="${headerClass}">
                <h2><i class="fa-solid fa-user"></i> Stage 1 - Personal Information</h2>
            </div>
            <div class="card" style="margin-top:12px;">
                <p><strong>Name:</strong> ${name || '—'}</p>
                <p><strong>Email:</strong> ${record?.email || '—'}</p>
                <p><strong>Contact:</strong> ${record?.contact || '—'}</p>
                <p><strong>Address:</strong> ${record?.address || '—'}</p>
                <p><strong>Date of Joining:</strong> ${record?.doj || '—'}</p>
                <div class="form-actions" style="margin-top:16px;">
                    <button type="button" class="btn btn-secondary" onclick="window.toggleStage1Edit(true)">
                        <i class="fa-solid fa-pen"></i> Edit Personal Details
                    </button>
                </div>
            </div>
        `;
    }

    // Edit/create form (full fields)
    return `
        <div class="${headerClass}">
            <h2><i class="fa-solid fa-user"></i> Stage 1 - Personal Information</h2>
        </div>
        
        <form id="${hasRecord ? 'personal-info-edit-form' : 'personal-info-form'}" class="onboarding-form">
            <div class="form-row">
                <div class="form-group">
                    <input type="text" name="firstname" value="${record?.firstname || ''}" placeholder=" " required />
                    <label>First Name <span class="required">*</span></label>
                </div>
                <div class="form-group">
                    <input type="text" name="lastname" value="${record?.lastname || ''}" placeholder=" " required />
                    <label>Last Name <span class="required">*</span></label>
                </div>
            </div>

            <div class="form-row">
                <div class="form-group">
                    <input type="email" name="email" value="${record?.email || ''}" placeholder=" " required />
                    <label>Email <span class="required">*</span></label>
                </div>
                <div class="form-group">
                    <input type="tel" name="contact" value="${record?.contact || ''}" placeholder=" " required />
                    <label>Contact Number <span class="required">*</span></label>
                </div>
            </div>

            <div class="form-group">
                <textarea name="address" rows="3" placeholder=" " required>${record?.address || ''}</textarea>
                <label>Address <span class="required">*</span></label>
            </div>

            <div class="form-row">
                <div class="form-group">
                    <input type="text" name="department" value="${record?.department || ''}" placeholder=" " required />
                    <label>Department <span class="required">*</span></label>
                </div>
                <div class="form-group">
                    <input type="text" name="designation" value="${record?.designation || ''}" placeholder=" " required />
                    <label>Designation <span class="required">*</span></label>
                </div>
            </div>

            <div class="form-actions">
                <button type="submit" class="btn btn-primary">
                    <i class="fa-solid fa-save"></i> ${hasRecord ? 'Save Changes' : 'Save & Continue'}
                </button>
                ${hasRecord ? `
                <button type="button" class="btn btn-secondary" onclick="window.toggleStage1Edit(false)">
                    <i class="fa-solid fa-xmark"></i> Cancel
                </button>
                ` : ''}
            </div>
        </form>
    `;
};

// ==================== STAGE 2: SCHEDULING INTERVIEW ====================
const renderStage2Interview = (record, currentStage) => {
    const scheduled = !!record?.interview_date;
    const status = getStageStatus(record, 2, currentStage);
    const theme = getHeaderTheme(status);
    const allow = canAccessStage(2, record);
    const gateMsg = allow ? '' : '<div class="stage-gate-warning"><i class="fa-solid fa-lock"></i> Complete Personal Information to enable Scheduling Interview.</div>';
    const gateStyle = allow ? '' : 'opacity:.6; pointer-events:none;';
    const headerClass = status === 'completed' ? 'stage-header stage-header-completed' : 'stage-header';
    return `
        <div class="${headerClass}">
            <h2><i class="fa-solid fa-calendar-check"></i> Stage 2 - Scheduling Interview</h2>
        </div>
        ${gateMsg}
        
        <form id="schedule-interview-form" class="onboarding-form" style="${gateStyle}">
            <div class="form-row">
                <div class="form-group">
                    <input type="date" name="interview_date" value="${record?.interview_date || ''}" required />
                    <label>Interview Date <span class="required">*</span></label>
                </div>
                <div class="form-group">
                    <input type="time" name="interview_time" value="${record?.interview_time || ''}" required />
                    <label>Interview Time <span class="required">*</span></label>
                </div>
            </div>
            <div class="form-group">
                <input type="url" name="meet_link" value="${record?.meet_link || ''}" placeholder=" " />
                <label>Meet Link (optional)</label>
            </div>
            <div class="form-actions">
                <button type="submit" class="btn btn-primary"><i class="fa-solid fa-paper-plane"></i> Schedule Interview Email</button>
            </div>
        </form>

        <div class="card" style="margin-top:12px; ${gateStyle}">
            <h3>Interview Result</h3>
            <form id="interview-result-form" class="onboarding-form">
                <div class="form-row">
                    <div class="form-group">
                        <select name="interview_status" id="interview-status-select" ${scheduled ? '' : 'disabled'} required>
                            <option value="Pending" ${record?.interview_status === 'Pending' ? 'selected' : ''}>Pending</option>
                            <option value="Passed" ${record?.interview_status === 'Passed' ? 'selected' : ''}>Passed</option>
                            <option value="Failed" ${record?.interview_status === 'Failed' ? 'selected' : ''}>Failed</option>
                            <option value="Did Not Show Up" ${record?.interview_status === 'Did Not Show Up' ? 'selected' : ''}>Did Not Show Up</option>
                        </select>
                        <label>Result <span class="required">*</span></label>
                    </div>
                </div>
                <div class="form-actions">
                    <button type="submit" id="send-result-btn" class="btn btn-success" ${scheduled ? '' : 'disabled'}>
                        <i class="fa-solid fa-envelope"></i> Update Result & Send Mail
                    </button>
                </div>
            </form>
        </div>
    `;
};

// ==================== STAGE 3: OFFER ACCEPTANCE ====================
const renderStage3MailConfirmation = (record, currentStage) => {
    const mailAccepted = record?.mail_reply === 'Yes';
    const mailResponded = !!record?.mail_reply && record.mail_reply !== 'Pending';
    const docsUploadedCount = (() => {
        const raw = record?.document_urls || '';
        try {
            const arr = Array.isArray(raw) ? raw : JSON.parse(raw || '[]');
            return Array.isArray(arr) ? arr.length : 0;
        } catch (_) {
            return 0;
        }
    })();
    const docsUploaded = docsUploadedCount > 0;
    const status = getStageStatus(record, 3, currentStage);
    const theme = getHeaderTheme(status);
    const allow = canAccessStage(3, record);
    const canCheckEmail = allow && String(record?.mail_status || '').toLowerCase() === 'sent';
    const gateMsg = allow ? '' : '<div class="stage-gate-warning"><i class="fa-solid fa-lock"></i> Send offer letter in Stage 2 to enable Offer Acceptance.</div>';
    const gateStyle = allow ? '' : 'opacity:.6; pointer-events:none;';
    const headerClass = status === 'completed' ? 'stage-header stage-header-completed' : 'stage-header';
    return `
        <div class="${headerClass}">
            <h2><i class="fa-solid fa-envelope"></i> Stage 3 - Offer Acceptance</h2>
        </div>
        ${gateMsg}
        <div class="info-card">
            <h3>Stage 1 - Personal Information</h3>
            <p><strong>Name:</strong> ${record?.firstname || ''} ${record?.lastname || ''}</p>
            <p><strong>Email:</strong> ${record?.email || ''}</p>
            <p><strong>Mail Status:</strong> <span class="badge badge-${record?.mail_status === 'Sent' ? 'warning' : 'info'}">${record?.mail_status || 'Not Sent'}</span></p>
            <p><strong>Mail Reply:</strong> <span class="badge badge-${record?.mail_reply === 'Yes' ? 'success' : 'secondary'}">${record?.mail_reply || 'Pending'}</span></p>
            <div class="form-actions" style="margin-top:12px;">
                <button type="button" id="check-email-btn" class="btn btn-secondary" ${canCheckEmail ? '' : 'disabled'}>
                    <i class="fa-solid fa-inbox"></i> Check Email Reply
                </button>
            </div>
            <small style="display:block; margin-top:6px; color:#94a3b8;">
                ${canCheckEmail ? 'Click to pull the latest reply from the candidate inbox.' : 'Button will be enabled once the offer mail is sent.'}
            </small>
        </div>
        <div class="card" style="margin-top:20px; ${gateStyle}">
            <h3>Upload Documents</h3>
            <div class="form-group" style="display:flex; flex-direction:column; align-items:flex-start; gap:6px;">
                <input type="file" id="offer-document-upload" multiple accept=".pdf,.jpg,.jpeg,.png" ${mailAccepted ? '' : 'disabled'} />
                <small>${mailAccepted ? 'Select files to upload (PDF/JPG/PNG).' : 'Upload will be enabled once reply is Yes.'}</small>
            </div>
            <div class="form-actions">
                <button type="button" id="offer-upload-btn" class="btn btn-primary" ${mailAccepted ? '' : 'disabled'}>
                    <i class="fa-solid fa-upload"></i> Upload Documents
                </button>
            </div>
            <small style="display:block; margin-top:4px; font-weight:600; color:${docsUploaded ? '#16a34a' : '#dc2626'};">
                ${docsUploaded ? 'Documents uploaded' : 'No documents uploaded'}
            </small>
            ${docsUploaded ? '<small style="color:#64748b; margin-top:8px; display:block;">Uploading new files will replace existing documents.</small>' : ''}
        </div>
        ${mailAccepted ? `
            <div style="margin-top:20px; padding:16px; background:#dcfce7; border-left:4px solid #16a34a; border-radius:8px;">
                <p style="color:#166534; font-weight:600; margin:0;"><i class="fa-solid fa-check-circle"></i> Candidate accepted the offer! You can now proceed to Onboarding.</p>
                <button class="btn btn-success" style="margin-top:12px;" onclick="window.gotoOnboardingStage(4)">
                    <i class="fa-solid fa-arrow-right"></i> Proceed to Onboarding
                </button>
            </div>
        ` : ''}
    `;
};

// ==================== STAGE 4: ONBOARDING ====================
const renderStage4Onboarding = (record, currentStage) => {
    const status = getStageStatus(record, 4, currentStage);
    const theme = getHeaderTheme(status);
    const allow = canAccessStage(4, record);
    const gateMsg = allow ? '' : '<div class="stage-gate-warning"><i class="fa-solid fa-lock"></i> Complete Offer Acceptance to enable Onboarding.</div>';
    const gateStyle = allow ? '' : 'opacity:.6; pointer-events:none;';
    const docsUploaded = hasUploadedDocuments(record);
    const hasDOJ = !!record?.doj;
    const canOnboardNow = docsUploaded && hasDOJ;
    const headerClass = status === 'completed' ? 'stage-header stage-header-completed' : 'stage-header';
    return `
        <div class="${headerClass}">
            <h2><i class="fa-solid fa-id-card"></i> Stage 4 - Onboarding</h2>
        </div>
        ${gateMsg}

        <form id="doj-policy-form" class="onboarding-form" style="margin-top:12px; ${gateStyle}">
            <div class="form-group">
                <input type="date" name="doj" id="doj-input" value="${record?.doj || ''}" ${docsUploaded ? '' : 'disabled'} required />
                <label>Date of Joining <span class="required">*</span></label>
                <small style="color:#94a3b8;">DOJ will be saved when you send the onboarding mail.</small>
            </div>
            <div class="form-actions">
                <button type="submit" class="btn btn-primary" ${docsUploaded ? '' : 'disabled'}>
                    <i class="fa-solid fa-paper-plane"></i> Send Onboarding Mail
                </button>
            </div>
        </form>

        <div class="form-actions" style="margin-top:16px; ${gateStyle}">
            <button type="button" class="btn btn-success" id="verify-documents-btn" ${canOnboardNow ? '' : 'disabled'}>
                <i class="fa-solid fa-circle-check"></i> Onboard & Create Employee
            </button>
        </div>
    `;
};

// ==================== STAGE 5: PHYSICAL DOCUMENT VERIFICATION ====================
const renderStage5Verification = (record, currentStage) => {
    const status = getStageStatus(record, 5, currentStage);
    const theme = getHeaderTheme(status);
    const allow = canAccessStage(5, record);
    const gateMsg = allow ? '' : '<div class="stage-gate-warning"><i class="fa-solid fa-lock"></i> Complete onboarding to start physical verification.</div>';
    const gateStyle = allow ? '' : 'opacity:.6; pointer-events:none;';
    const headerClass = status === 'completed' ? 'stage-header stage-header-completed' : 'stage-header';

    // If status was already set before (Verified / Not Verified), always allow editing
    const isPendingStatus = !record?.document_status || record.document_status === 'Pending';
    if (!isPendingStatus) {
        stage5DocsEnabled = true;
    }
    const selectDisabledAttr = (!stage5DocsEnabled && isPendingStatus) ? 'disabled' : '';

    return `
        <div class="${headerClass}">
            <h2><i class="fa-solid fa-file-shield"></i> Stage 5 - Physical Document Verification</h2>
        </div>
        ${gateMsg}

        <div class="card" style="margin-top:12px; ${gateStyle}">
            <h3>Physical Documents Mail</h3>
            <p style="margin:6px 0; color:#64748b;">Send an email asking the candidate to courier their physical documents.</p>
            <div class="form-actions">
                <button type="button" class="btn btn-primary" id="send-docs-mail-btn">
                    <i class="fa-solid fa-envelope"></i> Send Documents Mail
                </button>
                <button type="button" class="btn btn-secondary" id="check-docs-mail-btn">
                    <i class="fa-solid fa-sync"></i> Check Mail Reply
                </button>
            </div>
            <p style="margin-top:8px; color:#64748b;">
                Mail Status:
                <span
                    id="docs-mail-status-text"
                    style="font-weight:600; color:${stage5DocsEnabled ? '#16a34a' : '#64748b'};"
                >
                    ${stage5DocsEnabled ? 'Reply received: Yes, sent' : 'Not sent / awaiting reply'}
                </span>
            </p>
        </div>

        <form id="document-status-form" class="onboarding-form" style="margin-top:12px; ${gateStyle}">
            <div class="form-row">
                <div class="form-group">
                    <select name="document_status" id="document-status-select" ${selectDisabledAttr}>
                        <option value="Pending" ${record?.document_status === 'Pending' ? 'selected' : ''}>Pending</option>
                        <option value="Verified" ${record?.document_status === 'Verified' ? 'selected' : ''}>Verified</option>
                        <option value="Not Verified" ${record?.document_status === 'Not Verified' ? 'selected' : ''}>Not Verified</option>
                    </select>
                    <label>Physical Verification Status</label>
                </div>
            </div>
            <div class="form-actions">
                <button type="submit" class="btn btn-primary"><i class="fa-solid fa-save"></i> Save Verification</button>
            </div>
        </form>

        <div class="form-actions" style="margin-top:16px; ${gateStyle}">
            <button type="button" class="btn btn-secondary" onclick="window.goBackToOnboardingList()"><i class="fa-solid fa-arrow-left"></i> Back to List</button>
        </div>
    `;
};

// ==================== ATTACH EVENT LISTENERS ====================
const attachStageEventListeners = (stage, record) => {
    // Stop Stage 3 polling unless we are on Stage 3 (we'll restart it below if needed)
    if (stage !== 3) stopStage3Polling();
    switch (stage) {
        case 1:
            document.getElementById('personal-info-form')?.addEventListener('submit', handleStage1Submit);
            document.getElementById('personal-info-edit-form')?.addEventListener('submit', handleStage1UpdateSubmit);
            break;
        case 2:
            document.getElementById('schedule-interview-form')?.addEventListener('submit', handleScheduleInterviewSubmit);
            document.getElementById('interview-result-form')?.addEventListener('submit', handleCombinedResultSubmit);
            break;
        case 3:
            document.getElementById('check-email-btn')?.addEventListener('click', handleCheckEmail);
            document.getElementById('offer-upload-btn')?.addEventListener('click', handleStage3Upload);
            // Start polling for email reply while Pending
            startStage3Polling(record);
            break;
        case 4:
            document.getElementById('verify-documents-btn')?.addEventListener('click', handleStage4Verify);
            document.getElementById('doj-policy-form')?.addEventListener('submit', handleDOJPolicySubmit);
            break;
        case 5:
            document.getElementById('document-status-form')?.addEventListener('submit', handleDocumentStatusSubmit);
            document.getElementById('send-docs-mail-btn')?.addEventListener('click', handleSendDocumentsMail);
            document.getElementById('check-docs-mail-btn')?.addEventListener('click', handleCheckDocumentsMail);
            break;
    }
};

// ==================== STAGE 5: DOCUMENT MAIL HANDLERS ====================
const handleSendDocumentsMail = async () => {
    if (!currentOnboardingRecord?.id) {
        showToast('No onboarding record found', 'error');
        return;
    }

    const btn = document.getElementById('send-docs-mail-btn');
    if (!btn) return;
    const original = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Sending...';

    try {
        const res = await fetch(`${API_BASE}/onboarding/${currentOnboardingRecord.id}/send-documents-mail`, {
            method: 'POST'
        });
        const json = await res.json().catch(() => ({ success: false }));
        if (!res.ok || !json.success) throw new Error(json.message || `HTTP ${res.status}`);

        const statusSpan = document.getElementById('docs-mail-status-text');
        if (statusSpan) {
            statusSpan.textContent = 'Mail sent - awaiting reply';
            statusSpan.style.color = '#64748b';
        }
        stage5DocsEnabled = false;
        showToast(json.message || 'Documents mail sent', 'success');
    } catch (err) {
        console.error('Send documents mail failed', err);
        showToast('Failed to send documents mail', 'error');
    } finally {
        btn.disabled = false;
        btn.innerHTML = original;
    }
};

const handleCheckDocumentsMail = async () => {
    if (!currentOnboardingRecord?.id) {
        showToast('No onboarding record found', 'error');
        return;
    }

    const btn = document.getElementById('check-docs-mail-btn');
    if (!btn) return;
    const original = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Checking...';

    try {
        const res = await fetch(`${API_BASE}/onboarding/${currentOnboardingRecord.id}/check-documents-email`);
        const json = await res.json().catch(() => ({ success: false }));

        const statusSpan = document.getElementById('docs-mail-status-text');

        if (json.success && (json.reply === 'YesSent' || json.reply === 'Yes')) {
            stage5DocsEnabled = true;
            if (statusSpan) {
                statusSpan.textContent = 'Reply received: Yes, sent';
                statusSpan.style.color = '#16a34a';
            }
            const sel = document.getElementById('document-status-select');
            if (sel) sel.disabled = false;
            showToast('Candidate confirmed documents have been sent. You can now verify them.', 'success');
        } else {
            if (statusSpan && !stage5DocsEnabled) {
                statusSpan.textContent = 'No "Yes, sent" reply found yet';
                statusSpan.style.color = '#64748b';
            }
            showToast((json && json.message) || 'No documents reply found yet', 'info');
        }
    } catch (err) {
        console.error('Check documents mail failed', err);
        showToast('Failed to check documents mail', 'error');
    } finally {
        btn.disabled = false;
        btn.innerHTML = original;
    }
};

// ==================== STAGE 1 SUBMIT ====================
const handleStage1Submit = async (e) => {
    e.preventDefault();
    const formData = new FormData(e.target);
    const data = Object.fromEntries(formData.entries());

    try {
        const response = await fetch(`${API_BASE}/onboarding`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });

        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const result = await response.json();

        if (result.success) {
            showToast('Personal information saved successfully!', 'success');
            currentOnboardingRecord = result.record;
            // Immediately move to next process page (Stage 2)
            showOnboardingForm(result.record.id, 2);
        } else {
            showToast(result.message || 'Failed to save information', 'error');
        }
    } catch (error) {
        console.error('Error saving personal info:', error);
        showToast('Failed to save information', 'error');
    }
};

// ==================== STAGE 2 HANDLERS ====================
const handleScheduleInterviewSubmit = async (e) => {
    e.preventDefault();
    const formData = new FormData(e.target);
    const data = Object.fromEntries(formData.entries());

    if (!currentOnboardingRecord?.id) {
        showToast('No onboarding record found', 'error');
        return;
    }

    try {
        const res = await fetch(`${API_BASE}/onboarding/${currentOnboardingRecord.id}/schedule-interview`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
        const json = await res.json();
        if (!res.ok || !json.success) throw new Error(json.message || `HTTP ${res.status}`);
        showToast('Interview email scheduled!', 'success');
        setTimeout(() => showOnboardingForm(currentOnboardingRecord.id, 2), 800);
    } catch (err) {
        console.error('Schedule interview failed', err);
        showToast('Failed to schedule interview email', 'error');
    }
};

const handleInterviewResultSubmit = async (e) => {
    e.preventDefault();
    const formData = new FormData(e.target);
    const data = Object.fromEntries(formData.entries());

    if (!currentOnboardingRecord?.id) {
        showToast('No onboarding record found', 'error');
        return;
    }
    try {
        const res = await fetch(`${API_BASE}/onboarding/${currentOnboardingRecord.id}/interview`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
        const json = await res.json();
        if (!res.ok || !json.success) throw new Error(json.message || `HTTP ${res.status}`);
        showToast('Interview result updated', 'success');
        setTimeout(() => showOnboardingForm(currentOnboardingRecord.id, 2), 800);
    } catch (err) {
        console.error('Update interview result failed', err);
        showToast('Failed to update interview result', 'error');
    }
};

// Combined handler: Update Result & Send Mail (single button for Stage 2)
const handleCombinedResultSubmit = async (e) => {
    e.preventDefault();
    const formData = new FormData(e.target);
    const data = Object.fromEntries(formData.entries());
    const interviewStatus = data.interview_status;

    if (!currentOnboardingRecord?.id) {
        showToast('No onboarding record found', 'error');
        return;
    }

    const btn = document.getElementById('send-result-btn');
    const original = btn ? btn.innerHTML : '';
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Processing...';
    }

    try {
        // Call combined endpoint that updates status and sends appropriate email
        const res = await fetch(`${API_BASE}/onboarding/${currentOnboardingRecord.id}/update-result-send-mail`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ interview_status: interviewStatus })
        });
        const json = await res.json();
        if (!res.ok || !json.success) throw new Error(json.message || `HTTP ${res.status}`);

        // Show appropriate message based on result
        if (interviewStatus === 'Passed') {
            showToast('Result updated & Offer letter sent!', 'success');
            setTimeout(() => showOnboardingForm(currentOnboardingRecord.id, 3), 800);
        } else if (interviewStatus === 'Failed') {
            showToast('Result updated & Rejection email sent.', 'info');
            setTimeout(() => showOnboardingForm(currentOnboardingRecord.id, 2), 800);
        } else {
            showToast('Interview result updated.', 'success');
            setTimeout(() => showOnboardingForm(currentOnboardingRecord.id, 2), 800);
        }
    } catch (err) {
        console.error('Combined result/mail failed', err);
        showToast('Failed to update result', 'error');
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = original;
        }
    }
};

// ==================== STAGE 3 SUBMIT ====================
const handleStage3Submit = async (e) => {
    e.preventDefault();
    const formData = new FormData(e.target);
    const data = Object.fromEntries(formData.entries());

    if (!currentOnboardingRecord?.id) {
        showToast('No onboarding record found', 'error');
        return;
    }

    try {
        const response = await fetch(`${API_BASE}/onboarding/${currentOnboardingRecord.id}/mail-reply`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });

        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const result = await response.json();

        if (result.success) {
            const reply = data.mail_reply;
            if (reply === 'Yes') {
                showToast('Candidate accepted! You can now proceed to Document Verification.', 'success');
            } else if (reply === 'No') {
                showToast('Candidate declined the offer.', 'info');
            } else {
                showToast('Mail response updated successfully!', 'success');
            }
            setTimeout(() => showOnboardingForm(currentOnboardingRecord.id), 1000);
        } else {
            showToast(result.message || 'Failed to update mail response', 'error');
        }
    } catch (error) {
        console.error('Error updating mail response:', error);
        showToast('Failed to update mail response', 'error');
    }
};

// ==================== CHECK EMAIL ====================
const handleCheckEmail = async () => {
    if (!currentOnboardingRecord?.id) {
        showToast('No onboarding record found', 'error');
        return;
    }

    // Show loading state
    const checkBtn = document.getElementById('check-email-btn');
    const originalText = checkBtn.innerHTML;
    checkBtn.disabled = true;
    checkBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Checking...';

    try {
        const response = await fetch(`${API_BASE}/onboarding/${currentOnboardingRecord.id}/check-email`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const result = await response.json();

        if (result.success) {
            const reply = (result && (result.reply || (result.data && result.data.reply))) || '';
            const replyUC = String(reply || '').trim();
            if (replyUC === 'Yes' || replyUC === 'No') {
                try {
                    await fetch(`${API_BASE}/onboarding/${currentOnboardingRecord.id}/mail-reply`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ mail_reply: replyUC })
                    });
                } catch (_) { }
            }
            if (replyUC === 'Yes') {
                showToast('✅ Candidate accepted the offer! You can now proceed to Document Verification.', 'success');
            } else if (replyUC === 'No') {
                showToast('❌ Candidate declined the offer.', 'info');
            } else {
                showToast(result.message || 'Email checked successfully!', 'success');
            }
            setTimeout(() => showOnboardingForm(currentOnboardingRecord.id, 3), 1000);
        } else {
            showToast(result.message || 'No reply found yet', 'info');
            checkBtn.disabled = false;
            checkBtn.innerHTML = originalText;
        }
    } catch (error) {
        console.error('Error checking email:', error);
        showToast('Failed to check email. Please try again.', 'error');
        checkBtn.disabled = false;
        checkBtn.innerHTML = originalText;
    }
};

// ==================== STAGE 4 VERIFY ====================
const handleStage4Verify = async () => {
    if (!currentOnboardingRecord?.id) {
        showToast('No onboarding record found', 'error');
        return;
    }

    if (!confirm('Are you sure you want to onboard this candidate? This will create an employee record.')) {
        return;
    }

    try {
        // Call verify endpoint to create employee and move to physical verification stage
        const response = await fetch(`${API_BASE}/onboarding/${currentOnboardingRecord.id}/verify`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' }
        });

        if (!response.ok) {
            showToast('Onboarding failed. Please try again.', 'error');
            return;
        }
        const result = await response.json();

        if (result.success) {
            if (result.already_exists) {
                showToast(result.message || 'Already exist', 'info');
            } else {
                showToast(result.message || 'Onboarding complete! Employee created successfully!', 'success');
            }
            setTimeout(() => showOnboardingForm(currentOnboardingRecord.id, 5), 1500);
        } else {
            showToast('Onboarding failed. Please try again.', 'error');
        }
    } catch (error) {
        console.error('Error verifying documents:', error);
        showToast('Onboarding failed. Please try again.', 'error');
    }
};

// ==================== HELPER FUNCTIONS ====================
const getStageNumber = (progressStep) => {
    const stageMap = {
        'Personal Information': 1,
        'Scheduling Interview': 2,
        'Offer Acceptance': 3,
        'Onboarding': 4,
        'Physical Document Verification': 5,
        'Document Verification': 5, // backward compatibility for older label
        'Completed': 5
    };
    return stageMap[progressStep] || 1;
};

const getStageColor = (stage) => {
    const colorMap = {
        'Personal Information': 'secondary',
        'Scheduling Interview': 'info',
        'Offer Acceptance': 'warning',
        'Physical Document Verification': 'primary',
        'Onboarding': 'success',
        // backward compatibility
        'Interview Scheduled': 'info',
        'Mail Confirmation': 'warning',
        'Document Verification': 'primary',
        'Completed': 'success'
    };
    return colorMap[stage] || 'secondary';
};

const getStatusColor = (docStatus, mailStatus, record) => {
    // Strong red for pending/failure, green for completed
    if (docStatus === 'Verified') return 'success';
    if (record?.mail_reply === 'No' || record?.interview_status === 'Failed') return 'danger';
    if (record?.mail_reply === 'Yes') return 'warning';
    if (mailStatus === 'Sent') return 'warning';
    return 'danger';
};

const getStatusText = (record) => {
    if (record.document_status === 'Verified') return 'Completed';
    if (record.mail_reply === 'Yes') return 'Documents Pending';
    if (record.mail_reply === 'No') return 'Declined';
    if (record.mail_status === 'Sent') return 'Awaiting Reply';
    if (record.interview_status === 'Failed') return 'Interview Failed';
    if (record.interview_status === 'Passed') return 'Offer Sent';
    if (record.interview_status === 'Pending') return 'Interview Pending';
    return 'In Progress';
};

const showToast = (message, type = 'info') => {
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.innerHTML = `
        <i class="fa-solid fa-${type === 'success' ? 'check-circle' : type === 'error' ? 'exclamation-circle' : 'info-circle'}"></i>
        <span>${message}</span>
    `;
    document.body.appendChild(toast);

    setTimeout(() => {
        toast.classList.add('show');
    }, 100);

    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    }, 3000);
};

// Helper: Overview cards renderer
const renderOverviewCards = (record) => {
    const ok = (v) => String(v || '').trim().length > 0;
    const currentStage = getStageNumber(record?.progress_step);

    const personalDone = ok(record?.firstname) && ok(record?.lastname) && ok(record?.email) && ok(record?.contact) && ok(record?.address) && ok(record?.department) && ok(record?.designation);
    const interviewScheduled = ok(record?.interview_date);
    const interviewPassed = record?.interview_status === 'Passed';
    const interviewFinalized = ['Passed', 'Failed', 'Did Not Show Up'].includes(record?.interview_status || '');
    const mailSent = record?.mail_status === 'Sent';
    const mailYes = record?.mail_reply === 'Yes';
    const docsDone = record?.document_status === 'Verified';
    const completed = record?.progress_step === 'Completed' || docsDone;

    const statusOf = (stageNum) => {
        switch (stageNum) {
            case 1: return personalDone ? 'Completed' : (currentStage === 1 ? 'In Progress' : 'Pending');
            case 2: return interviewFinalized ? 'Completed' : ((interviewScheduled || currentStage === 2) ? 'In Progress' : 'Pending');
            case 3: return mailYes ? 'Completed' : ((mailSent || currentStage === 3) ? 'In Progress' : 'Pending');
            case 4: return docsDone ? 'Completed' : (currentStage === 4 ? 'In Progress' : 'Pending');
            case 5: return completed ? 'Completed' : (currentStage === 5 ? 'In Progress' : 'Pending');
            default: return 'Pending';
        }
    };

    const card = (title, icon, stageNum) => {
        const label = statusOf(stageNum).toUpperCase();
        return `
        <div class="card" style="padding:14px; border:1px solid #e5e7eb; background:#fff; cursor:pointer;" onclick="window.gotoOnboardingStage(${stageNum})" title="Go to ${title}">
            <div style="display:flex; align-items:center; gap:10px;">
                <div style="width:36px; height:36px; border-radius:8px; background:#f8fafc; display:flex; align-items:center; justify-content:center; color:#475569">
                    <i class="fa-solid ${icon}"></i>
                </div>
                <div style="flex:1">
                    <div style="font-weight:600; color:#0f172a;">${title}</div>
                    <div><span class="badge badge-secondary">${label}</span></div>
                </div>
            </div>
        </div>`
    };

    return [
        card('Personal Information', 'fa-user', 1),
        card('Scheduling Interview', 'fa-calendar-check', 2),
        card('Offer Acceptance', 'fa-envelope', 3),
        card('Physical Document Verification', 'fa-file', 4),
        card('Onboarding', 'fa-check-circle', 5)
    ].join('');
};

// Make functions globally accessible
window.viewOnboardingRecord = (recordId) => showOnboardingForm(recordId);
window.goBackToOnboardingList = () => renderOnboardingPage();
window.gotoOnboardingStage = (stageNum) => {
    try {
        if (currentOnboardingRecord?.id) {
            showOnboardingForm(currentOnboardingRecord.id, stageNum);
        } else {
            // If no current record, just render the form at that stage for a new record
            showOnboardingForm(null, stageNum);
        }
    } catch (e) {
        console.error('Failed to navigate to stage', stageNum, e);
    }
};
window.openOnboardingDetails = (recordId) => openOnboardingDetails(recordId);
window.gotoRecordStage = (recordId, stage) => gotoRecordStage(recordId, stage);
window.scrollToStage = (stageNum) => {
    try {
        const el = document.getElementById(`stage-${stageNum}`);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) {
        console.error('Failed to scroll to stage', stageNum, e);
    }
};
