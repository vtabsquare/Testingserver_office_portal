/**
 * FaceAuth Re-Verification Alert System
 * 
 * Shows persistent alerts when face re-verification is due.
 * Timer is based on JWT `iat` (issued at) timestamp.
 * States: verified, due_soon, overdue, missed
 * 
 * Features:
 * - Blocking overlay prevents app interaction until verified
 * - Tab title notification flashes when alert is active
 * - Missed alert auto-hides after 15 minutes
 */

import { state } from '../state.js';

// Configuration - PRODUCTION VALUES
const REVERIFY_INTERVAL_MS = 2 * 60 * 60 * 1000; // 2 hours in production
const WARNING_THRESHOLD_MS = 15 * 60 * 1000;     // Show warning 15 min before due
const MISSED_THRESHOLD_MS = 30 * 60 * 1000;      // Mark as "missed" 30 min after due
const MISSED_AUTO_HIDE_MS = 15 * 60 * 1000;      // Auto-hide missed alert after 15 min
const CHECK_INTERVAL_MS = 60 * 1000;             // Check every 1 minute

// TESTING MODE - 1 minute cycle (uncomment for testing)
// const REVERIFY_INTERVAL_MS = 1 * 60 * 1000;      // 1 minute for testing
// const WARNING_THRESHOLD_MS = 15 * 1000;          // Show warning 15 seconds before due
// const MISSED_THRESHOLD_MS = 30 * 1000;           // Mark as "missed" 30 seconds after due
// const MISSED_AUTO_HIDE_MS = 2 * 60 * 1000;       // Auto-hide missed alert after 2 min (testing)
// const CHECK_INTERVAL_MS = 5 * 1000;              // Check every 5 seconds for faster testing

// FaceAuth URL (should match backend config)
const FACEAUTH_VERIFY_URL = 'https://biometrics.vtabsquare.com/external-verify';

// Feature flag: allow enabling/disabling alerts without code edits.
// Defaults to enabled in production builds.
function _isFaceAuthAlertsEnabled() {
    try {
        const v = (typeof import.meta !== 'undefined' && import.meta.env)
            ? (import.meta.env.VITE_FACEAUTH_ALERTS_ENABLED || import.meta.env.VITE_FACEAUTH_REVERIFY_ALERTS_ENABLED)
            : null;
        if (v === undefined || v === null || v === '') return true;
        return String(v).trim().toLowerCase() !== 'false' && String(v).trim() !== '0';
    } catch {
        return true;
    }
}

// Module state
let checkIntervalId = null;
let titleFlashIntervalId = null;
let alertElement = null;
let overlayElement = null;
let currentStatus = 'verified';
let lastNotifiedStatus = null; // Track which status we last sent notification for
let originalTitle = '';
let isBlockingEnabled = false;
let notificationPermission = 'default';
let serviceWorkerRegistration = null;

/**
 * Decode JWT payload without verification (just reading claims)
 */
function decodeJwtPayload(token) {
    if (!token || typeof token !== 'string') return null;
    try {
        const parts = token.split('.');
        if (parts.length !== 3) return null;
        const payload = JSON.parse(atob(parts[1]));
        return payload;
    } catch (e) {
        console.warn('[FACEAUTH-ALERT] Failed to decode JWT:', e);
        return null;
    }
}

function isFaceAuthRequiredForCurrentUser() {
    const token = localStorage.getItem('face_auth_token');
    if (!token) return true;

    const payload = decodeJwtPayload(token);
    if (!payload) return true;

    return payload.face_auth_required !== false;
}

/**
 * Get the last verification timestamp
 * Priority: localStorage last_face_verified_at > JWT last_verified > JWT iat
 */
function getLastVerifiedTimestamp() {
    // First check localStorage for explicit verification timestamp (set on callback)
    const storedTimestamp = localStorage.getItem('last_face_verified_at');
    if (storedTimestamp) {
        const parsed = parseInt(storedTimestamp, 10);
        if (!isNaN(parsed) && parsed > 0) {
            return parsed;
        }
    }
    
    // Fall back to JWT token timestamp
    const token = localStorage.getItem('face_auth_token');
    if (!token) return null;
    
    const payload = decodeJwtPayload(token);
    if (!payload) return null;
    
    // Use `last_verified` if available, otherwise fall back to `iat`
    const timestamp = payload.last_verified || payload.iat;
    if (!timestamp) return null;
    
    // Convert to milliseconds if in seconds
    return timestamp < 10000000000 ? timestamp * 1000 : timestamp;
}

/**
 * Calculate verification status
 * Returns: { status, remainingMs, elapsedMs, lastVerified }
 */
export function checkFaceAuthStatus() {
    if (!isFaceAuthRequiredForCurrentUser()) {
        return {
            status: 'disabled',
            remainingMs: 0,
            elapsedMs: 0,
            overdueMs: 0,
            lastVerified: null
        };
    }

    const lastVerified = getLastVerifiedTimestamp();
    
    if (!lastVerified) {
        return { 
            status: 'unknown', 
            remainingMs: 0, 
            elapsedMs: 0, 
            lastVerified: null 
        };
    }
    
    const now = Date.now();
    const elapsedMs = now - lastVerified;
    const remainingMs = REVERIFY_INTERVAL_MS - elapsedMs;
    const overdueMs = -remainingMs; // How long past due
    
    let status;
    if (remainingMs > WARNING_THRESHOLD_MS) {
        status = 'verified';
    } else if (remainingMs > 0) {
        status = 'due_soon';
    } else if (overdueMs < MISSED_THRESHOLD_MS) {
        status = 'overdue';
    } else {
        status = 'missed';
    }
    
    return {
        status,
        remainingMs: Math.max(0, remainingMs),
        elapsedMs,
        overdueMs: Math.max(0, overdueMs),
        lastVerified: new Date(lastVerified)
    };
}

/**
 * Format time remaining/overdue for display
 */
function formatTime(ms) {
    const totalSeconds = Math.floor(Math.abs(ms) / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    
    if (hours > 0) {
        return `${hours}h ${minutes}m`;
    } else if (minutes > 0) {
        return `${minutes}m ${seconds}s`;
    } else {
        return `${seconds}s`;
    }
}

/**
 * Create the alert banner element
 */
function createAlertElement() {
    // Check if element exists AND is still in the DOM
    if (alertElement && document.body.contains(alertElement)) {
        return alertElement;
    }
    
    // Reset if element was removed from DOM
    alertElement = null;
    
    alertElement = document.createElement('div');
    alertElement.id = 'faceauth-alert-banner';
    alertElement.className = 'faceauth-alert-banner';
    alertElement.innerHTML = `
        <div class="faceauth-alert-content">
            <div class="faceauth-alert-icon">
                <i class="fa-solid fa-expand"></i>
            </div>
            <div class="faceauth-alert-text">
                <span class="faceauth-alert-title">Face Verification Required</span>
                <span class="faceauth-alert-subtitle"></span>
            </div>
            <button class="faceauth-alert-btn" id="faceauth-verify-btn">
                <i class="fa-solid fa-camera"></i>
                <span>Verify Now</span>
            </button>
        </div>
    `;
    
    // Add click handler for verify button
    alertElement.querySelector('#faceauth-verify-btn').addEventListener('click', redirectToFaceAuth);
    
    // Insert into document.body (NOT main-content) so it persists across module navigation
    document.body.appendChild(alertElement);
    
    return alertElement;
}

/**
 * Create blocking overlay that prevents interaction with the app
 */
function createBlockingOverlay() {
    // Check if element exists AND is still in the DOM
    if (overlayElement && document.body.contains(overlayElement)) {
        return overlayElement;
    }
    
    // Reset if element was removed from DOM
    overlayElement = null;
    
    overlayElement = document.createElement('div');
    overlayElement.id = 'faceauth-blocking-overlay';
    overlayElement.className = 'faceauth-blocking-overlay';
    
    document.body.appendChild(overlayElement);
    return overlayElement;
}

/**
 * Show/hide blocking overlay
 */
function setBlockingOverlay(show) {
    if (show && !overlayElement) {
        createBlockingOverlay();
    }
    
    if (overlayElement) {
        overlayElement.classList.toggle('active', show);
        isBlockingEnabled = show;
    }
}

/**
 * Start flashing tab title notification
 */
function startTitleFlash(message) {
    if (titleFlashIntervalId) return; // Already flashing
    
    originalTitle = document.title;
    let showAlert = true;
    
    titleFlashIntervalId = setInterval(() => {
        document.title = showAlert ? `🔴 ${message}` : originalTitle;
        showAlert = !showAlert;
    }, 1000);
}

/**
 * Stop flashing tab title and restore original
 */
function stopTitleFlash() {
    if (titleFlashIntervalId) {
        clearInterval(titleFlashIntervalId);
        titleFlashIntervalId = null;
    }
    if (originalTitle) {
        document.title = originalTitle;
    }
}

/**
 * Request notification permission from user
 */
export async function requestNotificationPermission() {
    if (!('Notification' in window)) {
        console.warn('[FACEAUTH-ALERT] Browser does not support notifications');
        return 'denied';
    }
    
    console.log('[FACEAUTH-ALERT] Current notification permission:', Notification.permission);
    
    if (Notification.permission === 'granted') {
        notificationPermission = 'granted';
        return 'granted';
    }
    
    if (Notification.permission !== 'denied') {
        try {
            const permission = await Notification.requestPermission();
            notificationPermission = permission;
            console.log('[FACEAUTH-ALERT] Notification permission result:', permission);
            return permission;
        } catch (e) {
            console.warn('[FACEAUTH-ALERT] Failed to request notification permission:', e);
            return 'denied';
        }
    }
    
    notificationPermission = Notification.permission;
    return Notification.permission;
}

/**
 * Register service worker for background notifications
 */
async function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) {
        console.warn('[FACEAUTH-ALERT] Service workers not supported');
        return null;
    }
    
    try {
        const registration = await navigator.serviceWorker.register('/sw-faceauth.js');
        console.log('[FACEAUTH-ALERT] Service worker registered:', registration.scope);
        serviceWorkerRegistration = registration;
        return registration;
    } catch (e) {
        console.warn('[FACEAUTH-ALERT] Service worker registration failed:', e);
        return null;
    }
}

/**
 * Test notification - call from console: window.testFaceAuthNotification()
 */
window.testFaceAuthNotification = async function() {
    console.log('[FACEAUTH-ALERT] Testing notification...');
    console.log('[FACEAUTH-ALERT] Browser permission:', Notification.permission);
    
    if (Notification.permission === 'default') {
        console.log('[FACEAUTH-ALERT] Requesting permission...');
        const perm = await Notification.requestPermission();
        console.log('[FACEAUTH-ALERT] Permission result:', perm);
        if (perm !== 'granted') {
            alert('Please allow notifications in your browser settings');
            return;
        }
    }
    
    if (Notification.permission !== 'granted') {
        alert('Notifications are blocked. Please enable them in browser settings:\n\nClick the 🔒 icon in the address bar → Site settings → Notifications → Allow');
        return;
    }
    
    try {
        const notification = new Notification('🔔 Test Notification', {
            body: 'Face verification notifications are working!',
            icon: '/favicon.ico',
            tag: 'faceauth-test'
        });
        console.log('[FACEAUTH-ALERT] Test notification created successfully');
    } catch (e) {
        console.error('[FACEAUTH-ALERT] Failed to create notification:', e);
        alert('Failed to create notification: ' + e.message);
    }
};

// Track last notification time to allow repeated notifications for critical states
let lastNotificationTime = 0;
const REPEAT_NOTIFICATION_INTERVAL = 30 * 1000; // Repeat critical notifications every 30 seconds

/**
 * Show browser push notification
 * Made robust to show notifications regardless of tab state
 */
function showPushNotification(status, remainingMs, overdueMs) {
    // Check actual browser permission
    const browserPermission = 'Notification' in window ? Notification.permission : 'denied';
    
    console.log('[FACEAUTH-ALERT] Push notification check:', {
        status,
        browserPermission,
        lastNotifiedStatus,
        visibilityState: document.visibilityState,
        timeSinceLastNotification: Date.now() - lastNotificationTime
    });
    
    // Don't show if permission not granted
    if (browserPermission !== 'granted') {
        console.log('[FACEAUTH-ALERT] Notifications not permitted, skipping');
        return;
    }
    
    notificationPermission = browserPermission;
    
    const isCritical = status === 'overdue' || status === 'missed';
    const now = Date.now();
    
    // For critical states, repeat notification every 30 seconds
    // For non-critical, only notify once per status change
    const shouldRepeat = isCritical && (now - lastNotificationTime > REPEAT_NOTIFICATION_INTERVAL);
    const isNewStatus = lastNotifiedStatus !== status;
    
    if (!isNewStatus && !shouldRepeat) {
        return;
    }
    
    let title, body, icon, tag;
    
    switch (status) {
        case 'due_soon':
            title = '⚠️ Face Verification Due Soon';
            body = `Please verify your face in ${formatTime(remainingMs)}. Click to verify now.`;
            icon = '/favicon.ico';
            tag = 'faceauth-due-soon';
            break;
            
        case 'overdue':
            title = '🔴 Face Verification Overdue!';
            body = `Overdue by ${formatTime(overdueMs)}. HR Tool is BLOCKED. Click to verify now!`;
            icon = '/favicon.ico';
            tag = 'faceauth-overdue-' + Math.floor(now / 30000); // Unique tag to force new notification
            break;
            
        case 'missed':
            title = '🚨 URGENT: Face Verification MISSED!';
            body = `Missed by ${formatTime(overdueMs)}. Verify IMMEDIATELY to continue using HR Tool!`;
            icon = '/favicon.ico';
            tag = 'faceauth-missed-' + Math.floor(now / 30000); // Unique tag to force new notification
            break;
            
        default:
            return;
    }
    
    // Try BOTH methods for maximum reliability
    let notificationShown = false;
    
    // Method 1: Service Worker (works better in background)
    try {
        if (serviceWorkerRegistration && serviceWorkerRegistration.active) {
            serviceWorkerRegistration.active.postMessage({
                type: 'SHOW_NOTIFICATION',
                title,
                body,
                tag,
                status
            });
            console.log('[FACEAUTH-ALERT] Notification sent via Service Worker');
            notificationShown = true;
        }
    } catch (e) {
        console.warn('[FACEAUTH-ALERT] Service Worker notification failed:', e);
    }
    
    // Method 2: Direct Notification API (fallback, also try it)
    try {
        const notification = new Notification(title, {
            body,
            icon,
            tag: tag + '-direct',
            requireInteraction: isCritical,
            silent: false,
            vibrate: [200, 100, 200]
        });
        
        notification.onclick = () => {
            window.focus();
            notification.close();
            if (isCritical) {
                redirectToFaceAuth();
            }
        };
        
        console.log('[FACEAUTH-ALERT] Notification shown via direct API');
        notificationShown = true;
    } catch (e) {
        console.warn('[FACEAUTH-ALERT] Direct notification failed:', e);
    }
    
    if (notificationShown) {
        lastNotifiedStatus = status;
        lastNotificationTime = now;
        console.log('[FACEAUTH-ALERT] Push notification displayed:', status);
    }
}

/**
 * Reset notification tracking (call when status returns to verified)
 */
function resetNotificationTracking() {
    lastNotifiedStatus = null;
    lastNotificationTime = 0;
}

/**
 * Add CSS styles for the alert banner
 */
function injectStyles() {
    if (document.getElementById('faceauth-alert-styles')) return;
    
    const styles = document.createElement('style');
    styles.id = 'faceauth-alert-styles';
    styles.textContent = `
        .faceauth-alert-banner {
            display: none;
            position: fixed;
            top: 70px;
            left: 50%;
            transform: translateX(-50%);
            z-index: 9999;
            padding: 12px 20px;
            border-radius: 12px;
            box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15);
            animation: faceauth-slide-in 0.3s ease-out;
            max-width: 500px;
            width: calc(100% - 40px);
        }
        
        @keyframes faceauth-slide-in {
            from {
                opacity: 0;
                transform: translateX(-50%) translateY(-20px);
            }
            to {
                opacity: 1;
                transform: translateX(-50%) translateY(0);
            }
        }
        
        .faceauth-alert-banner.visible {
            display: flex;
        }
        
        .faceauth-alert-banner.due_soon {
            background: linear-gradient(135deg, #fef3c7 0%, #fde68a 100%);
            border: 1px solid #f59e0b;
        }
        
        .faceauth-alert-banner.overdue {
            background: linear-gradient(135deg, #fee2e2 0%, #fecaca 100%);
            border: 1px solid #ef4444;
        }
        
        .faceauth-alert-banner.missed {
            background: linear-gradient(135deg, #fecaca 0%, #f87171 100%);
            border: 2px solid #dc2626;
            animation: faceauth-pulse 2s infinite;
        }
        
        @keyframes faceauth-pulse {
            0%, 100% { box-shadow: 0 4px 20px rgba(220, 38, 38, 0.3); }
            50% { box-shadow: 0 4px 30px rgba(220, 38, 38, 0.5); }
        }
        
        .faceauth-alert-content {
            display: flex;
            align-items: center;
            gap: 12px;
            width: 100%;
        }
        
        .faceauth-alert-icon {
            font-size: 24px;
            flex-shrink: 0;
        }
        
        .faceauth-alert-banner.due_soon .faceauth-alert-icon {
            color: #b45309;
        }
        
        .faceauth-alert-banner.overdue .faceauth-alert-icon,
        .faceauth-alert-banner.missed .faceauth-alert-icon {
            color: #dc2626;
        }
        
        .faceauth-alert-text {
            display: flex;
            flex-direction: column;
            flex: 1;
            min-width: 0;
        }
        
        .faceauth-alert-title {
            font-weight: 600;
            font-size: 14px;
            color: #1f2937;
        }
        
        .faceauth-alert-subtitle {
            font-size: 12px;
            color: #6b7280;
        }
        
        .faceauth-alert-banner.missed .faceauth-alert-title {
            color: #991b1b;
        }
        
        .faceauth-alert-banner.missed .faceauth-alert-subtitle {
            color: #b91c1c;
            font-weight: 500;
        }
        
        .faceauth-alert-btn {
            display: flex;
            align-items: center;
            gap: 6px;
            padding: 8px 16px;
            border-radius: 8px;
            border: none;
            font-weight: 600;
            font-size: 13px;
            cursor: pointer;
            transition: all 0.2s ease;
            flex-shrink: 0;
        }
        
        .faceauth-alert-banner.due_soon .faceauth-alert-btn {
            background: #f59e0b;
            color: white;
        }
        
        .faceauth-alert-banner.due_soon .faceauth-alert-btn:hover {
            background: #d97706;
        }
        
        .faceauth-alert-banner.overdue .faceauth-alert-btn,
        .faceauth-alert-banner.missed .faceauth-alert-btn {
            background: #dc2626;
            color: white;
        }
        
        .faceauth-alert-banner.overdue .faceauth-alert-btn:hover,
        .faceauth-alert-banner.missed .faceauth-alert-btn:hover {
            background: #b91c1c;
        }
        
        /* Dark theme support */
        .dark-theme .faceauth-alert-banner.due_soon {
            background: linear-gradient(135deg, #78350f 0%, #92400e 100%);
            border-color: #f59e0b;
        }
        
        .dark-theme .faceauth-alert-banner.due_soon .faceauth-alert-title,
        .dark-theme .faceauth-alert-banner.due_soon .faceauth-alert-subtitle {
            color: #fef3c7;
        }
        
        .dark-theme .faceauth-alert-banner.overdue,
        .dark-theme .faceauth-alert-banner.missed {
            background: linear-gradient(135deg, #7f1d1d 0%, #991b1b 100%);
            border-color: #ef4444;
        }
        
        .dark-theme .faceauth-alert-banner.overdue .faceauth-alert-title,
        .dark-theme .faceauth-alert-banner.overdue .faceauth-alert-subtitle,
        .dark-theme .faceauth-alert-banner.missed .faceauth-alert-title,
        .dark-theme .faceauth-alert-banner.missed .faceauth-alert-subtitle {
            color: #fecaca;
        }
        
        /* Mobile responsive */
        @media (max-width: 600px) {
            .faceauth-alert-banner {
                top: 60px;
                padding: 10px 14px;
            }
            
            .faceauth-alert-icon {
                font-size: 20px;
            }
            
            .faceauth-alert-title {
                font-size: 13px;
            }
            
            .faceauth-alert-subtitle {
                font-size: 11px;
            }
            
            .faceauth-alert-btn {
                padding: 6px 12px;
                font-size: 12px;
            }
            
            .faceauth-alert-btn span {
                display: none;
            }
        }
        
        /* Blocking overlay - prevents interaction with app */
        .faceauth-blocking-overlay {
            display: none;
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(0, 0, 0, 0.5);
            z-index: 9998;
            backdrop-filter: blur(2px);
        }
        
        .faceauth-blocking-overlay.active {
            display: block;
        }
        
        /* Dark theme overlay */
        .dark-theme .faceauth-blocking-overlay {
            background: rgba(0, 0, 0, 0.7);
        }
    `;
    
    document.head.appendChild(styles);
}

/**
 * Update the alert banner UI based on current status
 */
function updateAlertUI(statusData) {
    const { status, remainingMs, overdueMs } = statusData;
    
    // When missed alert expires, reset the cycle (Option 2: Repeat alert cycle)
    // This gives user another 2-hour window, then alerts again
    if (status === 'missed' && overdueMs > MISSED_AUTO_HIDE_MS) {
        console.log('[FACEAUTH-ALERT] Missed alert expired - resetting cycle to current time');
        // Reset the timer to now - this starts a new 2-hour cycle
        localStorage.setItem('last_face_verified_at', String(Date.now()));
        // Hide alert and remove blocking (user gets another cycle)
        if (alertElement) {
            alertElement.classList.remove('visible', 'due_soon', 'overdue', 'missed');
        }
        setBlockingOverlay(false);
        stopTitleFlash();
        currentStatus = 'verified';
        return;
    }
    
    // Don't show alert if verified, unknown, or disabled
    if (status === 'verified' || status === 'unknown' || status === 'disabled') {
        if (alertElement) {
            alertElement.classList.remove('visible', 'due_soon', 'overdue', 'missed');
        }
        // Remove blocking overlay and stop title flash when verified
        setBlockingOverlay(false);
        stopTitleFlash();
        // Reset notification tracking so notifications can fire again in next cycle
        resetNotificationTracking();
        currentStatus = status;
        return;
    }
    
    // Create alert element if needed
    createAlertElement();
    
    // Update classes
    alertElement.classList.remove('due_soon', 'overdue', 'missed');
    alertElement.classList.add(status, 'visible');
    
    // Update text based on status
    const titleEl = alertElement.querySelector('.faceauth-alert-title');
    const subtitleEl = alertElement.querySelector('.faceauth-alert-subtitle');
    const btnTextEl = alertElement.querySelector('.faceauth-alert-btn span');
    
    // Enable blocking overlay and tab notification based on status
    let shouldBlock = false;
    let titleMessage = '';
    
    switch (status) {
        case 'due_soon':
            titleEl.textContent = 'Face Verification Due Soon';
            subtitleEl.textContent = `Please verify in ${formatTime(remainingMs)}`;
            btnTextEl.textContent = 'Verify Now';
            // No blocking for due_soon, just warning
            shouldBlock = false;
            titleMessage = 'Verify Face Soon';
            break;
            
        case 'overdue':
            titleEl.textContent = 'Face Verification Overdue';
            subtitleEl.textContent = `Overdue by ${formatTime(overdueMs)}`;
            btnTextEl.textContent = 'Verify Now';
            // Block interaction when overdue
            shouldBlock = true;
            titleMessage = 'Face Verification Overdue!';
            break;
            
        case 'missed':
            titleEl.textContent = '⚠️ Face Verification MISSED';
            subtitleEl.textContent = `Missed by ${formatTime(overdueMs)} - Please verify immediately`;
            btnTextEl.textContent = 'Verify Now';
            // Block interaction when missed
            shouldBlock = true;
            titleMessage = '⚠️ VERIFY FACE NOW!';
            break;
    }
    
    // Apply blocking overlay
    setBlockingOverlay(shouldBlock);
    
    // Apply tab title notification
    if (shouldBlock) {
        startTitleFlash(titleMessage);
    } else {
        stopTitleFlash();
    }
    
    // Show browser push notification (works even when tab is minimized)
    showPushNotification(status, remainingMs, overdueMs);
    
    // Log status change
    if (currentStatus !== status) {
        console.log(`[FACEAUTH-ALERT] Status changed: ${currentStatus} → ${status}`);
        currentStatus = status;
    }
}

/**
 * Redirect to FaceAuth for re-verification
 */
async function redirectToFaceAuth() {
    const token = localStorage.getItem('face_auth_token');
    if (!token) {
        console.error('[FACEAUTH-ALERT] No face_auth_token found');
        alert('Session expired. Please login again.');
        window.location.href = '/index.html#/login';
        return;
    }
    
    // Store current URL to return after verification
    const returnUrl = window.location.href;
    localStorage.setItem('faceauth_return_url', returnUrl);
    
    try {
        console.log('[FACEAUTH-ALERT] Requesting fresh reverification token...');
        // Request a fresh token from the backend
        const response = await fetch(`${API_BASE_URL}/api/auth/faceauth-reverify-token`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });
        
        if (!response.ok) {
            console.error('[FACEAUTH-ALERT] Failed to get fresh token:', response.status);
            alert('Your session has expired or is invalid. Please login again.');
            localStorage.removeItem('face_auth_token');
            localStorage.removeItem('authToken');
            window.location.href = '/index.html#/login';
            return;
        }
        
        const data = await response.json();
        if (!data.success || !data.token) {
            console.error('[FACEAUTH-ALERT] Invalid response from reverify endpoint');
            alert('An error occurred during verification. Please login again.');
            window.location.href = '/index.html#/login';
            return;
        }
        
        const freshToken = data.token;
        
        // Build FaceAuth URL with fresh token and callback
        const callbackUrl = `${window.location.origin}/auth/face-callback`;
        const encodedToken = encodeURIComponent(freshToken);
        const encodedCallback = encodeURIComponent(callbackUrl);
        
        const faceAuthUrl = `${FACEAUTH_VERIFY_URL}?token=${encodedToken}&callback_url=${encodedCallback}&purpose=reverification`;
        
        console.log('[FACEAUTH-ALERT] Redirecting to FaceAuth for re-verification');
        window.location.href = faceAuthUrl;
        
    } catch (error) {
        console.error('[FACEAUTH-ALERT] Error during token refresh:', error);
        alert('A network error occurred. Please try again.');
    }
}

/**
 * Check status and update UI
 */
function checkAndUpdate() {
    // Only check if user is authenticated
    if (!state.authenticated && !localStorage.getItem('face_auth_token')) {
        return;
    }

    if (!isFaceAuthRequiredForCurrentUser()) {
        updateAlertUI({
            status: 'disabled',
            remainingMs: 0,
            elapsedMs: 0,
            overdueMs: 0,
            lastVerified: null
        });
        return;
    }
    
    const statusData = checkFaceAuthStatus();
    updateAlertUI(statusData);
}

/**
 * Initialize the FaceAuth alert system
 */
export function initFaceAuthAlerts() {
    if (!_isFaceAuthAlertsEnabled()) {
        console.log('[FACEAUTH-ALERT] Alerts disabled by config');
        cleanupFaceAuthAlerts();
        return;
    }

    console.log('[FACEAUTH-ALERT] Initializing face auth alert system');
    
    // Inject styles
    injectStyles();
    
    // Register service worker for background notifications
    registerServiceWorker().then(registration => {
        if (registration) {
            console.log('[FACEAUTH-ALERT] Service worker ready for background notifications');
        }
    });
    
    // Request notification permission (for push notifications when tab is minimized)
    requestNotificationPermission().then(permission => {
        console.log('[FACEAUTH-ALERT] Notification permission status:', permission);
    });
    
    // Initial check
    checkAndUpdate();
    
    // Start periodic checks
    if (checkIntervalId) {
        clearInterval(checkIntervalId);
    }
    checkIntervalId = setInterval(checkAndUpdate, CHECK_INTERVAL_MS);
    
    // Also check when tab becomes visible
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            checkAndUpdate();
        }
    });
    
    // Listen for storage changes (multi-tab sync)
    window.addEventListener('storage', (e) => {
        if (e.key === 'face_auth_token' || e.key === 'last_face_verified_at') {
            console.log('[FACEAUTH-ALERT] Token/timestamp changed, rechecking status');
            checkAndUpdate();
        }
    });
    
    console.log('[FACEAUTH-ALERT] Alert system initialized');
}

/**
 * Cleanup - stop checking
 */
export function cleanupFaceAuthAlerts() {
    if (checkIntervalId) {
        clearInterval(checkIntervalId);
        checkIntervalId = null;
    }
    if (alertElement) {
        alertElement.remove();
        alertElement = null;
    }
    if (overlayElement) {
        overlayElement.remove();
        overlayElement = null;
    }
    stopTitleFlash();
    isBlockingEnabled = false;
}

/**
 * Force refresh status (call after successful re-verification)
 */
export function refreshFaceAuthStatus() {
    if (!_isFaceAuthAlertsEnabled()) return;
    console.log('[FACEAUTH-ALERT] Forcing status refresh');
    checkAndUpdate();
}

/**
 * Get return URL after re-verification (if any)
 */
export function getFaceAuthReturnUrl() {
    const url = localStorage.getItem('faceauth_return_url');
    localStorage.removeItem('faceauth_return_url');
    return url;
}
