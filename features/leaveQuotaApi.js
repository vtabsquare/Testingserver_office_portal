// features/leaveQuotaApi.js - API functions for leave quota management (frontend)

import { state } from '../state.js';
import { API_BASE_URL } from '../config.js';

const BASE_URL = API_BASE_URL.replace(/\/$/, '');

// Map friendly types to canonical labels used across the app
const CANONICAL_TYPES = {
  'casual leave': 'Casual Leave',
  'cl': 'Casual Leave',
  'sick leave': 'Sick Leave',
  'sl': 'Sick Leave',
  'comp off': 'Comp Off',
  'compoff': 'Comp Off',
  'co': 'Comp Off',
};

function normalizeLeaveType(leaveType) {
  const key = String(leaveType || '').trim().toLowerCase();
  return CANONICAL_TYPES[key] || leaveType;
}

/**
 * Fetch leave quota summary for an employee by aggregating balances
 * from the backend leave-balance endpoint for each leave type.
 */
export const fetchLeaveQuota = async (empId) => {
  const employeeId = String(empId || state?.user?.id || '').toUpperCase();
  const types = ['Casual Leave', 'Sick Leave', 'Comp Off'];
  const results = await Promise.all(
    types.map(async (t) => {
      const res = await fetch(`${BASE_URL}/api/leave-balance/${encodeURIComponent(employeeId)}/${encodeURIComponent(t)}`);
      if (!res.ok) throw new Error(`Failed to fetch ${t} balance`);
      const data = await res.json();
      return { type: t, available: Number(data.available || 0) };
    })
  );

  const byType = Object.fromEntries(results.map((r) => [r.type, r.available]));
  const total = (byType['Casual Leave'] || 0) + (byType['Sick Leave'] || 0) + (byType['Comp Off'] || 0);

  return {
    empId: employeeId,
    cl: byType['Casual Leave'] || 0,
    sl: byType['Sick Leave'] || 0,
    compoff: byType['Comp Off'] || 0,
    totalQuota: 0, // Not tracked client-side; backend maintains any LOP bucket
    actualTotal: total,
  };
};

/**
 * Validate whether requested days can be paid given the specific leave type balance.
 */
export const validateLeaveBalance = async (empId, leaveType, leaveDays) => {
  const employeeId = String(empId || state?.user?.id || '').toUpperCase();
  const type = normalizeLeaveType(leaveType);
  const res = await fetch(`${BASE_URL}/api/leave-balance/${encodeURIComponent(employeeId)}/${encodeURIComponent(type)}`);
  if (!res.ok) throw new Error(`Failed to validate ${type} balance`);
  const data = await res.json();
  const available = Number(data.available || 0);
  const requested = Number(leaveDays || 0);
  const hasSufficientBalance = available >= requested;
  return {
    isValid: true,
    hasSufficientBalance,
    availableBalance: available,
    requestedDays: requested,
    leaveType: type,
    willBePaid: hasSufficientBalance,
    message: hasSufficientBalance
      ? `You have ${available} ${type} days available. This leave will be marked as PAID.`
      : `Insufficient ${type} balance (Available: ${available}, Requested: ${requested}). This leave will be UNPAID (LOP).`,
  };
};

/**
 * Calculate number of leave days between two dates (excluding weekends)
 */
export const calculateLeaveDays = (startDate, endDate, dayDuration = 'full') => {
  const start = new Date(startDate);
  const end = new Date(endDate);
  let count = 0;
  const cur = new Date(start);
  while (cur <= end) {
    const dow = cur.getDay();
    // Match backend: Sunday excluded; Saturday counted (Mon-Sat work week).
    if (dow !== 0) count++;
    cur.setDate(cur.getDate() + 1);
  }
  const mode = String(dayDuration || 'full').trim().toLowerCase().replace(/_/g, ' ');
  if (mode === 'half' || mode === 'half day') {
    return count * 0.5;
  }
  return count;
};

/**
 * updateLeaveQuota / restoreLeaveQuota are handled by the backend when applying/cancelling.
 * We expose thin wrappers for future use; currently they no-op on the client.
 */
export const updateLeaveQuota = async () => {
  console.info('updateLeaveQuota is handled server-side after applying leave. No client action.');
};

export const restoreLeaveQuota = async () => {
  console.info('restoreLeaveQuota should be triggered via a backend cancel endpoint (not implemented here).');
};


