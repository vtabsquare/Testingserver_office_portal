// attendanceRenderer.js - Stateless Frontend Attendance Rendering
// ZERO localStorage, ZERO setInterval for business logic, ZERO timer state ownership
// Frontend ONLY renders what backend tells it - backend is THE source of truth

import { state } from '../state.js';
import { API_BASE_URL } from '../config.js';

const BASE_URL = API_BASE_URL.replace(/\/$/, '');

// ================== CONFIGURATION ==================
const STATUS_REFRESH_INTERVAL_MS = 5000;  // Refresh status every 5 seconds during active session
const DISPLAY_UPDATE_INTERVAL_MS = 1000;  // Update display every 1 second (visual only)

// Module state (NOT persisted, reset on page load)
let statusRefreshIntervalId = null;
let displayUpdateIntervalId = null;
let lastStatusResponse = null;
let isInitialized = false;
let _trackingLocalDate = null; // tracks the local date while session is active for midnight detection
let _midnightResetInProgress = false;

function syncThresholdsFromStatusData(data) {
    if (data?.status?.thresholds) {
        state.attendanceShiftThresholds = data.status.thresholds;
    }
}

/**
 * Get today's local date string (YYYY-MM-DD) in the user's timezone.
 */
function _getLocalDateStr() {
    const now = new Date();
    return now.getFullYear() + '-' +
        String(now.getMonth() + 1).padStart(2, '0') + '-' +
        String(now.getDate()).padStart(2, '0');
}

// ================== CORE PRINCIPLE ==================
// elapsed_display = server_now_utc - last_session_start_utc + total_seconds_today
// This is calculated from backend data, NOT from local timers

// ================== API CALLS ==================

/**
 * Fetch current attendance status from backend.
 * This is THE source of truth for all timer displays.
 */
export async function fetchAttendanceStatus(employeeId) {
    if (!employeeId) return null;
    
    try {
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
        const url = `${BASE_URL}/api/v2/attendance/status/${employeeId}?timezone=${encodeURIComponent(tz)}`;
        
        console.log('[ATTENDANCE-RENDERER] Fetching status from:', url);
        
        const response = await fetch(url, {
            method: 'GET',
            headers: { 'Accept': 'application/json' }
        });
        
        if (!response.ok) {
            throw new Error(`Status fetch failed: ${response.status}`);
        }
        
        const data = await response.json();
        console.log('[ATTENDANCE-RENDERER] Status response:', data);
        console.log('[ATTENDANCE-RENDERER] Timing data:', {
            total_seconds_today: data.timing?.total_seconds_today,
            elapsed_seconds: data.timing?.elapsed_seconds,
            is_active: data.is_active_session
        });
        
        if (data.success) {
            // Guard: if backend returns a record for a different day than local today,
            // treat it as "no record" to prevent cross-day contamination.
            const localToday = _getLocalDateStr();
            const backendDate = (data.attendance_date || '').slice(0, 10);
            if (backendDate && backendDate !== localToday) {
                console.warn(`[ATTENDANCE-RENDERER] Backend date ${backendDate} != local today ${localToday}, forcing clean slate`);
                data.has_record = false;
                data.is_active_session = false;
                data.timing = { total_seconds_today: 0 };
                data.status = { code: null, label: 'Not Checked In' };
            }
            
            // Second guard: if active session but checkin_utc is from a different day,
            // this is a stale cross-day session the old backend didn't close.
            // BUT: if we already have a local active session (user just checked in),
            // preserve it — don't let the stale backend response kill the new session.
            if (data.is_active_session && data.timing?.checkin_utc) {
                const checkinDay = (data.timing.checkin_utc || '').slice(0, 10);
                if (checkinDay && checkinDay !== localToday) {
                    // Check if we have a local active session that's recent (< 60s old)
                    const hasRecentLocalSession = lastStatusResponse?.is_active_session
                        && lastStatusResponse?.fetchedAt
                        && (Date.now() - lastStatusResponse.fetchedAt) < 60000;
                    
                    if (hasRecentLocalSession) {
                        // Keep the local session — don't overwrite with stale backend data
                        console.warn(`[ATTENDANCE-RENDERER] Stale backend checkin ${checkinDay} != today ${localToday}, but keeping recent local session`);
                        return lastStatusResponse;
                    }
                    
                    console.warn(`[ATTENDANCE-RENDERER] Stale active session: checkin ${checkinDay} != today ${localToday}, forcing clean slate`);
                    data.has_record = false;
                    data.is_active_session = false;
                    data.timing = { total_seconds_today: 0 };
                    data.status = { code: null, label: 'Not Checked In' };
                    // Best-effort: trigger force-close on backend
                    try {
                        const empId = state.user?.id;
                        if (empId) {
                            fetch(`${BASE_URL}/api/v2/attendance/force-close-stale/${empId}`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' })
                            }).catch(() => {});
                        }
                    } catch { }
                }
            }
            
            lastStatusResponse = {
                ...data,
                fetchedAt: Date.now(),
                serverNowAtFetch: data.server_now_utc ? new Date(data.server_now_utc).getTime() : Date.now()
            };
            syncThresholdsFromStatusData(data);
            // Track local date for midnight detection when session is active
            if (data.is_active_session) {
                _trackingLocalDate = _trackingLocalDate || _getLocalDateStr();
            } else {
                _trackingLocalDate = null;
            }
            console.log('[ATTENDANCE-RENDERER] Stored lastStatusResponse:', lastStatusResponse);
            return data;
        }
        
        return null;
    } catch (error) {
        console.error('[ATTENDANCE-RENDERER] fetchAttendanceStatus error:', error);
        return null;
    }
}

/**
 * Send check-in request to backend.
 * Frontend does NOT start timer - waits for backend confirmation.
 */
export async function performCheckIn(employeeId, location = null) {
    if (!employeeId) {
        throw new Error('Employee ID required');
    }
    
    const payload = {
        employee_id: employeeId,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    };
    
    if (location) {
        payload.location = location;
    }
    
    const response = await fetch(`${BASE_URL}/api/v2/attendance/checkin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    
    const data = await response.json();
    
    if (!response.ok || !data.success) {
        throw new Error(data.message || data.error || 'Check-in failed');
    }
    
    // Update local cache with new status
    // Detect stale cross-day already_checked_in: if backend says "already checked in"
    // but the checkin timestamp is from a different local day, it's a stale session.
    let freshTotal = 0;
    const localToday = _getLocalDateStr();
    if (data.already_checked_in) {
        // Check if the reported check-in is actually from today
        const checkinDate = (data.checkin_utc || data.display?.date_local || '').slice(0, 10);
        const displayDate = (data.display?.date_local || '').slice(0, 10);
        const isFromToday = (checkinDate === localToday) || (displayDate === localToday);
        
        if (isFromToday) {
            freshTotal = data.total_seconds_today || 0;
        } else {
            // Stale cross-day session — force fresh start
            console.warn(`[ATTENDANCE-RENDERER] Stale already_checked_in detected (checkin: ${checkinDate}, today: ${localToday}). Forcing fresh session.`);
            freshTotal = 0;
            // Best-effort: try to force-close the stale session on backend
            try {
                fetch(`${BASE_URL}/api/v2/attendance/force-close-stale/${employeeId}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' })
                }).catch(() => {});
            } catch { }
        }
    }
    
    lastStatusResponse = {
        success: true,
        server_now_utc: data.server_now_utc,
        has_record: true,
        is_active_session: true,
        timing: {
            checkin_utc: data.checkin_utc,
            last_session_start_utc: data.checkin_utc,
            elapsed_seconds: 0,
            total_seconds_today: freshTotal
        },
        status: {
            code: data.status_code,
            label: data.status_code === 'P' ? 'Present' : data.status_code === 'HL' ? 'Half Day' : 'Working'
        },
        fetchedAt: Date.now(),
        serverNowAtFetch: new Date(data.server_now_utc).getTime()
    };
    
    // Start tracking local date for midnight detection
    _trackingLocalDate = _getLocalDateStr();
    
    // Trigger immediate UI update
    updateTimerDisplay();
    
    return data;
}

/**
 * Handle midnight crossing while a session is active.
 * Forces a backend status refresh which auto-closes the stale session,
 * then resets the UI to allow a fresh CHECK IN on the new day.
 */
async function _handleMidnightReset(employeeId) {
    if (_midnightResetInProgress) return;
    _midnightResetInProgress = true;
    
    console.log('[ATTENDANCE-RENDERER] Midnight crossed! Auto-resetting session.');
    
    try {
        // Stop any running task timers on the frontend side
        try {
            await stopActiveTaskTimerOnCheckout(employeeId);
        } catch { }
        
        // Immediately force UI to CHECK IN / 00:00:00 so the user sees the
        // reset right away, even before the backend call completes.
        lastStatusResponse = {
            success: true,
            has_record: false,
            is_active_session: false,
            timing: { total_seconds_today: 0 },
            status: { code: null, label: 'Not Checked In' },
            fetchedAt: Date.now(),
            serverNowAtFetch: Date.now()
        };
        updateTimerDisplay();
        
        // Fetch fresh status from backend.
        // The backend's _auto_close_stale_sessions will close the old-day session at 00:00
        // and return is_active_session=false for the new day (no record yet).
        try {
            await fetchAttendanceStatus(employeeId);
        } catch { }
        
        // Final UI sync with whatever backend returned
        updateTimerDisplay();
        
        console.log('[ATTENDANCE-RENDERER] Midnight reset complete. Ready for fresh check-in.');
    } catch (err) {
        console.error('[ATTENDANCE-RENDERER] Midnight reset error:', err);
    } finally {
        _midnightResetInProgress = false;
        _trackingLocalDate = null;
    }
}

async function stopActiveTaskTimerOnCheckout(employeeId, checkoutUtc = null) {
    const uid = String(employeeId || '').trim().toUpperCase();
    if (!uid) return;

    const activeKey = `tt_active_${uid}`;
    let active = null;
    try {
        active = JSON.parse(localStorage.getItem(activeKey) || 'null');
    } catch {
        active = null;
    }

    if (!active || !active.task_guid) {
        return;
    }

    const startedAt = Number(active.started_at || 0);
    const checkoutMs = (() => {
        if (!checkoutUtc) return Date.now();
        const parsed = new Date(checkoutUtc).getTime();
        return Number.isFinite(parsed) ? parsed : Date.now();
    })();

    // If task was running, log current run slice before force-stopping.
    if (!active.paused && startedAt > 0) {
        const endMs = Math.max(checkoutMs, startedAt);
        const sessionSeconds = Math.max(1, Math.floor((endMs - startedAt) / 1000));
        const body = {
            employee_id: uid,
            project_id: active.project_id || '',
            task_guid: active.task_guid || '',
            task_id: active.task_id || '',
            task_name: active.task_name || active.task_id || '',
            seconds: sessionSeconds,
            work_date: new Date(endMs).toISOString().slice(0, 10),
            description: '',
            session_start_ms: startedAt,
            session_end_ms: endMs,
            tz_offset_minutes: new Date().getTimezoneOffset(),
        };

        try {
            await fetch(`${BASE_URL}/api/time-tracker/task-log`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
        } catch (logErr) {
            console.warn('[ATTENDANCE-RENDERER] Failed to auto-log task timer on checkout:', logErr);
        }
    }

    // Stop backend task timer state (best effort).
    try {
        await fetch(`${BASE_URL}/api/time-entries/stop`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ task_guid: active.task_guid, user_id: uid }),
        });
    } catch (stopErr) {
        console.warn('[ATTENDANCE-RENDERER] Failed backend task timer stop on checkout:', stopErr);
    }

    // Always clear local active task pointer so timer cannot continue next day.
    try {
        localStorage.removeItem(activeKey);
    } catch { }

    // Notify any open My Tasks view to repaint quickly.
    try {
        window.dispatchEvent(new CustomEvent('taskTimerStopped', {
            detail: {
                employee_id: uid,
                task_guid: active.task_guid,
                reason: 'attendance_checkout'
            }
        }));
    } catch { }
}

/**
 * Send check-out request to backend.
 * Frontend does NOT stop timer - waits for backend confirmation.
 */
export async function performCheckOut(employeeId, location = null) {
    if (!employeeId) {
        throw new Error('Employee ID required');
    }
    
    const payload = {
        employee_id: employeeId,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    };
    
    if (location) {
        payload.location = location;
    }
    
    const response = await fetch(`${BASE_URL}/api/v2/attendance/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    
    const data = await response.json();
    
    if (!response.ok || !data.success) {
        throw new Error(data.message || data.error || 'Check-out failed');
    }
    
    // Update local cache with new status
    lastStatusResponse = {
        success: true,
        server_now_utc: data.server_now_utc,
        has_record: true,
        is_active_session: false,
        timing: {
            checkout_utc: data.checkout_utc,
            total_seconds_today: data.total_seconds_today
        },
        status: {
            code: data.status_code,
            label: data.display?.status_label || data.status_code
        },
        fetchedAt: Date.now(),
        serverNowAtFetch: new Date(data.server_now_utc).getTime()
    };
    
    // Clear midnight tracking since session is now closed
    _trackingLocalDate = null;
    
    // Trigger immediate UI update
    updateTimerDisplay();

    // Keep task timer in sync with attendance checkout (prevents cross-day running timers).
    try {
        await stopActiveTaskTimerOnCheckout(employeeId, data.checkout_utc || data.server_now_utc);
    } catch (syncErr) {
        console.warn('[ATTENDANCE-RENDERER] Task timer sync on checkout failed:', syncErr);
    }
    
    return data;
}

// ================== DISPLAY CALCULATION ==================

/**
 * Calculate current elapsed seconds based on backend data.
 * This uses local time ONLY for visual interpolation between status refreshes.
 * The base values (server_now, checkin_utc, total_seconds) are from backend.
 */
function calculateCurrentElapsed() {
    if (!lastStatusResponse) {
        return { totalSeconds: 0, isActive: false };
    }
    
    const { is_active_session, timing, fetchedAt, serverNowAtFetch } = lastStatusResponse;
    
    if (!is_active_session) {
        // Not active - return stored total
        return {
            totalSeconds: timing?.total_seconds_today || 0,
            isActive: false
        };
    }
    
    // Active session - backend calculated total seconds at fetch time
    // Add small visual interpolation (max 5 seconds to prevent drift)
    const baseSeconds = timing?.total_seconds_today || 0;
    const msSinceFetch = Date.now() - fetchedAt;
    const secondsSinceFetch = Math.min(Math.floor(msSinceFetch / 1000), 5); // Cap at 5 seconds
    const totalSeconds = baseSeconds + secondsSinceFetch;
    
    return {
        totalSeconds: Math.max(0, totalSeconds),
        isActive: true
    };
}

/**
 * Format seconds to HH:MM:SS display string
 */
function formatTime(totalSeconds) {
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/**
 * Format seconds to human readable string
 */
function formatDuration(totalSeconds) {
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    return `${hours}h ${minutes}m`;
}

// ================== UI UPDATES ==================

/**
 * Update the timer display element.
 * Called every second for visual updates, but values derived from backend data.
 */
export function updateTimerDisplay() {
    const timerDisplay = document.getElementById('timer-display');
    const timerBtn = document.getElementById('timer-btn');
    
    if (!timerDisplay && !timerBtn) return;
    
    const { totalSeconds, isActive } = calculateCurrentElapsed();
    const timeString = formatTime(totalSeconds);
    
    // Debug logging
    if (Math.random() < 0.01) { // Log 1% of the time to avoid spam
        console.log('[ATTENDANCE-RENDERER] Display update:', {
            totalSeconds,
            isActive,
            timeString,
            hasResponse: !!lastStatusResponse
        });
    }
    
    if (timerDisplay) {
        timerDisplay.textContent = timeString;
    }
    
    if (timerBtn) {
        if (isActive) {
            timerBtn.classList.remove('check-in');
            timerBtn.classList.add('check-out');
            timerBtn.innerHTML = `<span id="timer-display">${timeString}</span> CHECK OUT`;
        } else {
            timerBtn.classList.remove('check-out');
            timerBtn.classList.add('check-in');
            timerBtn.innerHTML = `<span id="timer-display">${timeString}</span> CHECK IN`;
        }
    }
    
    // Update state for other components (but NOT for persistence!)
    if (state.timer) {
        state.timer.displaySeconds = totalSeconds;
        state.timer.isActive = isActive;
    }
}

/**
 * Update the timer button state based on backend status
 */
export function updateTimerButton() {
    updateTimerDisplay();
}

// ================== INITIALIZATION ==================

/**
 * Initialize the attendance renderer.
 * Called on page load - fetches status from backend and starts display updates.
 */
export async function initializeAttendance(employeeId) {
    if (!employeeId) {
        console.warn('[ATTENDANCE-RENDERER] No employee ID provided');
        return;
    }
    
    console.log('[ATTENDANCE-RENDERER] Initializing for employee:', employeeId);
    
    // Clean up any existing intervals
    cleanup();
    
    // Fetch initial status from backend
    const status = await fetchAttendanceStatus(employeeId);
    
    if (status) {
        console.log('[ATTENDANCE-RENDERER] Initial status:', {
            isActive: status.is_active_session,
            totalSeconds: status.timing?.total_seconds_today,
            statusCode: status.status?.code
        });
    }
    
    // Initial display update
    updateTimerDisplay();
    
    // Track local date for midnight detection
    _trackingLocalDate = (lastStatusResponse?.is_active_session) ? _getLocalDateStr() : null;
    
    // Start display update interval (visual interpolation only + midnight detection)
    displayUpdateIntervalId = setInterval(() => {
        // Midnight detection: if session is active and local date has changed, trigger reset
        if (_trackingLocalDate && lastStatusResponse?.is_active_session) {
            const currentDate = _getLocalDateStr();
            if (currentDate !== _trackingLocalDate) {
                console.log(`[ATTENDANCE-RENDERER] Date changed: ${_trackingLocalDate} -> ${currentDate}`);
                _handleMidnightReset(employeeId);
                return; // skip normal display update this tick
            }
        }
        // Always update display for visual consistency
        updateTimerDisplay();
    }, DISPLAY_UPDATE_INTERVAL_MS);
    
    // Start status refresh interval (sync with backend)
    statusRefreshIntervalId = setInterval(async () => {
        await fetchAttendanceStatus(employeeId);
        updateTimerDisplay();
    }, STATUS_REFRESH_INTERVAL_MS);
    
    // Listen for visibility changes (tab focus)
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            // Tab became visible - refresh from backend
            fetchAttendanceStatus(employeeId).then(() => {
                updateTimerDisplay();
            });
        }
    });
    
    isInitialized = true;
    console.log('[ATTENDANCE-RENDERER] Initialization complete');
}

/**
 * Handle timer button click.
 * Determines whether to check-in or check-out based on backend state.
 */
export async function handleTimerClick() {
    const employeeId = state.user?.id;
    
    if (!employeeId) {
        alert('User not logged in');
        return;
    }
    
    const timerBtn = document.getElementById('timer-btn');
    if (timerBtn) {
        timerBtn.disabled = true;
        timerBtn.style.opacity = '0.7';
    }
    
    try {
        // Get current location (optional, non-blocking)
        let location = null;
        try {
            location = await getGeolocation();
        } catch {
            // Location capture failed - continue without it
        }
        
        // Determine action based on current status
        const isCurrentlyActive = lastStatusResponse?.is_active_session || false;
        
        if (isCurrentlyActive) {
            // Check out
            await performCheckOut(employeeId, location);
            console.log('[ATTENDANCE-RENDERER] Check-out successful');
        } else {
            // Check in
            await performCheckIn(employeeId, location);
            console.log('[ATTENDANCE-RENDERER] Check-in successful');
        }
        
        // Refresh status to ensure sync
        await fetchAttendanceStatus(employeeId);
        updateTimerDisplay();
        
    } catch (error) {
        console.error('[ATTENDANCE-RENDERER] Timer action failed:', error);
        alert(error.message || 'Operation failed. Please try again.');
        
        // Refresh status to show actual state
        await fetchAttendanceStatus(employeeId);
        updateTimerDisplay();
    } finally {
        if (timerBtn) {
            timerBtn.disabled = false;
            timerBtn.style.opacity = '1';
        }
    }
}

/**
 * Get current geolocation (with timeout)
 */
function getGeolocation() {
    return new Promise((resolve, reject) => {
        if (!navigator.geolocation) {
            reject(new Error('Geolocation not supported'));
            return;
        }
        
        const timeout = setTimeout(() => {
            reject(new Error('Geolocation timeout'));
        }, 10000);
        
        navigator.geolocation.getCurrentPosition(
            (pos) => {
                clearTimeout(timeout);
                resolve({
                    lat: pos.coords.latitude,
                    lng: pos.coords.longitude,
                    accuracy_m: pos.coords.accuracy
                });
            },
            (err) => {
                clearTimeout(timeout);
                reject(err);
            },
            { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
        );
    });
}

/**
 * Clean up intervals and listeners
 */
export function cleanup() {
    if (statusRefreshIntervalId) {
        clearInterval(statusRefreshIntervalId);
        statusRefreshIntervalId = null;
    }
    if (displayUpdateIntervalId) {
        clearInterval(displayUpdateIntervalId);
        displayUpdateIntervalId = null;
    }
    lastStatusResponse = null;
    isInitialized = false;
    _trackingLocalDate = null;
    _midnightResetInProgress = false;
}

// ================== SOCKET EVENT HANDLER ==================

/**
 * Handle attendance change event from socket.
 * Socket only tells us something changed - we fetch fresh data from backend.
 */
export async function handleAttendanceChanged(data) {
    const employeeId = state.user?.id;
    
    if (!employeeId) return;
    
    // Only refresh if the event is for this employee
    if (data.employee_id && data.employee_id.toUpperCase() !== employeeId.toUpperCase()) {
        return;
    }
    
    console.log('[ATTENDANCE-RENDERER] Attendance changed event, refreshing status');
    
    // Fetch fresh status from backend
    await fetchAttendanceStatus(employeeId);
    updateTimerDisplay();
}

// ================== EXPORTS FOR BACKWARD COMPATIBILITY ==================

// These functions maintain API compatibility with the old timer.js
// loadTimerState gets employee ID from state automatically
export async function loadTimerState(employeeId = null) {
    const empId = employeeId || state.user?.id;
    console.log('[ATTENDANCE-RENDERER] loadTimerState called with:', empId);
    if (!empId) {
        console.warn('[ATTENDANCE-RENDERER] loadTimerState: No employee ID available');
        return;
    }
    return initializeAttendance(empId);
}
// updateTimerButton is already exported above

// Get current state for other components
export function getAttendanceState() {
    if (!lastStatusResponse) {
        return {
            isActive: false,
            totalSeconds: 0,
            statusCode: null
        };
    }
    
    const { totalSeconds, isActive } = calculateCurrentElapsed();
    
    return {
        isActive,
        totalSeconds,
        statusCode: lastStatusResponse.status?.code,
        statusLabel: lastStatusResponse.status?.label,
        checkinUtc: lastStatusResponse.timing?.checkin_utc,
        checkoutUtc: lastStatusResponse.timing?.checkout_utc
    };
}

// Check if currently checked in
export function isCheckedIn() {
    return lastStatusResponse?.is_active_session || false;
}

// Get total seconds worked today
export function getTotalSecondsToday() {
    const { totalSeconds } = calculateCurrentElapsed();
    return totalSeconds;
}
