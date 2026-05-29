import { API_BASE_URL } from '../config.js';

const BASE_URL = API_BASE_URL.replace(/\/$/, '');

const apiFetch = async (url, options) => {
  let res;
  try {
    res = await fetch(url, options);
  } catch {
    throw new Error(
      'Cannot reach the API server. Start the backend (python backend/unified_server.py on port 5000), then restart the Vite dev server (npm run dev).'
    );
  }
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    throw new Error(
      'API returned a non-JSON response. Restart "npm run dev" so Vite can proxy /api to port 5000, and ensure the backend is running.'
    );
  }
  const data = await res.json();
  if (!res.ok || !data.success) {
    throw new Error(data.error || 'Request failed');
  }
  return data;
};

export async function fetchShiftSettings() {
  return apiFetch(`${BASE_URL}/api/shift-settings`);
}

export async function updateEmployeeShiftSetting(payload) {
  return apiFetch(`${BASE_URL}/api/shift-settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
  });
}

export async function createShiftPreset(payload) {
  return apiFetch(`${BASE_URL}/api/shift-presets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
  });
}

export async function updateShiftPreset(presetId, payload) {
  return apiFetch(`${BASE_URL}/api/shift-presets/${encodeURIComponent(presetId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
  });
}

export async function deleteShiftPreset(presetId) {
  return apiFetch(`${BASE_URL}/api/shift-presets/${encodeURIComponent(presetId)}`, {
    method: 'DELETE',
  });
}
