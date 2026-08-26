import { API_BASE_URL } from '../config.js';
import { state } from '../state.js';

const BASE_URL = API_BASE_URL.replace(/\/$/, '');

const normalizeEmpId = (value) => String(value || '').trim().toUpperCase();

const buildAdminAuthQuery = () => {
  const qs = new URLSearchParams();
  const requesterEmployeeId = normalizeEmpId(state.user?.id || state.user?.employee_id);
  const requesterEmail = String(state.user?.email || '').trim().toLowerCase();
  if (requesterEmployeeId) qs.set('requester_employee_id', requesterEmployeeId);
  if (requesterEmail) qs.set('requester_email', requesterEmail);
  const query = qs.toString();
  return query ? `?${query}` : '';
};

export const fetchAttendanceMonitoringToday = async () => {
  const response = await fetch(`${BASE_URL}/api/admin/attendance-monitoring/today${buildAdminAuthQuery()}`, {
    cache: 'no-store',
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.success) {
    throw new Error(data.error || 'Failed to load attendance monitoring');
  }
  return data;
};
