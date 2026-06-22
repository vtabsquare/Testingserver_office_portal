// chatapi.js
import { state } from "../state.js";

const toDataUrl = (photo) => {
  if (!photo || typeof photo !== "string") return null;
  const trimmed = photo.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("data:")) return trimmed;
  return `data:image/png;base64,${trimmed}`;
};

// ----------------------------
// API BASE (FLASK BLUEPRINT)
// ----------------------------
const resolveChatApiBase = () => {
  const envBase =
    (typeof import.meta !== "undefined" &&
      import.meta.env &&
      (import.meta.env.VITE_CHAT_API_BASE ||
        import.meta.env.VITE_API_BASE_URL)) ||
    null;

  if (envBase) {
    const normalized = envBase.replace(/\/$/, "");
    return normalized.endsWith("/chat") ? normalized : `${normalized}/chat`;
  }

  if (typeof window !== "undefined" && window.API_BASE_URL) {
    const normalized = String(window.API_BASE_URL).replace(/\/$/, "");
    return `${normalized}/chat`;
  }

  // Fallback to same-origin /chat to support proxying in prod
  return "/chat";
};

const CHAT_API_BASE = resolveChatApiBase();

// ----------------------------
// INTERNAL FETCH WRAPPER
// ----------------------------
async function apiFetch(path, options = {}) {
  const token = state.user?.token || "";
  const headers = { ...(options.headers || {}) };

  if (!(options.body instanceof FormData) && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(`${CHAT_API_BASE}${path}`, {
    ...options,
    headers,
  });

  if (res.status === 204) return null;

  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return res.json();
  return res.text();
}

// --------------------------------------------------
// 1) SEARCH EMPLOYEES
// GET /chat/employees/search?q=...
// --------------------------------------------------
export async function searchEmployees(query) {
  if (!query) return [];

  try {
    const { listActiveEmployees } = await import('./employeeApi.js');
    const arr = await listActiveEmployees();
    const q = query.toLowerCase();
    
    const filtered = arr.filter(emp => {
      const name = (emp.name || [emp.first_name, emp.last_name].filter(Boolean).join(" ")).trim().toLowerCase();
      const id = String(emp.employee_id || emp.id).toLowerCase();
      return name.includes(q) || id.includes(q);
    });

    return filtered.map((emp) => {
      const name = (emp.name || [emp.first_name, emp.last_name].filter(Boolean).join(" ")).trim();
      return {
        id: emp.employee_id || emp.id,
        name: name,
        email: emp.email,
        avatar: name.slice(0, 1).toUpperCase() || "U",
        photo: emp.photo || null,
      };
    });
  } catch (err) {
    console.error("searchEmployees error:", err);
    return [];
  }
}

// --------------------------------------------------
// 1.1 FETCH ALL EMPLOYEES (Used for Add Members)
// --------------------------------------------------
export async function fetchAllEmployees() {
  try {
    const { listActiveEmployees } = await import('./employeeApi.js');
    const arr = await listActiveEmployees();
    return (arr || []).map((emp) => {
      const name = (emp.name || [emp.first_name, emp.last_name].filter(Boolean).join(" ")).trim();
      return {
        id: emp.employee_id || emp.id,
        name: name,
        email: emp.email,
        avatar: name.slice(0, 1).toUpperCase() || "U",
        photo: emp.photo || null,
      };
    });
  } catch (err) {
    console.error("fetchAllEmployees error:", err);
    return [];
  }
}

// --------------------------------------------------
// 2) START DIRECT CHAT
// POST /chat/direct
// --------------------------------------------------
export async function startDirectChat(targetUserId) {
  const user_id = state.user?.id;
  if (!user_id) throw new Error("User not found in state");

  return apiFetch(`/direct`, {
    method: "POST",
    body: JSON.stringify({ user_id, target_id: targetUserId }),
  });
}

// --------------------------------------------------
// 3) CREATE GROUP
// POST /chat/group
// --------------------------------------------------
export async function createGroupChat(name, members) {
  return apiFetch(`/group`, {
    method: "POST",
    body: JSON.stringify({
      name,
      members,
      creator_id: state.user.id,
    }),
  });
}

// --------------------------------------------------
// 4) FETCH USER'S CONVERSATIONS
// GET /chat/conversations/<user_id>
// --------------------------------------------------
export function fetchConversations() {
  const id = state.user?.id;
  if (!id) return [];
  return apiFetch(`/conversations/${id}`);
}

// --------------------------------------------------
// 5) FETCH ALL MESSAGES OF A CONVERSATION
// GET /chat/messages/<conversation_id>
// --------------------------------------------------
export function fetchMessagesForConversation(conversationId) {
  return apiFetch(`/messages/${conversationId}`);
}

// --------------------------------------------------
// 6) SEND TEXT MESSAGE
// POST /chat/send-text
// --------------------------------------------------
export function sendTextMessage(payload) {
  return apiFetch(`/send-text`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

// --------------------------------------------------
// 7) SEND MEDIA FILE
// POST /chat/send-file
// --------------------------------------------------
export async function sendMediaMessageApi({
  conversation_id,
  sender_id,
  file,
  onProgress,
  onCancelRef,
}) {
  const form = new FormData();
  form.append("conversation_id", conversation_id);
  form.append("sender_id", sender_id);
  form.append("file", file);

  return sendWithProgress(form, { onProgress, onCancelRef });
}

// Upload with progress + cancel support
// Upload with progress + cancel support (WhatsApp-Style)
// Upload with progress + cancel support
export function sendWithProgress(formData, onProgress) {
  const xhr = new XMLHttpRequest();

  const promise = new Promise((resolve, reject) => {
    xhr.open("POST", `${CHAT_API_BASE}/send-files`, true);

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) {
        const percent = Math.round((e.loaded * 100) / e.total);
        onProgress(percent);
      }
    };

    xhr.onload = () => {
      if (xhr.status === 200) {
        try {
          resolve(JSON.parse(xhr.responseText));
        } catch (err) {
          reject(err);
        }
      } else {
        reject(xhr.responseText || "Upload failed");
      }
    };

    xhr.onerror = () => reject("Upload failed");
    // allow cross-site cookies if needed (optional, remove if not used)
    // xhr.withCredentials = true;
    xhr.send(formData);
  });

  // return both so caller can access xhr.abort() and await promise
  return { xhr, promise };
}
export function sendMultipleFilesApi({
  conversation_id,
  sender_id,
  files,
  onProgress,
  onCancelRef,
}) {
  const form = new FormData();
  form.append("conversation_id", conversation_id);
  form.append("sender_id", sender_id);

  [...files].forEach((file) => {
    form.append("files", file);
  });

  const { xhr, promise } = sendWithProgress(form, onProgress);

  if (onCancelRef) onCancelRef.current = xhr;
  return promise;
}

// --------------------------------------------------
// 8) EDIT MESSAGE
// PATCH /chat/messages/<message_id>
// --------------------------------------------------
export function editMessageApi(messageId, newText) {
  return apiFetch(`/messages/${messageId}`, {
    method: "PATCH",
    body: JSON.stringify({ new_text: newText }),
  });
}

// --------------------------------------------------
// 9) DELETE MESSAGE (SOFT DELETE)
// DELETE /chat/messages/<message_id>
// --------------------------------------------------
export function deleteMessageApi(messageId) {
  return apiFetch(`/messages/${messageId}`, {
    method: "DELETE",
  });
}

// --------------------------------------------------
// 10) GROUP MEMBERS — FETCH
// GET /chat/group/<conversation_id>/members
// --------------------------------------------------
export function getGroupMembers(conversationId) {
  return apiFetch(`/group/${conversationId}/members`);
}

// --------------------------------------------------
// 11) ADD MEMBERS TO GROUP (ONE OR MANY)
// POST /chat/group/<conversation_id>/members/add
// --------------------------------------------------
export function addMembersToGroup(conversationId, memberIds) {
  return apiFetch(`/group/${conversationId}/members/add`, {
    method: "POST",
    body: JSON.stringify({ members: memberIds, sender_id: state.user?.id }),
  });
}

// --------------------------------------------------
// 12) REMOVE MULTIPLE MEMBERS
// POST /chat/group/<conversation_id>/members/remove
// --------------------------------------------------
export function removeMembersFromGroup(conversationId, memberIds) {
  return apiFetch(`/group/${conversationId}/members/remove`, {
    method: "POST", // IMPORTANT: MUST BE POST (DELETE BODY UNSUPPORTED)
    body: JSON.stringify({ members: memberIds, sender_id: state.user?.id }),
  });
}

// --------------------------------------------------
// 13) REMOVE SINGLE MEMBER
// DELETE /chat/group/<conversation_id>/members/<user_id>
// --------------------------------------------------
export function removeSingleMember(conversationId, userId) {
  return apiFetch(`/group/${conversationId}/members/${userId}`, {
    method: "DELETE",
  });
}

export function renameGroup(conversationId, newName) {
  return apiFetch(`/group/${conversationId}/rename`, {
    method: "PATCH",
    body: JSON.stringify({ name: newName }),
  });
}

export function deleteGroup(conversationId) {
  return apiFetch(`/group/${conversationId}`, {
    method: "DELETE",
  });
}

// --------------------------------------------------
// 14) MUTE / UNMUTE GROUP
// PATCH /chat/group/<conversation_id>/mute
// Body: { user_id, mute }
// --------------------------------------------------
export function muteGroup(conversationId, mute) {
  return apiFetch(`/group/${conversationId}/mute`, {
    method: "PATCH",
    body: JSON.stringify({ user_id: state.user?.id, mute: Boolean(mute) }),
  });
}

// --------------------------------------------------
// 15) LEAVE GROUP
// POST /chat/group/<conversation_id>/leave
// Body: { user_id }
// --------------------------------------------------
export function leaveGroup(conversationId) {
  return apiFetch(`/group/${conversationId}/leave`, {
    method: "POST",
    body: JSON.stringify({ user_id: state.user?.id }),
  });
}

// --------------------------------------------------
// 16) MAKE ADMIN (TOGGLE)
// POST /chat/group/<conversation_id>/make-admin
// Body: { actor_id, user_id, is_admin }
// --------------------------------------------------
export function makeGroupAdmin(conversationId, userId, isAdmin = true) {
  return apiFetch(`/group/${conversationId}/make-admin`, {
    method: "POST",
    body: JSON.stringify({
      actor_id: state.user?.id,
      user_id: userId,
      is_admin: Boolean(isAdmin),
    }),
  });
}

// --------------------------------------------------
// 17) UPDATE GROUP DESCRIPTION
// PATCH /chat/group/<conversation_id>/description
// Body: { description, sender_id }
// --------------------------------------------------
export function updateGroupDescription(conversationId, description) {
  return apiFetch(`/group/${conversationId}/description`, {
    method: "PATCH",
    body: JSON.stringify({
      description: description || "",
      sender_id: state.user?.id,
    }),
  });
}

export function updateGroupIcon(conversationId, file) {
  const form = new FormData();
  form.append("actor_id", state.user?.id || "");
  form.append("file", file);
  return apiFetch(`/group/${conversationId}/icon`, {
    method: "POST",
    body: form,
  });
}

export function leaveDirectChat(conversationId, userId) {
  return apiFetch(`/direct/${conversationId}/${userId}`, {
    method: "DELETE",
  });
}

// --------------------------------------------------
// 18) MARK MESSAGES AS READ
// POST /chat/mark-read
// Body: { conversation_id, user_id, message_ids }
// --------------------------------------------------
export function markMessagesRead(conversationId, messageIds = []) {
  return apiFetch(`/mark-read`, {
    method: "POST",
    body: JSON.stringify({
      conversation_id: conversationId,
      user_id: state.user?.id,
      message_ids: messageIds,
    }),
  });
}

// --------------------------------------------------
// 19) SEND TEXT MESSAGE WITH REPLY SUPPORT
// POST /chat/send-text
// Body: { conversation_id, sender_id, message_text, reply_to }
// --------------------------------------------------
export function sendTextMessageWithReply(payload) {
  return apiFetch(`/send-text`, {
    method: "POST",
    body: JSON.stringify({
      ...payload,
      sender_id: state.user?.id,
    }),
  });
}
