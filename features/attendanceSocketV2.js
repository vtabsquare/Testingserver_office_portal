// attendanceSocketV2.js - Stateless Socket Client for Attendance
// Socket ONLY receives events - never stores or calculates timer state
// On any event, client fetches fresh data from backend API

import { state } from '../state.js';
import { fetchAttendanceStatus, updateTimerDisplay } from './attendanceRenderer.js';

let socket = null;
let isConnected = false;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_DELAY_MS = 3000;
let teamAttendanceRefreshHandler = null;

// ================== SOCKET CONNECTION ==================

/**
 * Initialize socket connection for attendance events.
 * Socket is used ONLY for real-time notifications, not for state.
 */
export function initializeAttendanceSocket(socketInstance) {
    if (!socketInstance) {
        console.warn('[ATTENDANCE-SOCKET-V2] No socket instance provided');
        return;
    }

    socket = socketInstance;
    setupEventHandlers();

    console.log('[ATTENDANCE-SOCKET-V2] Initialized');
}

/**
 * Register current user for attendance events
 */
/**
 * Register for team-wide attendance updates (Team Attendance page).
 * @param {(data: { employee_id?: string }) => void|Promise<void>} onUpdate
 */
export function registerForTeamAttendanceWatch(onUpdate) {
    teamAttendanceRefreshHandler = typeof onUpdate === 'function' ? onUpdate : null;
    if (!socket || !socket.connected) return;
    socket.emit('attendance:register-team-watcher');
}

export function unregisterForTeamAttendanceWatch() {
    teamAttendanceRefreshHandler = null;
    if (socket?.connected) {
        socket.emit('attendance:unregister-team-watcher');
    }
}

export function registerForAttendanceEvents() {
    const employeeId = state.user?.id;

    if (!employeeId) {
        console.warn('[ATTENDANCE-SOCKET-V2] No employee ID to register');
        return;
    }

    if (!socket || !socket.connected) {
        console.warn('[ATTENDANCE-SOCKET-V2] Socket not connected');
        return;
    }

    socket.emit('attendance:register', {
        employee_id: employeeId
    });

    console.log('[ATTENDANCE-SOCKET-V2] Registered for events:', employeeId);
}

/**
 * Setup socket event handlers
 */
function setupEventHandlers() {
    if (!socket) return;

    // Connection events
    socket.on('connect', () => {
        console.log('[ATTENDANCE-SOCKET-V2] Connected');
        isConnected = true;
        reconnectAttempts = 0;

        // Register for events on connect
        registerForAttendanceEvents();
        if (teamAttendanceRefreshHandler) {
            socket.emit('attendance:register-team-watcher');
        }
    });

    socket.on('disconnect', (reason) => {
        console.log('[ATTENDANCE-SOCKET-V2] Disconnected:', reason);
        isConnected = false;

        // Auto-reconnect for certain disconnect reasons
        if (reason === 'io server disconnect') {
            // Server disconnected us, try to reconnect
            attemptReconnect();
        }
    });

    socket.on('connect_error', (error) => {
        console.warn('[ATTENDANCE-SOCKET-V2] Connection error:', error.message);
        isConnected = false;
    });

    // ================== ATTENDANCE EVENTS ==================

    // Registration confirmed
    socket.on('attendance:registered', (data) => {
        console.log('[ATTENDANCE-SOCKET-V2] Registration confirmed:', data.room);
        // ❌ DO NOT expect any timer state from socket
        // ✅ Timer state comes from /api/v2/attendance/status
    });

    // Something changed - refresh from backend
    socket.on('attendance:changed', async (data) => {
        console.log('[ATTENDANCE-SOCKET-V2] Attendance changed event:', data.event_type);

        const employeeId = state.user?.id;
        if (!employeeId) return;

        // Only process if event is for this employee
        if (data.employee_id && data.employee_id.toUpperCase() !== employeeId.toUpperCase()) {
            return;
        }

        // ✅ Fetch fresh data from backend
        await fetchAttendanceStatus(employeeId);
        updateTimerDisplay();
    });

    // Server says refresh needed
    socket.on('attendance:refresh-required', async (data) => {
        console.log('[ATTENDANCE-SOCKET-V2] Refresh required');

        const employeeId = state.user?.id;
        if (!employeeId) return;

        // ✅ Fetch fresh data from backend
        await fetchAttendanceStatus(employeeId);
        updateTimerDisplay();
    });

    // ================== LEGACY EVENT HANDLERS ==================
    // These handle events from old socket server during migration

    socket.on('attendance:started', async (data) => {
        console.log('[ATTENDANCE-SOCKET-V2] Legacy started event - refreshing');
        const employeeId = state.user?.id;
        if (employeeId) {
            await fetchAttendanceStatus(employeeId);
            updateTimerDisplay();
        }
        if (teamAttendanceRefreshHandler && data?.employee_id) {
            const selfId = String(state.user?.id || '').toUpperCase();
            if (String(data.employee_id).toUpperCase() !== selfId) {
                try {
                    await teamAttendanceRefreshHandler(data);
                } catch (err) {
                    console.warn('[ATTENDANCE-SOCKET-V2] Team refresh (started) failed:', err);
                }
            }
        }
    });

    socket.on('attendance:stopped', async (data) => {
        console.log('[ATTENDANCE-SOCKET-V2] Legacy stopped event - refreshing');
        const employeeId = state.user?.id;
        if (employeeId) {
            await fetchAttendanceStatus(employeeId);
            updateTimerDisplay();
        }
    });

    socket.on('attendance:sync', async (data) => {
        // ❌ IGNORE sync events - we don't use socket state
        console.log('[ATTENDANCE-SOCKET-V2] Ignoring legacy sync event - using backend API');
    });

    socket.on('attendance:status-update', async (data) => {
        console.log('[ATTENDANCE-SOCKET-V2] Legacy status update - refreshing');
        const employeeId = state.user?.id;
        if (employeeId) {
            await fetchAttendanceStatus(employeeId);
            updateTimerDisplay();
        }
    });

    // Team Attendance: any employee check-in/out while manager is watching
    socket.on('attendance:team-update', async (data) => {
        if (!teamAttendanceRefreshHandler) return;
        try {
            await teamAttendanceRefreshHandler(data);
        } catch (err) {
            console.warn('[ATTENDANCE-SOCKET-V2] Team attendance refresh failed:', err);
        }
    });
}

/**
 * Attempt to reconnect after disconnect
 */
function attemptReconnect() {
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        console.warn('[ATTENDANCE-SOCKET-V2] Max reconnect attempts reached');
        return;
    }

    reconnectAttempts++;
    console.log(`[ATTENDANCE-SOCKET-V2] Reconnect attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}`);

    setTimeout(() => {
        if (socket && !socket.connected) {
            socket.connect();
        }
    }, RECONNECT_DELAY_MS);
}

/**
 * Disconnect and cleanup
 */
export function disconnectAttendanceSocket() {
    if (socket) {
        socket.off('attendance:registered');
        socket.off('attendance:changed');
        socket.off('attendance:refresh-required');
        socket.off('attendance:started');
        socket.off('attendance:stopped');
        socket.off('attendance:sync');
        socket.off('attendance:status-update');
    }

    isConnected = false;
    console.log('[ATTENDANCE-SOCKET-V2] Disconnected and cleaned up');
}

/**
 * Check if socket is connected
 */
export function isSocketConnected() {
    return isConnected && socket?.connected;
}

// ================== BACKWARD COMPATIBILITY ==================

// These functions are no-ops for backward compatibility
export function recordUserAction() {
    // No-op - we don't track user actions for socket sync anymore
}

export function markBackendStateLoaded() {
    // No-op - backend is always authoritative now
}

// Export for use in other modules
export { socket };
