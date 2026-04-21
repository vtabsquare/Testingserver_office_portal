// Global API configuration for frontend
// Production: set VITE_API_BASE_URL env var during build
const _host = (typeof window !== 'undefined' && window.location && window.location.hostname) || '';
// Treat any non-local hostname as production so the API is served from the
// same origin (previously only the bare production domain was recognised,
// which caused subdomain deployments like testsite.officeportal.vtabsquare.com
// to fall back to http://localhost:5000 -> ERR_CONNECTION_REFUSED in the
// browser for Forgot Password and other auth flows).
const _isLocal = _host === 'localhost' || _host === '127.0.0.1' || _host === '';
const _isProd = !_isLocal;
export const API_BASE_URL = (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_API_BASE_URL) || (_isProd ? `${window.location.origin}` : 'http://localhost:5000');
export const apiBase = API_BASE_URL.replace(/\/$/, '');
export const apiUrl = (path = '/') => {
  const p = String(path || '/');
  return apiBase + (p.startsWith('/') ? p : `/${p}`);
};
