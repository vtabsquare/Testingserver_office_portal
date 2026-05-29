// server.js — Unified Socket Server for Meet + Chat

const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");

// V2: Use stateless attendance events module (backend-authoritative)
const attachAttendanceEventsV2 = require("./attendance_events");
// Legacy module for backward compatibility during transition
const attachAttendanceModuleLegacy = require("./attendance_module");

// Create HTTP + Socket server
const app = express();
app.use(cors({ origin: "*", credentials: true }));
app.use(express.json({ limit: "25mb" }));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

// Attach modules
require("./chat_module")(io);
require("./meet_module")(io);
// V2: Stateless attendance events (backend-authoritative)
const attendanceRouter = attachAttendanceEventsV2(io);
if (attendanceRouter) {
  app.use(attendanceRouter);
}
// Legacy module for backward compatibility
attachAttendanceModuleLegacy(io);

// HTTP bridge used by Python backend (emit_socket_event)
// Expects body: { event: string, data: any }
app.post("/emit", (req, res) => {
  try {
    const { event, data } = req.body || {};

    if (!event) {
      return res.status(400).json({ success: false, error: "event_required" });
    }

    console.log("[UNIFIED-SOCKET] /emit", { event, data });

    // Helper: emit to conversation room if id present, else broadcast
    const emitToConversation = (evt, payload) => {
      if (payload && payload.conversation_id) {
        const room = String(payload.conversation_id);
        io.to(room).emit(evt, payload);
      } else {
        io.emit(evt, payload);
      }
    };

    switch (event) {
      case "new_message": {
        emitToConversation("new_message", data);
        break;
      }

      // -----------------------------------------
      // ATTENDANCE EVENTS (from Flask backend)
      // -----------------------------------------
      case "attendance:checkin": {
        const { employee_id, checkinTime, checkinTimestamp, baseSeconds } = data || {};
        if (employee_id) {
          const uid = String(employee_id).trim().toUpperCase();
          const room = `attendance:${uid}`;

          const attendanceModule = require("./attendance_module");
          attendanceModule.activeTimers[uid] = {
            isRunning: true,
            checkinTime,
            checkinTimestamp: checkinTimestamp || Date.now(),
            baseSeconds: baseSeconds || 0,
            lastStatus: "A",
          };

          io.to(room).emit("attendance:started", {
            employee_id: uid,
            checkinTime,
            checkinTimestamp: attendanceModule.activeTimers[uid].checkinTimestamp,
            baseSeconds: baseSeconds || 0,
            serverNow: Date.now(),
          });
          io.to("attendance:team-watchers").emit("attendance:team-update", {
            employee_id: uid,
            event_type: "attendance:checkin",
            serverNow: Date.now(),
          });
        }
        break;
      }

      case "attendance:checkout": {
        const { employee_id, checkoutTime, totalSeconds, status } = data || {};
        if (employee_id) {
          const uid = String(employee_id).trim().toUpperCase();
          const room = `attendance:${uid}`;

          const attendanceModule = require("./attendance_module");
          // Preserve last stopped state so new device logins don't reset to 0.
          attendanceModule.activeTimers[uid] = {
            isRunning: false,
            checkoutTime,
            totalSeconds: typeof totalSeconds === 'number' ? totalSeconds : 0,
            status: status || attendanceModule.deriveStatus(typeof totalSeconds === 'number' ? totalSeconds : 0),
          };

          io.to(room).emit("attendance:stopped", {
            employee_id: uid,
            checkoutTime,
            totalSeconds,
            status,
            serverNow: Date.now(),
          });
        }
        break;
      }

      case "attendance:status-update": {
        const { employee_id, totalSeconds, status } = data || {};
        if (employee_id) {
          const uid = String(employee_id).trim().toUpperCase();
          const room = `attendance:${uid}`;
          io.to(room).emit("attendance:status-update", {
            employee_id: uid,
            totalSeconds,
            status,
            autoUpdated: true,
            serverNow: Date.now(),
          });
        }
        break;
      }

      // V2: Backend-authoritative attendance change event
      // Clients should fetch fresh data from /api/v2/attendance/status on receiving this
      case "attendance:changed": {
        const { employee_id, event_type } = data || {};
        if (employee_id) {
          const uid = String(employee_id).trim().toUpperCase();
          const room = `attendance:${uid}`;
          io.to(room).emit("attendance:changed", {
            employee_id: uid,
            event_type: event_type || "update",
            serverNow: Date.now(),
          });
          console.log(`[ATTENDANCE-V2] Broadcasted attendance:changed to room ${room}`);
        }
        break;
      }

      case "conversation_created": {
        // Notify only involved members if provided, else broadcast
        const members = Array.isArray(data && data.members) ? data.members : [];
        if (members.length) {
          members.forEach((uid) => {
            if (!uid) return;
            io.to(String(uid)).emit("conversation_created", data);
          });
        } else {
          io.emit("conversation_created", data);
        }
        break;
      }

      case "group_add_members": {
        // Unified event name expected by frontend
        emitToConversation("group_members_added", data);
        break;
      }

      case "group_members_removed":
      case "group_remove_members": {
        emitToConversation("group_members_removed", data);
        break;
      }

      case "group_renamed": {
        emitToConversation("group_renamed", data);
        break;
      }

      case "group_deleted": {
        // Frontend listens to conversation_deleted
        emitToConversation("conversation_deleted", data);
        break;
      }

      case "direct_left": {
        // Map to same shape as leave_conversation → user_left_conversation
        emitToConversation("user_left_conversation", data);
        break;
      }

      case "message_edited": {
        io.emit("message_edited", data);
        break;
      }

      case "message_deleted": {
        io.emit("message_deleted", data);
        break;
      }

      default: {
        // Fallback: broadcast raw event name for any future extensions
        io.emit(event, data);
      }
    }

    return res.json({ success: true });
  } catch (err) {
    console.error("[UNIFIED-SOCKET] /emit error", err);
    return res.status(500).json({ success: false, error: "internal_error" });
  }
});

// Start Server (Render sets PORT)
const PORT = process.env.PORT || process.env.SOCKET_PORT || 4001;
server.listen(PORT, () => {
  console.log(`🚀 Unified Socket Server running on http://localhost:${PORT}`);
});

module.exports = io;
