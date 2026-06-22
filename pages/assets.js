import { getPageContentHTML } from "../utils.js";
import { state } from "../state.js";
import { renderModal, closeModal } from "../components/modal.js";
import { API_BASE_URL } from '../config.js';
import { listAllEmployees, isActiveEmployee } from '../features/employeeApi.js';
import { getUserAccessContext } from '../utils/accessControl.js';

const API_BASE = `${API_BASE_URL}/api/assets`;
const EMPLOYEE_DIRECTORY_CACHE_TTL_MS = 5 * 60 * 1000;

const escapeHtml = (value = "") =>
  String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

let assetEmployeeDirectoryCache = {
  data: [],
  fetchedAt: 0,
};
let canManageAssets = false;

const shapeEmployeeRecord = (entry = {}) => {
  const id = String(entry.employee_id || entry.id || "").trim();
  const name = (entry.name || [entry.first_name, entry.last_name].filter(Boolean).join(" ")).trim();
  const email = String(entry.email || "").trim();
  const displayName = name || email || id;
  return {
    id,
    name: displayName,
    department: entry.department || entry.team || "",
    isActive: isActiveEmployee(entry),
  };
};

const loadEmployeeDirectoryForAssets = async () => {
  const now = Date.now();
  if (
    assetEmployeeDirectoryCache.data.length &&
    now - assetEmployeeDirectoryCache.fetchedAt < EMPLOYEE_DIRECTORY_CACHE_TTL_MS
  ) {
    return assetEmployeeDirectoryCache.data;
  }
  try {
    const rawEmployees = await listAllEmployees();
    const shaped = (rawEmployees || [])
      .map(shapeEmployeeRecord)
      .filter((emp) => emp.id && emp.name)
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    assetEmployeeDirectoryCache = { data: shaped, fetchedAt: now };
    return shaped;
  } catch (err) {
    console.warn("Failed to load employee directory for assets", err);
    assetEmployeeDirectoryCache = { data: [], fetchedAt: now };
    return [];
  }
};

const loadClientDirectoryForAssets = async () => {
  try {
    const res = await fetch(`${API_BASE_URL}/api/clients?page=1&pageSize=5000&sort=name`);
    const data = await res.json();
    const rawClients = Array.isArray(data) ? data : data?.clients || [];

    const dedup = new Map();
    for (const entry of rawClients) {
      const clientName = String(entry?.crc6f_clientname || "").trim();
      const companyName = String(entry?.crc6f_companyname || "").trim();
      const clientId = String(entry?.crc6f_clientid || "").trim();
      const value = clientName || companyName || clientId;
      if (!value) continue;

      const key = value.toLowerCase();
      if (dedup.has(key)) continue;
      const label = clientId ? `${value} (${clientId})` : value;
      dedup.set(key, { value, label });
    }

    return Array.from(dedup.values()).sort((a, b) =>
      a.value.localeCompare(b.value, undefined, { sensitivity: "base" })
    );
  } catch (err) {
    console.warn("Failed to load clients for assets", err);
    return [];
  }
};

// -------------------- FETCH ASSETS --------------------
export const fetchAssets = async () => {
  try {
    const res = await fetch(API_BASE);
    const data = await res.json();
    state.assets = data.map((a) => ({
      id: a.crc6f_assetid,
      name: a.crc6f_assetname,
      serialNo: a.crc6f_serialnumber,
      category: a.crc6f_assetcategory,
      client: a.crc6f_client,
      location: a.crc6f_location,
      status: a.crc6f_assetstatus,
      assignedTo: a.crc6f_assignedto,
      employeeId: a.crc6f_employeeid,
      assignedOn: a.crc6f_assignedon,
    }));
  } catch (err) {
    console.error("Error fetching assets:", err);
    state.assets = [];
  }
};

// -------------------- RENDER PAGE --------------------
export const renderAssetsPage = async () => {
  try {
    const { isAdmin } = getUserAccessContext();
    canManageAssets = Boolean(isAdmin);

    // Fetch latest assets from Dataverse
    await fetchAssets();

    const controls = canManageAssets
      ? `<button id="add-asset-btn" class="btn btn-primary"><i class="fa-solid fa-plus"></i> ADD NEW ASSET</button>`
      : "";
    const statusClass = (status) => status.toLowerCase().replace(" ", "");

    const tableRows = state.assets
      .map(
        (asset) => `
        <tr>
            <td>${asset.id}</td>
            <td>${asset.name}</td>
            <td>${asset.serialNo}</td>
            <td>${asset.category}</td>
            <td>${asset.client || "-"}</td>
            <td>${asset.assignedTo || "-"}</td>
            <td>${asset.employeeId || "-"}</td>
            <td>${asset.assignedOn || "-"}</td>
            <td>${asset.location}</td>
            <td><span class="status-badge ${statusClass(asset.status)}">${asset.status
          }</span></td>
            <td class="actions-cell">
                ${canManageAssets ? `
                <button class="icon-btn action-btn edit edit-asset-btn" data-id="${asset.id
          }"><i class="fa-solid fa-pen-to-square"></i></button>
                <button class="icon-btn action-btn delete delete-asset-btn" data-id="${asset.id
          }"><i class="fa-solid fa-trash"></i></button>
                ` : "-"}
            </td>
        </tr>
    `
      )
      .join("");

    const content = `
        <div class="card">
            <div class="table-container">
                <table class="table">
                    <thead>
                        <tr>
                            <th>Asset ID</th>
                            <th>Asset Name</th>
                            <th>Serial No</th>
                            <th>Category</th>
                            <th>Client</th>
                            <th>Assigned To</th>
                            <th>Employee ID</th>
                            <th>Assigned On</th>
                            <th>Location</th>
                            <th>Status</th>
                            <th>Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${tableRows ||
      `<tr><td colspan="11">No assets found. Click ADD NEW ASSET to add one.</td></tr>`
      }
                    </tbody>
                </table>
            </div>
        </div>
    `;

    document.getElementById("app-content").innerHTML = getPageContentHTML(
      "Assets",
      content,
      controls
    );

    // -------------------- EVENT LISTENERS --------------------
    document
      .getElementById("add-asset-btn")
      ?.addEventListener("click", () => showAssetModal());

    if (canManageAssets) {
      document.querySelectorAll(".edit-asset-btn").forEach((btn) => {
        btn.addEventListener("click", () => showAssetModal(btn.dataset.id));
      });

      document.querySelectorAll(".delete-asset-btn").forEach((btn) => {
        btn.addEventListener("click", () =>
          showDeleteConfirmModal(btn.dataset.id)
        );
      });
    }
  } catch (err) {
    console.error("Error rendering assets page:", err);
    document.getElementById(
      "app-content"
    ).innerHTML = `<p class="error">Failed to load assets.</p>`;
  }
};

// -------------------- SHOW MODAL --------------------
export const showAssetModal = async (assetId) => {
  if (!canManageAssets) {
    alert("Only admin can modify assets");
    return;
  }

  const isEditMode = Boolean(assetId);
  const asset = isEditMode ? state.assets.find((a) => a.id === assetId) : null;

  const [employees, clients] = await Promise.all([
    loadEmployeeDirectoryForAssets(),
    loadClientDirectoryForAssets(),
  ]);
  let hasPrefilledSelection = false;
  const employeeOptions = employees
    .map((emp) => {
      const isSelected = Boolean(
        (asset?.employeeId && emp.id && emp.id.toUpperCase() === asset.employeeId.toUpperCase()) ||
          (!asset?.employeeId && asset?.assignedTo && emp.name && emp.name.toLowerCase() === asset.assignedTo.toLowerCase())
      );
      if (!emp.isActive && !isSelected) return "";
      
      if (isSelected) hasPrefilledSelection = true;
      let label = emp.department ? `${emp.name} · ${emp.department}` : emp.name;
      if (!emp.isActive) label += " (Inactive)";
      return `<option value="${escapeHtml(emp.id)}" data-name="${escapeHtml(emp.name)}"${isSelected ? " selected" : ""}>${escapeHtml(label)}</option>`;
    })
    .join("");

  let fallbackOption = "";
  if (!hasPrefilledSelection && asset?.assignedTo) {
    const label = asset.employeeId ? `${asset.assignedTo} (${asset.employeeId})` : asset.assignedTo;
    fallbackOption = `<option value="${escapeHtml(asset?.employeeId || "")}" data-name="${escapeHtml(asset.assignedTo)}" selected>${escapeHtml(label)} • Not in directory</option>`;
    hasPrefilledSelection = true;
  }

  const hasEmployeeOptions = Boolean(employeeOptions || fallbackOption);
  const placeholderSelectedAttr = hasPrefilledSelection ? "" : " selected";
  const placeholderLabel = employees.length ? "Select employee" : "No employees available";
  const assignedDropdownHTML = `
      <select class="input-control" id="assignedTo" ${hasEmployeeOptions ? "" : "disabled"}>
          <option value="" disabled${placeholderSelectedAttr}>${placeholderLabel}</option>
          ${fallbackOption}
          ${employeeOptions || ""}
      </select>
  `;
  const employeeIdReadonlyAttr = hasEmployeeOptions ? "readonly" : "";

  const selectedClientValue = String(asset?.client || "").trim();
  let hasClientPrefilledSelection = false;
  const clientOptions = clients
    .map((client) => {
      const isSelected = Boolean(
        selectedClientValue &&
          client.value &&
          client.value.toLowerCase() === selectedClientValue.toLowerCase()
      );
      if (isSelected) hasClientPrefilledSelection = true;
      return `<option value="${escapeHtml(client.value)}"${isSelected ? " selected" : ""}>${escapeHtml(client.label)}</option>`;
    })
    .join("");

  let clientFallbackOption = "";
  if (!hasClientPrefilledSelection && selectedClientValue) {
    clientFallbackOption = `<option value="${escapeHtml(selectedClientValue)}" selected>${escapeHtml(selectedClientValue)} • Not in clients list</option>`;
    hasClientPrefilledSelection = true;
  }

  const clientPlaceholderSelectedAttr = hasClientPrefilledSelection ? "" : " selected";
  const clientPlaceholderLabel = clients.length ? "Select client" : "No clients available";
  const clientDisabledAttr = clients.length ? "" : " disabled";
  const clientDropdownHTML = `
      <select class="input-control" id="assetClient"${clientDisabledAttr}>
          <option value=""${clientPlaceholderSelectedAttr}>${clientPlaceholderLabel}</option>
          ${clientFallbackOption}
          ${clientOptions || ""}
      </select>
  `;

  const formHTML = `
      <div class="modal-form modern-form leave-form asset-form-v2">
          <!-- Section 1: Asset Information -->
          <div class="form-section">
              <div class="form-section-header">
                  <div>
                      <p class="form-eyebrow">Asset Details</p>
                      <h3>Basic Information</h3>
                  </div>
                  <p class="form-section-copy">Enter the core details for this asset.</p>
              </div>
              <div class="form-grid two-col">
                  <div class="form-field with-icon">
                      <label class="form-label" for="assetName">Asset Name</label>
                      <div class="input-wrapper">
                          <i class="fa-solid fa-laptop"></i>
                          <input class="input-control" type="text" id="assetName" required value="${asset?.name || ""}" placeholder="Dell Laptop">
                      </div>
                  </div>
                  <div class="form-field with-icon">
                      <label class="form-label" for="serialNo">Serial Number</label>
                      <div class="input-wrapper">
                          <i class="fa-solid fa-barcode"></i>
                          <input class="input-control" type="text" id="serialNo" required value="${asset?.serialNo || ""}" placeholder="SN123456789">
                      </div>
                  </div>
                  <div class="form-field with-icon">
                      <label class="form-label" for="assetCategory">Category</label>
                      <div class="input-wrapper">
                          <i class="fa-solid fa-layer-group"></i>
                          <select class="input-control" id="assetCategory" required>
                              <option value="" disabled ${!asset?.category ? 'selected' : ''}>Select category</option>
                              <option ${asset?.category === "Laptop" ? "selected" : ""}>Laptop</option>
                              <option ${asset?.category === "Monitor" ? "selected" : ""}>Monitor</option>
                              <option ${asset?.category === "Charger" ? "selected" : ""}>Charger</option>
                              <option ${asset?.category === "Keyboard" ? "selected" : ""}>Keyboard</option>
                              <option ${asset?.category === "Headset" ? "selected" : ""}>Headset</option>
                              <option ${asset?.category === "Accessory" ? "selected" : ""}>Accessory</option>
                          </select>
                      </div>
                  </div>
                  <div class="form-field with-icon">
                      <label class="form-label" for="assetClient">Client</label>
                      <div class="input-wrapper">
                          <i class="fa-solid fa-building"></i>
                          ${clientDropdownHTML}
                      </div>
                  </div>
                  <div class="form-field with-icon">
                      <label class="form-label" for="assetLocation">Location</label>
                      <div class="input-wrapper">
                          <i class="fa-solid fa-location-dot"></i>
                          <input class="input-control" type="text" id="assetLocation" required value="${asset?.location || ""}" placeholder="Office Building A">
                      </div>
                  </div>
              </div>
          </div>
          
          <!-- Section 2: Assignment Details -->
          <div class="form-section">
              <div class="form-section-header">
                  <div>
                      <p class="form-eyebrow">Assignment & Status</p>
                      <h3>Assignment Information</h3>
                  </div>
                  <p class="form-section-copy">Track current ownership and lifecycle state for this asset.</p>
              </div>
              <div class="form-grid two-col">
                  <div class="form-field with-icon">
                      <label class="form-label" for="assetStatus">Status</label>
                      <div class="input-wrapper">
                          <i class="fa-solid fa-signal"></i>
                          <select class="input-control" id="assetStatus">
                              <option ${asset?.status === "In Use" ? "selected" : ""}>In Use</option>
                              <option ${asset?.status === "Not Use" ? "selected" : ""}>Not Use</option>
                              <option ${asset?.status === "Repair" ? "selected" : ""}>Repair</option>
                          </select>
                      </div>
                  </div>
                  <div class="form-field with-icon">
                      <label class="form-label" for="assignedOn">Assigned On</label>
                      <div class="input-wrapper">
                          <i class="fa-regular fa-calendar"></i>
                          <input class="input-control" type="date" id="assignedOn" value="${asset?.assignedOn || ""}">
                      </div>
                  </div>
                  <div class="form-field with-icon">
                      <label class="form-label" for="assignedTo">Assigned To</label>
                      <div class="input-wrapper">
                          <i class="fa-solid fa-user"></i>
                          ${assignedDropdownHTML}
                      </div>
                      <p class="helper-text">Select the employee currently using this asset.</p>
                  </div>
                  <div class="form-field with-icon">
                      <label class="form-label" for="employeeId">Employee ID</label>
                      <div class="input-wrapper">
                          <i class="fa-solid fa-id-badge"></i>
                          <input class="input-control" type="text" id="employeeId" value="${asset?.employeeId || ""}" placeholder="EMP-001" ${employeeIdReadonlyAttr}>
                      </div>
                  </div>
              </div>
          </div>
      </div>
  `;

  renderModal(isEditMode ? "Edit Asset" : "Add New Asset", formHTML, [
    {
      id: "cancel-asset-btn",
      text: "Cancel",
      className: "btn-secondary",
      type: "button",
    },
    {
      id: "save-asset-btn",
      text: isEditMode ? "Update" : "Save",
      className: "btn-primary",
      type: "button",
    },
  ]);

  // Attach listener
  document.getElementById("save-asset-btn").onclick = async () => {
    try {
      await handleSaveAsset(assetId);
    } catch (err) {
      console.error(err);
      alert("Error saving asset: " + err.message);
    }
  };
  document.getElementById("cancel-asset-btn").onclick = closeModal;

  const assignedSelect = document.getElementById("assignedTo");
  const employeeIdInput = document.getElementById("employeeId");
  if (assignedSelect && employeeIdInput && !assignedSelect.disabled) {
    const syncEmployeeId = () => {
      const selectedOption = assignedSelect.options[assignedSelect.selectedIndex];
      if (selectedOption && selectedOption.value) {
        employeeIdInput.value = selectedOption.value;
      } else if (!isEditMode) {
        employeeIdInput.value = "";
      }
    };
    assignedSelect.addEventListener("change", syncEmployeeId);
    syncEmployeeId();
  }
};

export const handleSaveAsset = async (assetId) => {
  if (!canManageAssets) {
    alert("Only admin can modify assets");
    return;
  }

  const isEditMode = Boolean(assetId);

  const assignedSelect = document.getElementById("assignedTo");
  const selectedAssignedOption = assignedSelect
    ? assignedSelect.options[assignedSelect.selectedIndex]
    : null;
  const assignedEmployeeName = selectedAssignedOption?.dataset?.name || selectedAssignedOption?.textContent?.trim() || "";
  const assignedEmployeeId = selectedAssignedOption?.value || "";

  const category = document.getElementById("assetCategory").value;
  const assetData = {
    crc6f_assetname: document.getElementById("assetName").value,
    crc6f_serialnumber: document.getElementById("serialNo").value,
    crc6f_assetcategory: category,
    crc6f_client: document.getElementById("assetClient")?.value || "",
    crc6f_location: document.getElementById("assetLocation").value,
    crc6f_assetstatus: document.getElementById("assetStatus").value,
    crc6f_assignedto: assignedEmployeeName || "",
    crc6f_employeeid: assignedEmployeeId || document.getElementById("employeeId").value,
    crc6f_assignedon: document.getElementById("assignedOn").value,
  };

  if (!isEditMode) {
    // New asset: generate ID
    const prefixMap = {
      Laptop: "LP",
      Monitor: "MO",
      Charger: "CH",
      Keyboard: "KB",
      Headset: "HS",
      Accessory: "AC",
    };
    const prefix = prefixMap[category] || "GEN";
    const count =
      state.assets.filter((a) => a.category === category).length + 1;
    assetData.crc6f_assetid = `${prefix}-${count}`;
  } else {
    // Editing existing asset
    const oldAsset = state.assets.find((a) => a.id === assetId);
    if (!oldAsset) throw new Error("Asset not found for update");

    // If category changed, regenerate asset ID
    if (oldAsset.category !== category) {
      const prefixMap = {
        Laptop: "LP",
        Monitor: "MO",
        Charger: "CH",
        Keyboard: "KB",
        Headset: "HS",
        Accessory: "AC",
      };
      const prefix = prefixMap[category] || "GEN";
      const count =
        state.assets.filter((a) => a.category === category).length + 1;
      assetData.crc6f_assetid = `${prefix}-${count}`;
    } else {
      assetData.crc6f_assetid = assetId; // keep old ID if category didn't change
    }
  }

  try {
    let res;
    if (isEditMode) {
      res = await fetch(`${API_BASE}/update/${assetId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(assetData),
      });
    } else {
      res = await fetch(API_BASE, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(assetData),
      });
    }

    const result = await res.json();
    if (!res.ok) throw new Error(result.error || "Failed to save asset");

    // await fetchAssets(); // refresh UI from Dataverse
    await renderAssetsPage(); // ✅ refresh UI instantly
    closeModal();
  } catch (err) {
    console.error(err);
    alert("Error saving asset: " + err.message);
  }
};

export const showDeleteConfirmModal = (assetId) => {
  if (!canManageAssets) {
    alert("Only admin can modify assets");
    return;
  }

  const asset = state.assets.find((a) => a.id === assetId);
  if (!asset) return;

  const bodyHTML = `<p>Are you sure you want to delete <strong>${asset.name} (${asset.id})</strong>? This action cannot be undone.</p>`;

  renderModal("Confirm Deletion", bodyHTML, [
    {
      id: "cancel-delete-btn",
      text: "Cancel",
      className: "btn-secondary",
      type: "button",
    },
    {
      id: "confirm-delete-btn",
      text: "Delete",
      className: "btn-danger",
      type: "button",
    },
  ]);

  // ✅ Add working listeners
  document.getElementById("cancel-delete-btn").onclick = closeModal;
  document.getElementById("confirm-delete-btn").onclick = async () => {
    try {
      await handleDeleteAsset(assetId);
      closeModal(); // ✅ also close after successful delete
    } catch (err) {
      console.error(err);
      alert("Error deleting asset: " + err.message);
    }
  };
};

export const handleDeleteAsset = async (assetId) => {
  if (!canManageAssets) {
    alert("Only admin can modify assets");
    return;
  }

  try {
    const res = await fetch(`${API_BASE}/delete/${assetId}`, {
      method: "DELETE",
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || "Failed to delete asset");

    // await fetchAssets();
    await renderAssetsPage(); // ✅ refresh UI instantly
    closeModal();
  } catch (err) {
    console.error(err);
    alert("Error deleting asset: " + err.message);
  }
};
