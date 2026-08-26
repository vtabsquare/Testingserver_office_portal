import { API_BASE_URL } from '../config.js';

const BASE_URL = API_BASE_URL.replace(/\/$/, '');

const withQuery = (path, params = {}) => {
  const qs = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return;
    qs.set(key, String(value));
  });
  const query = qs.toString();
  return `${BASE_URL}${path}${query ? `?${query}` : ''}`;
};

const normalizeRequest = (item = {}) => ({
  id: item.id || item.request_id || item.requestId || '',
  permissionId: item.permission_id || item.permissionId || '',
  employeeId: item.employee_id || item.employeeId || '',
  date: item.date || '',
  startTime: item.start_time || item.startTime || '',
  endTime: item.end_time || item.endTime || '',
  reason: item.reason || '',
  status: item.status || 'Pending',
  approvedBy: item.approved_by || item.approvedBy || '',
  approvedOn: item.approved_on || item.approvedOn || '',
  rejectionReason: item.rejection_reason || item.rejectionReason || '',
  pausedAt: item.paused_at || item.pausedAt || '',
  createdAt: item.created_at || item.createdAt || '',
  compensationMode: item.compensation_mode || item.compensationMode || 'none',
  makeupDate: item.makeup_date || item.makeupDate || null,
  compensationHours: Number(item.compensation_hours ?? item.compensationHours ?? 0) || 0,
  compensated: !!(item.compensated ?? false),
  compensatedAt: item.compensated_at || item.compensatedAt || '',
});

const normalizeDueRow = (item = {}) => ({
  id: item.id || '',
  permissionId: item.permission_id || '',
  employeeId: item.employee_id || '',
  employeeName: item.employee_name || item.employee_id || '',
  permissionDate: item.permission_date || '',
  hoursDue: Number(item.hours_due ?? 0) || 0,
  makeupDate: item.makeup_date || null,
  compensationMode: item.compensation_mode || 'none',
  overdue: !!item.overdue,
});

export const fetchPermissionRequests = async (filters = {}) => {
  const url = withQuery('/api/permissions', {
    status: filters.status,
    employee_id: filters.employeeId,
    date: filters.date,
  });
  const response = await fetch(url, { cache: 'no-store' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.success) {
    throw new Error(data.error || data.message || 'Failed to fetch permission requests');
  }
  return (data.requests || []).map(normalizeRequest);
};

export const createPermissionRequest = async (requestData = {}) => {
  const response = await fetch(`${BASE_URL}/api/permissions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestData),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.success) {
    throw new Error(data.error || data.message || 'Failed to create permission request');
  }
  return normalizeRequest(data.request || requestData);
};

export const approvePermissionRequest = async (requestId, approvedBy) => {
  const response = await fetch(`${BASE_URL}/api/permissions/${encodeURIComponent(requestId)}/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ approved_by: approvedBy }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.success) {
    throw new Error(data.error || data.message || 'Failed to approve permission request');
  }
  return data;
};

export const rejectPermissionRequest = async (requestId, rejectedBy, reason = '') => {
  const response = await fetch(`${BASE_URL}/api/permissions/${encodeURIComponent(requestId)}/reject`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rejected_by: rejectedBy, reason }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.success) {
    throw new Error(data.error || data.message || 'Failed to reject permission request');
  }
  return data;
};

/** Org-wide list of outstanding permission compensations, for the Admin Dashboard panel. */
export const fetchCompensationDue = async () => {
  const response = await fetch(`${BASE_URL}/api/permissions/compensation-due`, { cache: 'no-store' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.success) {
    throw new Error(data.error || data.message || 'Failed to fetch compensation due list');
  }
  return (data.due || []).map(normalizeDueRow);
};

/** For the dashboard banner: is the employee currently inside an approved-or-not permission window today? */
export const fetchActivePermission = async (employeeId) => {
  const response = await fetch(`${BASE_URL}/api/permissions/active/${encodeURIComponent(employeeId)}`, { cache: 'no-store' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.success) {
    return { active: false };
  }
  return {
    active: !!data.active,
    request: data.request ? normalizeRequest(data.request) : null,
  };
};
