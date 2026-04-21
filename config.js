// Global API configuration for frontend
// Uses Vite env (VITE_API_BASE_URL) in production and falls back to localhost in dev.

// Resolve API base at runtime with multiple fallbacks:
// 1) Vite env (build-time)
// 2) window.API_BASE_URL (runtime injection from index or host page)
// 3) Known backend host (render)
// 4) localhost (dev)
const envApi =
  (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_API_BASE_URL)
    ? import.meta.env.VITE_API_BASE_URL
    : null;

const runtimeApi = (typeof window !== 'undefined' && window.API_BASE_URL)
  ? window.API_BASE_URL
  : null;

const fallbackHosted = '';

// Treat any non-local hostname as production (use same origin). Previously
// non-prod subdomains like testsite.officeportal.vtabsquare.com fell through
// to localhost:5000 and broke fetches from the browser.
const _host = (typeof window !== 'undefined' && window.location && window.location.hostname) || '';
const _isLocal = _host === 'localhost' || _host === '127.0.0.1' || _host === '';
const sameOrigin = (!_isLocal && typeof window !== 'undefined' && window.location)
  ? window.location.origin
  : '';

export const API_BASE_URL = (envApi || runtimeApi || fallbackHosted || sameOrigin || 'http://localhost:5000').replace(/\/$/, '');

export const apiBase = API_BASE_URL;

export const apiUrl = (path = '/') => {
  const p = String(path || '/');
  return apiBase + (p.startsWith('/') ? p : `/${p}`);
};
