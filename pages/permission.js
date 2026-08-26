import { state } from "../state.js";
import { getPageContentHTML } from "../utils.js";
import { renderModal, closeModal } from "../components/modal.js";
import { updateNotificationBadge } from "../features/notificationApi.js";
import {
  createPermissionRequest,
  fetchPermissionRequests,
} from "../features/permissionApi.js";
import { fetchShiftSettings } from "../features/shiftSettingsApi.js";

// -------------------------------------------------------------
// Local time helpers (disable past times for today's date)
// -------------------------------------------------------------
const getTodayDateStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const toDateStr = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const getNowTimeStr = () => {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

/** Remaining days of the current work week (today .. Fri/Sat), excluding Sunday. */
const getRemainingWorkWeekDates = (workWeek = "mon-sat") => {
  const today = new Date();
  const monday = new Date(today);
  const isoDow = (today.getDay() + 6) % 7; // Mon=0 ... Sun=6
  monday.setDate(today.getDate() - isoDow);
  const lastIdx = workWeek === "mon-fri" ? 4 : 5; // Fri or Sat offset from Monday
  const dates = [];
  for (let i = isoDow; i <= lastIdx; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    dates.push(toDateStr(d));
  }
  return dates;
};

const formatCompensationLabel = (req) => {
  if (!req.compensationMode || req.compensationMode === "none") return "-";
  if (req.compensated) return `✅ Compensated (${req.compensationHours}h)`;
  const label = req.compensationMode === "today" ? "Today" : `Makeup: ${req.makeupDate || "-"}`;
  return `⏳ ${req.compensationHours}h due (${label})`;
};

const getPermissionContentHTML = () => {
  const uniqueRequests = (state.permissionRequests || [])
    .filter((req, idx, arr) => arr.findIndex((r) => r.id === req.id) === idx);

  const requestRows = uniqueRequests
    .map(
      (req) => `
        <tr>
            <td>${req.date}</td>
            <td>${req.startTime} - ${req.endTime}</td>
            <td>${req.reason || "-"}</td>
            <td><span class="status-badge ${req.status.toLowerCase()}">${req.status}</span></td>
            <td>${formatCompensationLabel(req)}</td>
        </tr>
    `
    )
    .join("");

  return `
        <div class="card">
            <h3 style="margin-bottom: 0.5rem;">My Permission Requests</h3>
            <p class="subtle" style="margin-bottom: 1.5rem;">
                Attendance automatically pauses at the start time you request, whether or not it has
                been approved yet. Approval is just for record-keeping. You must click Check In yourself
                to resume once you're back.
            </p>
            <div class="table-container">
                <table class="table">
                    <thead>
                        <tr>
                            <th>Date</th>
                            <th>Time</th>
                            <th>Reason</th>
                            <th>Status</th>
                            <th>Compensation</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${requestRows ||
    `<tr><td colspan="5" class="placeholder-text">No permission requests found.</td></tr>`
    }
                    </tbody>
                </table>
            </div>
        </div>
    `;
};

export const renderPermissionPage = async () => {
  document.getElementById("app-content").innerHTML = `
    <div class="loading-screen">
      <p>Loading Permission requests...</p>
    </div>
  `;

  state.permissionRequests = [];

  try {
    const empId = state.user?.id || state.user?.employee_id;
    if (empId) {
      state.permissionRequests = await fetchPermissionRequests({ employeeId: empId });
    }
  } catch (err) {
    console.error("Error fetching permission requests:", err);
    state.permissionRequests = [];
  }

  const controls = `
    <button id="request-permission-btn" class="btn btn-primary">
      <i class="fa-solid fa-plus"></i> REQUEST PERMISSION
    </button>
  `;
  const content = getPermissionContentHTML();

  document.getElementById("app-content").innerHTML = getPageContentHTML(
    "Permission",
    content,
    controls
  );
  // Note: the "REQUEST PERMISSION" button click is handled by the global
  // delegated click listener in index.js (mirrors request-compoff-btn).
};

export const showRequestPermissionModal = async () => {
  const today = getTodayDateStr();
  const nowTime = getNowTimeStr();

  // Look up the employee's work week (mon-fri / mon-sat) to constrain the
  // "Compensate This Week" makeup-day picker to real remaining work days.
  let workWeek = "mon-sat";
  try {
    const empId = state.user?.id || state.user?.employee_id;
    const settings = await fetchShiftSettings();
    const row = (settings?.employees || []).find(
      (e) => String(e.employee_id || "").toUpperCase() === String(empId || "").toUpperCase()
    );
    workWeek = row?.work_week || settings?.defaults?.work_week || "mon-sat";
  } catch (err) {
    console.warn("[PERMISSION] Could not load work week, defaulting to mon-sat:", err);
  }
  const remainingWorkDates = getRemainingWorkWeekDates(workWeek);

  const formHTML = `
        <div class="modal-form modern-form leave-form permission-request-form">
            <div class="form-section">
                <div class="form-grid">
                    <div class="form-field">
                        <label class="form-label" for="permissionDate">Date</label>
                        <input type="date" id="permissionDate" class="input-control" min="${today}" value="${today}" required>
                    </div>
                    <div class="form-field">
                        <label class="form-label" for="permissionStartTime">Start Time</label>
                        <input type="time" id="permissionStartTime" class="input-control" required>
                    </div>
                    <div class="form-field">
                        <label class="form-label" for="permissionEndTime">End Time</label>
                        <input type="time" id="permissionEndTime" class="input-control" required>
                    </div>
                    <div class="form-field">
                        <label class="form-label" for="permissionReason">Reason</label>
                        <textarea id="permissionReason" class="input-control" rows="4" placeholder="Enter reason" required></textarea>
                    </div>
                    <div class="form-field" style="grid-column: 1 / -1;">
                        <label class="form-label">Compensation</label>
                        <p class="subtle" style="margin: 0 0 8px 0; font-size: 0.85rem;">
                            If this permission falls near/at the end of your shift, you can choose to make up
                            the hours instead of ending your day short.
                        </p>
                        <div style="display:flex; gap: 16px; flex-wrap: wrap;">
                            <label style="display:flex; align-items:center; gap:6px; font-weight:normal;">
                                <input type="radio" name="compensationMode" value="none" checked> Don't compensate
                            </label>
                            <label style="display:flex; align-items:center; gap:6px; font-weight:normal;">
                                <input type="radio" name="compensationMode" value="today"> Compensate today
                            </label>
                            <label style="display:flex; align-items:center; gap:6px; font-weight:normal;">
                                <input type="radio" name="compensationMode" value="week"> Compensate this week
                            </label>
                        </div>
                        <div id="permissionMakeupDateField" class="form-field" style="margin-top: 10px; display:none;">
                            <label class="form-label" for="permissionMakeupDate">Makeup Day (this week)</label>
                            <select id="permissionMakeupDate" class="input-control">
                                ${remainingWorkDates.map((d) => `<option value="${d}">${d}</option>`).join("")}
                            </select>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `;
  renderModal("Request Permission", formHTML, "submit-permission-btn");

  // Disable past start times when the selected date is today.
  const dateInput = document.getElementById("permissionDate");
  const startInput = document.getElementById("permissionStartTime");
  const applyMinTime = () => {
    if (dateInput.value === today) {
      startInput.min = nowTime;
      if (startInput.value && startInput.value < nowTime) {
        startInput.value = "";
      }
    } else {
      startInput.removeAttribute("min");
    }
  };
  dateInput?.addEventListener("change", applyMinTime);
  applyMinTime();

  // Show/hide the makeup-day picker based on the selected compensation mode.
  const makeupField = document.getElementById("permissionMakeupDateField");
  document.querySelectorAll('input[name="compensationMode"]').forEach((radio) => {
    radio.addEventListener("change", (e) => {
      makeupField.style.display = e.target.value === "week" ? "block" : "none";
    });
  });
};

export const handleRequestPermission = async (e) => {
  e.preventDefault();

  const employeeId = state.user?.id || state.user?.employee_id;
  const date = document.getElementById("permissionDate")?.value || "";
  const startTime = document.getElementById("permissionStartTime")?.value || "";
  const endTime = document.getElementById("permissionEndTime")?.value || "";
  const reason = document.getElementById("permissionReason")?.value || "";
  const trimmedReason = reason.trim();
  const compensationMode =
    document.querySelector('input[name="compensationMode"]:checked')?.value || "none";
  const makeupDate = document.getElementById("permissionMakeupDate")?.value || "";

  if (!employeeId || !date || !startTime || !endTime || !trimmedReason) {
    alert("Please fill all required fields.");
    return;
  }

  if (endTime <= startTime) {
    alert("End time must be after start time.");
    return;
  }

  const today = getTodayDateStr();
  if (date === today && startTime < getNowTimeStr()) {
    alert("Start time cannot be in the past.");
    return;
  }
  if (date < today) {
    alert("Cannot apply permission for a past date.");
    return;
  }
  if (compensationMode === "week" && !makeupDate) {
    alert("Please select a makeup day for this week.");
    return;
  }

  try {
    await createPermissionRequest({
      employee_id: employeeId,
      date,
      start_time: startTime,
      end_time: endTime,
      reason: trimmedReason,
      compensation_mode: compensationMode,
      makeup_date: compensationMode === "week" ? makeupDate : undefined,
    });
    closeModal();
    await renderPermissionPage();
    await updateNotificationBadge();
  } catch (err) {
    console.error("Error creating permission request:", err);
    alert(`❌ Failed to submit permission request: ${err.message || err}`);
  }
};
