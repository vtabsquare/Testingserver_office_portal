// features/employeeApi.js
import { API_BASE_URL } from '../config.js';
import { state } from '../state.js';
import { timedFetch } from './timedFetch.js';

const BASE_URL = API_BASE_URL.replace(/\/$/, '');
const CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes
const EMP_DIRECTORY_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

const toDataUrl = (photo) => {
  if (!photo || typeof photo !== 'string') return null;
  const trimmed = photo.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('data:')) return trimmed;
  return `data:image/png;base64,${trimmed}`;
};

let allEmployeesCache = {
  active: { data: null, fetchedAt: 0 },
  all: { data: null, fetchedAt: 0 },
};

export async function listEmployees(page = 1, pageSize = 5, includeInactive = false) {
  const cacheKey = `${page}|${pageSize}|${includeInactive}`;
  const now = Date.now();
  const cached = state?.cache?.employees?.[cacheKey];
  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.data;
  }

  const url = new URL(`${BASE_URL}/api/employees`);
  url.searchParams.set('page', String(page));
  url.searchParams.set('pageSize', String(pageSize));
  if (includeInactive) {
    url.searchParams.set('include_inactive', 'true');
  }
  const res = await timedFetch(url.toString(), {}, 'listEmployees');
  const data = await res.json();
  if (!res.ok || !data.success) {
    throw new Error(data.error || 'Failed to fetch employees');
  }
  const shaped = {
    items: (data.employees || []).map(e => ({
      ...e,
      photo: toDataUrl(e.photo || e.profile_picture)
    })),
    total: typeof data.total === 'number' ? data.total : undefined,
    page: data.page || page,
    pageSize: data.pageSize || pageSize
  };
  try {
    if (state?.cache?.employees) {
      state.cache.employees[cacheKey] = { data: shaped, fetchedAt: now };
    }
  } catch { /* ignore cache errors */ }
  return shaped;
}

export async function createEmployee(payload) {
  const res = await timedFetch(`${BASE_URL}/api/employees`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  }, 'createEmployee');
  const data = await res.json();
  if (!res.ok || !data.success) {
    throw new Error(data.error || 'Failed to create employee');
  }
  try { if (state?.cache?.employees) state.cache.employees = {}; } catch { }
  return data.employee;
}

export async function listAllEmployees(forceRefresh = false, includeInactive = false) {
  const now = Date.now();
  const cacheKey = includeInactive ? 'all' : 'active';
  
  if (
    !forceRefresh &&
    allEmployeesCache[cacheKey]?.data &&
    now - allEmployeesCache[cacheKey].fetchedAt < EMP_DIRECTORY_CACHE_TTL_MS
  ) {
    return allEmployeesCache[cacheKey].data;
  }

  const url = new URL(`${BASE_URL}/api/employees/all`);
  if (includeInactive) {
    url.searchParams.set('include_inactive', 'true');
  }

  const res = await timedFetch(url.toString(), {}, 'listAllEmployees');
  let data = null;
  try {
    data = await res.json();
  } catch (e) {
    // Backend sometimes returns HTML error pages (500) - surface a readable error.
    let text = '';
    try { text = await res.text(); } catch { }
    const snippet = String(text || '').slice(0, 180);
    throw new Error(`Employee directory returned non-JSON (HTTP ${res.status}). ${snippet}`);
  }
  if (!res.ok || !data.success) {
    throw new Error(data.error || `Failed to fetch employee directory (HTTP ${res.status})`);
  }

  const employees = (data.employees || []).map(e => ({
    ...e,
    photo: toDataUrl(e.photo || e.profile_picture)
  }));
  allEmployeesCache[cacheKey] = { data: employees, fetchedAt: now };
  return employees;
}

export function isActiveEmployee(emp) {
  if (!emp) return false;
  return emp.active === true || emp.active === 'true' || emp.active === 1 || emp.active === 'Active' || String(emp.status).toLowerCase() === 'active';
}

export async function listActiveEmployees(forceRefresh = false) {
  const allEmployees = await listAllEmployees(forceRefresh);
  return allEmployees.filter(isActiveEmployee);
}

export async function updateEmployee(employeeId, payload) {
  const res = await timedFetch(`${BASE_URL}/api/employees/${encodeURIComponent(employeeId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  }, 'updateEmployee');
  const data = await res.json();
  if (!res.ok || !data.success) {
    throw new Error(data.error || 'Failed to update employee');
  }
  try { if (state?.cache?.employees) state.cache.employees = {}; } catch { }
  allEmployeesCache = { data: null, fetchedAt: 0 };
  return {
    ...data.employee,
    photo: toDataUrl(data.employee?.photo || data.employee?.profile_picture)
  };
}

export async function deleteEmployee(employeeId) {
  const res = await timedFetch(`${BASE_URL}/api/employees/${encodeURIComponent(employeeId)}`, {
    method: 'DELETE'
  }, 'deleteEmployee');
  const data = await res.json();
  if (!res.ok || !data.success) {
    throw new Error(data.error || 'Failed to delete employee');
  }
  try { if (state?.cache?.employees) state.cache.employees = {}; } catch { }
  return true;
}

export async function bulkCreateEmployees(employees) {
  const res = await timedFetch(`${BASE_URL}/api/employees/bulk`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ employees })
  }, 'bulkCreateEmployees');
  const data = await res.json();
  if (!res.ok || !data.success) {
    throw new Error(data.error || 'Failed to bulk upload employees');
  }
  try { if (state?.cache?.employees) state.cache.employees = {}; } catch { }
  return data;
}
