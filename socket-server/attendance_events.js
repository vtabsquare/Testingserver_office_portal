// attendance_events.js - Stateless Socket.IO Attendance Module
// CRITICAL: This module NEVER stores timer state
// It ONLY broadcasts events - clients fetch data from backend API

// ❌ REMOVED: activeTimers memory object
// ❌ REMOVED: Timer calculations
// ❌ REMOVED: Status derivation
// ❌ REMOVED: Duration tracking
// ✅ ONLY: Event broadcasting

module.exports = (io) => {
  console.log('⏱️ Attendance Events Module Loaded (Stateless)');

  // HTTP endpoint for backend to trigger broadcasts
  // This allows Flask to notify all connected clients of changes
  const express = require('express');
  const router = express.Router();

  // Broadcast endpoint - called by Flask backend
  router.post('/emit', (req, res) => {
    try {
      const { event, data } = req.body;

      if (!event || !data) {
        return res.status(400).json({ error: 'Missing event or data' });
      }

      const employeeId = data.employee_id;

      if (employeeId) {
        const uid = String(employeeId).trim().toUpperCase();
        // Broadcast to specific employee's room
        const room = `attendance:${uid}`;
        io.to(room).emit(event, data);
        console.log(`[ATTENDANCE-EVENTS] Emitted ${event} to room ${room}`);

        // Notify team attendance watchers (managers on Team Attendance page)
        if (
          event === 'attendance:checkin' ||
          event === 'attendance:checkout' ||
          event === 'attendance:team-update' ||
          event === 'attendance:changed'
        ) {
          io.to('attendance:team-watchers').emit('attendance:team-update', {
            employee_id: uid,
            event_type: event,
            serverNow: Date.now(),
          });
        }
      } else {
        // Broadcast to all connected clients
        io.emit(event, data);
        console.log(`[ATTENDANCE-EVENTS] Emitted ${event} to all clients`);
      }

      res.json({ success: true });
    } catch (error) {
      console.error('[ATTENDANCE-EVENTS] Emit error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Socket connection handler
  io.on('connection', (socket) => {
    console.log(`[ATTENDANCE-EVENTS] Client connected: ${socket.id}`);

    // ----------------------------------------
    // REGISTER - Join employee's attendance room
    // ----------------------------------------
    socket.on('attendance:register', ({ employee_id }) => {
      if (!employee_id) return;

      const uid = String(employee_id).trim().toUpperCase();
      socket.data.employee_id = uid;

      const room = `attendance:${uid}`;
      socket.join(room);

      console.log(`[ATTENDANCE-EVENTS] ${uid} joined room ${room}`);

      // ❌ DO NOT send any timer state
      // ✅ Client should call /api/v2/attendance/status to get current state
      socket.emit('attendance:registered', {
        employee_id: uid,
        room: room,
        message: 'Registered for attendance events. Call /api/v2/attendance/status for current state.'
      });
    });

    // Managers / team leads viewing Team Attendance join this room
    socket.on('attendance:register-team-watcher', () => {
      socket.join('attendance:team-watchers');
      socket.data.team_watcher = true;
      console.log(`[ATTENDANCE-EVENTS] ${socket.id} joined attendance:team-watchers`);
      socket.emit('attendance:team-watcher-registered', { room: 'attendance:team-watchers' });
    });

    socket.on('attendance:unregister-team-watcher', () => {
      socket.leave('attendance:team-watchers');
      socket.data.team_watcher = false;
    });

    // ----------------------------------------
    // REQUEST REFRESH - Client wants fresh data
    // ----------------------------------------
    socket.on('attendance:request-refresh', ({ employee_id }) => {
      if (!employee_id) return;

      const uid = String(employee_id).trim().toUpperCase();

      // ❌ DO NOT send any cached state
      // ✅ Tell client to fetch from backend
      socket.emit('attendance:refresh-required', {
        employee_id: uid,
        message: 'Fetch fresh data from /api/v2/attendance/status'
      });

      console.log(`[ATTENDANCE-EVENTS] Refresh requested for ${uid}`);
    });

    // ----------------------------------------
    // DISCONNECT - Cleanup
    // ----------------------------------------
    socket.on('disconnect', () => {
      const uid = socket.data.employee_id;
      if (uid) {
        console.log(`[ATTENDANCE-EVENTS] ${uid} disconnected`);
      }
      // ❌ DO NOT clear any timer state (we don't have any!)
    });
  });

  // Return router for HTTP endpoints
  return router;
};

// ================== MIGRATION NOTES ==================
// 
// OLD (attendance_module.js):
// - Stored activeTimers in memory
// - Calculated elapsed time on server
// - Sent timer state on register
// - Tracked check-in/check-out timestamps
// - Derived status (A/HL/P) on socket server
// 
// NEW (attendance_events.js):
// - ZERO state storage
// - ZERO calculations
// - Only broadcasts events
// - Clients fetch data from /api/v2/attendance/status
// - Backend is single source of truth
// 
// EVENTS EMITTED:
// - attendance:changed    - Something changed, client should refresh
// - attendance:registered - Client successfully joined room
// - attendance:refresh-required - Client should fetch from API
// 
// EVENTS RECEIVED:
// - attendance:register        - Client joins their room
// - attendance:request-refresh - Client wants fresh data
// 
// ================== END MIGRATION NOTES ==================
