import { API_BASE_URL } from '../config.js';

const BASE_URL = API_BASE_URL.replace(/\/$/, '');

export async function fetchShiftSettings() {
  const res = await fetch(`${BASE_URL}/api/shift-settings`);
  const data = await res.json();
  if (!res.ok || !data.success) {
    throw new Error(data.error || 'Failed to fetch shift settings');
  }
  return data;
}

export async function updateEmployeeShiftSetting(payload) {
  const res = await fetch(`${BASE_URL}/api/shift-settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
  });
  const data = await res.json();
  if (!res.ok || !data.success) {
    throw new Error(data.error || 'Failed to update shift settings');
  }
  return data;
}
