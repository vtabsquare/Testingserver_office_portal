// features/loginSettingsApi.js - API functions for managing login accounts (Dataverse login table)
import { API_BASE_URL } from '../config.js';

const BASE_URL = API_BASE_URL.replace(/\/$/, '');

export async function listLoginAccounts() {
  const res = await fetch(`${BASE_URL}/api/login-accounts`);
  const data = await res.json();
  if (!res.ok || !data.success) {
    throw new Error(data.error || 'Failed to fetch login accounts');
  }
  return data.items || [];
}

export async function createLoginAccount(payload) {
  const res = await fetch(`${BASE_URL}/api/login-accounts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
  });
  const data = await res.json();
  if (!res.ok || !data.success) {
    throw new Error(data.error || 'Failed to create login account');
  }
  return data.item;
}

export async function updateLoginAccount(loginId, payload) {
  const res = await fetch(`${BASE_URL}/api/login-accounts/${encodeURIComponent(loginId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
  });
  const data = await res.json();
  if (!res.ok || !data.success) {
    throw new Error(data.error || 'Failed to update login account');
  }
  return true;
}

export async function deleteLoginAccount(loginId) {
  const res = await fetch(`${BASE_URL}/api/login-accounts/${encodeURIComponent(loginId)}`, {
    method: 'DELETE',
  });
  const data = await res.json();
  if (!res.ok || !data.success) {
    throw new Error(data.error || 'Failed to delete login account');
  }
  return true;
}

/**
 * Fetch login events (check-in/out with location) for L2/L3 tracking.
 * @param {Object} options - { from, to, employee_id }
 */
export async function fetchLoginEvents(options = {}) {
  const params = new URLSearchParams();
  if (options.from) params.set('from', options.from);
  if (options.to) params.set('to', options.to);
  if (options.employee_id) params.set('employee_id', options.employee_id);
  
  const url = `${BASE_URL}/api/login-events${params.toString() ? '?' + params.toString() : ''}`;
  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok || !data.success) {
    throw new Error(data.error || 'Failed to fetch login events');
  }
  return data;
}

export async function fetchAuthSessionEvents(options = {}) {
  const params = new URLSearchParams();
  if (options.employee_id) params.set('employee_id', options.employee_id);
  if (options.event_type) params.set('event_type', options.event_type);
  if (options.limit) params.set('limit', String(options.limit));
  const url = `${BASE_URL}/api/auth-events${params.toString() ? '?' + params.toString() : ''}`;
  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok || !data.success) {
    throw new Error(data.error || 'Failed to fetch auth session events');
  }
  return data;
}

export async function createAuthSessionEvent(payload) {
  const res = await fetch(`${BASE_URL}/api/auth-events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
  });
  const data = await res.json();
  if (!res.ok || !data.success) {
    throw new Error(data.error || 'Failed to create auth event');
  }
  return data;
}

export async function fetchAuthSessionPolicy(employee_id = '', username = '') {
  const params = new URLSearchParams();
  if (employee_id) params.set('employee_id', employee_id);
  if (username) params.set('username', username);
  const url = `${BASE_URL}/api/auth/session-policy${params.toString() ? '?' + params.toString() : ''}`;
  const headers = {};
  try {
    const auth = JSON.parse(localStorage.getItem('auth') || '{}');
    const token = auth.token || auth.authToken || localStorage.getItem('authToken') || '';
    if (token) headers['Authorization'] = `Bearer ${token}`;
  } catch (_) {}
  const res = await fetch(url, { headers });
  const data = await res.json();
  if (!res.ok || !data.success) {
    throw new Error(data.error || 'Failed to fetch auth session policy');
  }
  return data.policy || {};
}

export async function triggerForceLogout(payload) {
  const res = await fetch(`${BASE_URL}/api/auth/force-logout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
  });
  const data = await res.json();
  if (!res.ok || !data.success) {
    throw new Error(data.error || 'Failed to force logout');
  }
  return data;
}

export async function updateLoginActivity(payload) {
  const res = await fetch(`${BASE_URL}/api/login-activity`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
  });
  const data = await res.json();
  if (!res.ok || !data.success) {
    throw new Error(data.error || 'Failed to update login activity');
  }
  return data;
}
