// Self-hosted replacement for the @base44/sdk client. Implements the same
// call surface the rest of this codebase already uses — base44.entities.*,
// base44.functions.invoke, base44.auth.*, base44.integrations.Core.UploadFile,
// base44.connectors.* — backed by fetch calls to the Express/Prisma API in
// /server instead of the Base44 platform. Every page/hook/component in this
// app was left unmodified; only this file (and AuthContext.jsx) changed.
//
// See server/PORTING_GUIDE.md for the full call-mapping reference this was
// built against.
//
// API base resolution — build-time env is the normal case (a co-located
// deploy via docker-compose/nginx just needs the '/api' default), but when
// this frontend is hosted separately from its backend (e.g. a free static
// host pointed at a backend running elsewhere) the backend URL is a
// runtime choice, not a build-time one. So: a `?api_base=` query param sets
// and persists it (localStorage), which beats rebuilding for every test
// backend; visiting again without the param reuses whatever was last set.
const API_BASE_KEY = 'morpheus_api_base';

function resolveApiBase() {
  try {
    const fromQuery = new URLSearchParams(window.location.search).get('api_base');
    if (fromQuery) {
      const clean = fromQuery.replace(/\/+$/, '');
      localStorage.setItem(API_BASE_KEY, clean);
      return clean;
    }
    const stored = localStorage.getItem(API_BASE_KEY);
    if (stored) return stored.replace(/\/+$/, '');
  } catch { /* localStorage/window unavailable (SSR, private mode) — fall through */ }
  return (import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/+$/, '');
}

const API_BASE = resolveApiBase();
const TOKEN_KEY = 'morpheus_token';

export function getToken() {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}

function setToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch { /* localStorage unavailable (private mode, SSR) — token just won't persist */ }
}

async function apiFetch(path, opts = {}) {
  const token = getToken();
  const isFormData = opts.body instanceof FormData;
  const headers = { ...(opts.headers || {}) };
  if (!isFormData && opts.body && typeof opts.body !== 'string') opts.body = JSON.stringify(opts.body);
  if (!isFormData && opts.body) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${API_BASE}${path}`, { ...opts, headers });

  if (!res.ok) {
    let data = {};
    try { data = await res.json(); } catch { /* non-JSON error body */ }
    const err = new Error(data.error || res.statusText || `Request failed (${res.status})`);
    err.status = res.status;
    err.data = data;
    // Out-of-credits (server/src/lib/billing.js's InsufficientCreditsError,
    // forwarded with a stable `code` by functions.routes.js) fires a global
    // popup in addition to throwing normally below — every existing call
    // site's own error handling (e.g. useWorkspace.js's inline chat error
    // message) still runs unchanged; this is purely additive. See
    // src/components/matrix/InsufficientCreditsModal.jsx (mounted once in
    // App.jsx), which listens for this event.
    if (data.code === 'INSUFFICIENT_CREDITS') {
      try {
        window.dispatchEvent(new CustomEvent('morpheus:insufficient-credits', {
          detail: { needed: data.needed, available: data.available, message: data.error },
        }));
      } catch { /* window unavailable (SSR) */ }
    }
    throw err;
  }
  if (res.status === 204) return null;
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) return res.json();
  return res.blob();
}

function qs(params) {
  const clean = Object.fromEntries(Object.entries(params || {}).filter(([, v]) => v !== undefined && v !== null && v !== ''));
  const s = new URLSearchParams(clean).toString();
  return s ? `?${s}` : '';
}

// One CRUD object per entity name — mirrors Entity.{list,filter,get,create,
// update,delete,deleteMany,bulkCreate} from the base44 SDK exactly (call
// signatures confirmed against every frontend call site).
function makeEntity(name) {
  return {
    list: (sort, limit) => apiFetch(`/entities/${name}${qs({ sort, limit })}`),
    filter: (query = {}, sort, limit) => apiFetch(`/entities/${name}/filter`, { method: 'POST', body: { query, sort, limit } }),
    get: (id) => apiFetch(`/entities/${name}/${id}`),
    create: (data) => apiFetch(`/entities/${name}`, { method: 'POST', body: data }),
    update: (id, data) => apiFetch(`/entities/${name}/${id}`, { method: 'PUT', body: data }),
    delete: (id) => apiFetch(`/entities/${name}/${id}`, { method: 'DELETE' }),
    deleteMany: (query = {}) => apiFetch(`/entities/${name}/bulk-delete`, { method: 'POST', body: { query } }),
    bulkCreate: (items) => apiFetch(`/entities/${name}/bulk-create`, { method: 'POST', body: { items } }),
  };
}

const ENTITY_NAMES = [
  'Project', 'ProjectFile', 'ChatMessage', 'FileSnapshot', 'UsageRecord',
  'Template', 'Purchase', 'UserSettings', 'BackendConfig', 'RebuildDoc', 'UpdatesPlan', 'CostSnapshot', 'GithubConnection',
  'MaintenanceTask',
];

const entities = Object.fromEntries(ENTITY_NAMES.map((name) => [name, makeEntity(name)]));

// base44.functions.invoke(name, body) returned an axios-style { data } object
// in the original SDK — every call site (useWorkspace.js, BackendPanel.jsx,
// etc.) already reads `res.data.X`, so this wraps the response the same way.
const functions = {
  invoke: async (name, body = {}) => {
    const data = await apiFetch(`/functions/${name}`, { method: 'POST', body });
    return { data };
  },
};

const integrations = {
  Core: {
    UploadFile: async ({ file }) => {
      const form = new FormData();
      form.append('file', file);
      return apiFetch('/uploads', { method: 'POST', body: form });
    },
  },
};

// GitHub is the only connector this app ever used (GITHUB_CONNECTOR_ID in
// useGithubConnection.js) — connectorId is accepted but ignored since
// there's only one. connectAppUser returns a popup URL carrying the bearer
// token as a query param (see server/src/auth.js's extractToken, which
// accepts ?token= specifically for this redirect-based flow — a top-level
// navigation can't set an Authorization header).
const connectors = {
  connectAppUser: async () => `${API_BASE}/connections/github/start?token=${encodeURIComponent(getToken() || '')}`,
  disconnectAppUser: async () => apiFetch('/connections/github', { method: 'DELETE' }),
};

const auth = {
  me: async () => {
    const { user } = await apiFetch('/auth/me');
    return user;
  },
  isAuthenticated: async () => {
    if (!getToken()) return false;
    try { await auth.me(); return true; } catch { return false; }
  },
  loginViaEmailPassword: async (email, password) => {
    const { token, user } = await apiFetch('/auth/login', { method: 'POST', body: { email, password } });
    setToken(token);
    return user;
  },
  register: async ({ email, password, full_name }) => {
    const { token, user } = await apiFetch('/auth/register', { method: 'POST', body: { email, password, full_name } });
    setToken(token); // needed so the OTP verify call below is authenticated
    return user;
  },
  verifyOtp: async ({ otpCode }) => {
    await apiFetch('/auth/verify-otp', { method: 'POST', body: { code: otpCode } });
    return { access_token: getToken() }; // token doesn't rotate on verify; callers just re-set the same one
  },
  resendOtp: async () => apiFetch('/auth/resend-otp', { method: 'POST' }),
  resetPasswordRequest: async (email) => apiFetch('/auth/forgot-password', { method: 'POST', body: { email } }),
  resetPassword: async ({ resetToken, newPassword }) => apiFetch('/auth/reset-password', { method: 'POST', body: { resetToken, newPassword } }),
  setToken,
  logout: (redirectUrl) => {
    setToken(null);
    if (redirectUrl) window.location.href = redirectUrl;
  },
  redirectToLogin: (returnTo) => {
    window.location.href = '/login' + (returnTo && returnTo !== '/' ? `?returnTo=${encodeURIComponent(returnTo)}` : '');
  },
  loginWithProvider: (provider, returnTo) => {
    if (provider !== 'google') throw new Error(`Unsupported provider: ${provider}`);
    window.location.href = `${API_BASE}/auth/google/start${qs({ returnTo })}`;
  },
};

// Owner/Admin Control Panel (Feature Backlog #8) — bespoke, audited routes
// (server/src/routes/admin.routes.js), not the generic entity CRUD engine.
// Every write here lands in AdminAuditLog server-side; nothing extra needed
// on this side for that.
const admin = {
  getOverview: () => apiFetch('/admin/overview'),
  getSettings: () => apiFetch('/admin/settings'),
  setSetting: (key, value) => apiFetch('/admin/settings', { method: 'POST', body: { key, value } }),
  getModelCatalog: () => apiFetch('/admin/model-catalog'),
  upsertModelCatalogEntry: (entry) => apiFetch('/admin/model-catalog', { method: 'POST', body: entry }),
  getAuditLog: (limit) => apiFetch(`/admin/audit-log${qs({ limit })}`),
};

export const base44 = { entities, functions, integrations, connectors, auth, admin };
