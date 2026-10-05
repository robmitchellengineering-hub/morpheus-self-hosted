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

// Where a rejected session may be sent — pure, tested (src/lib/authRedirect.test.js).
import { loginRedirectTarget, cleanReturnTo } from '@/lib/authRedirect';

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

// The resolved API base — exposed so callers that need to hit a specific
// backend endpoint (e.g. the proving-ground canary card) can build an
// absolute URL from the same runtime resolution the rest of this client
// already uses, instead of relying on a relative path that the SPA
// fallback can swallow in production.
export function getApiBase() {
  return API_BASE;
}

const TOKEN_KEY = 'morpheus_token';

// In-memory bearer override — set by the embeddable-widget surface (/embed)
// so its `wgt_` token authenticates its requests WITHOUT touching
// localStorage, which is shared with any real Morpheus session in another
// same-origin tab.
let overrideToken = null;
export function setOverrideToken(t) { overrideToken = t || null; }

export function getToken() {
  if (overrideToken) return overrideToken;
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}

function setToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch { /* localStorage unavailable (private mode, SSR) — token just won't persist */ }
}

// 2026-09-04 (Rob: "the ai agent fix in compile seems to just keep running
// ... getting blocked or faulting in any way"): this fetch had no timeout at
// all, and neither did the outbound fetch server/src/ai.js makes to the AI
// provider — confirmed by code read on both sides. That call to
// diagnoseIssue (base44.functions.invoke → apiFetch) is exactly the request
// behind the compile AI-fix UI, so a stall anywhere in that chain had no
// safeguard and would look, from here, exactly like "keeps running forever"
// with no error and no way to tell it apart from real (slow) progress. The
// server side now hard-caps its own provider call at 180s (see ai.js's
// fetchWithTimeout), so this client-side cap is set a bit above that —
// long enough to let a legitimate slow-but-working backend call finish and
// return its own clear error first, short enough that a genuine network
// stall (dropped connection, proxy black hole) between browser and backend
// still surfaces here as a plain, catchable timeout instead of hanging the
// UI indefinitely.
const API_FETCH_TIMEOUT_MS = 210_000;

async function apiFetch(path, opts = {}) {
  const token = getToken();
  const isFormData = opts.body instanceof FormData;
  const headers = { ...(opts.headers || {}) };
  if (!isFormData && opts.body && typeof opts.body !== 'string') opts.body = JSON.stringify(opts.body);
  if (!isFormData && opts.body) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${API_BASE}${path}`, { ...opts, headers, signal: controller.signal });
  } catch (err) {
    if (err?.name === 'AbortError') {
      const timeoutErr = new Error(`Request timed out after ${Math.round(API_FETCH_TIMEOUT_MS / 1000)}s. The server may be overloaded — please retry.`);
      timeoutErr.status = 0;
      timeoutErr.code = 'CLIENT_TIMEOUT';
      throw timeoutErr;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

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
  'Template', 'Purchase', 'UserSettings', 'BackendConfig', 'RebuildDoc', 'SelfDevManual', 'UpdatesPlan', 'CostSnapshot', 'GithubConnection',
  'MaintenanceTask',
  // Command Deck (internal codename "Deck")
  'DeckJarvisMessage', 'DeckDumpItem', 'DeckPerson', 'DeckTask', 'DeckConsignmentItem', 'DeckRepairJob', 'DeckRepairFile',
  'DeckMurbahOpportunity', 'DeckInboxItem', 'DeckStrategyNote', 'DeckKnowledgeNote',
  'DeckLifeStream', 'DeckLifeStreamNote', 'DeckLifeFile', 'DeckEnergyLogEntry', 'DeckFocusEntry',
  'DeckWidgetInstance', 'DeckBusinessProfile', 'DeckWidgetBuild',
  // Asteroids reward: the play bank is a ledger of earned credits and played games (see
  // server/prisma/schema.prisma → DeckPlayCredit / DeckPlayScore).
  'DeckPlayCredit', 'DeckPlayScore',
];

const entities = Object.fromEntries(ENTITY_NAMES.map((name) => [name, makeEntity(name)]));

function safeParseJsonLine(line) {
  try { return JSON.parse(line); } catch { return null; }
}

// 2026-09-03 (Rob: "stream the progress with an eta ... step by step in the
// chat window") — streaming counterpart to functions.invoke, currently used
// only for chatWithMorpheus (see useWorkspace.js's sendMessage). The server
// streams newline-delimited JSON (see chatWithMorpheus.js): zero or more
// {type:'stage', stage, status:'start'|'done', label, etaSeconds|
// elapsedSeconds} progress events, then exactly one terminal
// {type:'result', data} or {type:'error', ...} line. `onStage` fires for
// each stage event as it arrives; the returned promise resolves with the
// same `{ data }` shape functions.invoke returns (or rejects, matching
// apiFetch's error contract) once the terminal line is read.
//
// 2026-10-04: an optional 4th argument, `onEvent`, receives EVERY parsed
// event as it arrives — added so chatWithJarvis's streamed reply can render
// `{type:'delta', text}` fragments as they are written. `onStage` is
// unchanged and still fires only for stage events, so every existing caller
// (useWorkspace.js, SeoTab.jsx, EmbedChat.jsx) behaves exactly as before.
//
// A failure BEFORE the handler starts streaming (bad auth, validation,
// project not found — see functions.routes.js) never reaches the NDJSON
// path at all: it's a normal non-200 JSON error response, handled the same
// way apiFetch handles one.
async function invokeStream(name, body, onStage, onEvent) {
  const token = getToken();
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${API_BASE}/functions/${name}`, { method: 'POST', headers, body: JSON.stringify(body || {}) });

  const dispatchInsufficientCredits = (needed, available, message) => {
    try {
      window.dispatchEvent(new CustomEvent('morpheus:insufficient-credits', { detail: { needed, available, message } }));
    } catch { /* window unavailable (SSR) */ }
  };

  if (!res.ok) {
    let data = {};
    try { data = await res.json(); } catch { /* non-JSON error body */ }
    const err = new Error(data.error || res.statusText || `Request failed (${res.status})`);
    err.status = res.status;
    err.data = data;
    if (data.code === 'INSUFFICIENT_CREDITS') dispatchInsufficientCredits(data.needed, data.available, data.error);
    throw err;
  }

  // Read the NDJSON body incrementally so onStage fires as each line
  // arrives, rather than only after the whole response finishes — that's
  // the entire point of streaming this instead of one JSON blob.
  let finalEvent = null;
  const handleLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const evt = safeParseJsonLine(trimmed);
    if (!evt) return;
    // Every caller-supplied handler runs AFTER the parse and BEFORE the type switch, so an event that
    // is neither a stage nor terminal (a delta, a ping, something a newer server sends) is delivered
    // rather than dropped — and a handler that throws cannot take the final line down with it.
    try { onEvent?.(evt); } catch { /* a UI handler must never break the reader */ }
    if (evt.type === 'stage') onStage?.(evt);
    else if (evt.type === 'result' || evt.type === 'error') finalEvent = evt;
  };

  let raw = '';
  if (res.body?.getReader) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      // ONE decode per chunk, appended to both: the decoder carries state for a
      // multi-byte character split across chunks, so decoding the same chunk
      // twice is not the same string twice.
      const text = decoder.decode(value, { stream: true });
      buffer += text;
      raw += text;
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        handleLine(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 1);
      }
    }
    if (buffer) handleLine(buffer);
  } else {
    // Streaming reader unsupported in this environment — fall back to
    // reading the whole body at once and replaying it line by line so the
    // same parsing/onStage path still runs (just without the live benefit).
    const text = await res.text();
    text.split('\n').forEach(handleLine);
  }

  // A server that does not stream answers with ONE plain JSON object, and a
  // client that asked for a stream would otherwise report "connection closed"
  // for a perfectly good response — which is exactly what a deploy window looks
  // like (the frontend ships separately from the backend). An object with no
  // `type` field is not one of our events, so it can only be the whole payload.
  if (!finalEvent) {
    const whole = safeParseJsonLine(String(raw).trim());
    if (whole && typeof whole === 'object' && !Array.isArray(whole) && !whole.type) {
      finalEvent = { type: 'result', data: whole };
    }
  }
  if (!finalEvent) throw new Error('Connection closed before Morpheus finished responding.');
  if (finalEvent.type === 'error') {
    const err = new Error(finalEvent.message || 'Internal error');
    err.data = finalEvent;
    if (finalEvent.code === 'INSUFFICIENT_CREDITS') dispatchInsufficientCredits(finalEvent.needed, finalEvent.available, finalEvent.message);
    throw err;
  }
  return { data: finalEvent.data };
}

// base44.functions.invoke(name, body) returned an axios-style { data } object
// in the original SDK — every call site (useWorkspace.js, BackendPanel.jsx,
// etc.) already reads `res.data.X`, so this wraps the response the same way.
const functions = {
  invoke: async (name, body = {}) => {
    const data = await apiFetch(`/functions/${name}`, { method: 'POST', body });
    return { data };
  },
  invokeStream,

  // Media Library (its own route, not the function dispatcher — the upload is
  // multipart). Return the raw JSON, not the { data } wrapper.
  listProjectAssets: (projectId) => apiFetch(`/media-assets/${projectId}`),
  addProjectAssetUrl: (projectId, body) => apiFetch(`/media-assets/${projectId}/url`, { method: 'POST', body }),
  addProjectAssetFile: (projectId, form) => apiFetch(`/media-assets/${projectId}/upload`, { method: 'POST', body: form }),
  deleteProjectAsset: (projectId, assetId) => apiFetch(`/media-assets/${projectId}/${assetId}`, { method: 'DELETE' }),

  // Cabinet uploads — also their own route, and multipart for the same reason.
  listCabinets: (projectId) => apiFetch(`/cabinet/${projectId}`),
  addCabinet: (projectId, form) => apiFetch(`/cabinet/${projectId}`, { method: 'POST', body: form }),
  deleteCabinet: (projectId, fileId) => apiFetch(`/cabinet/${projectId}/${fileId}`, { method: 'DELETE' }),

  // The capture pre-flight. It takes no project: a pair of recordings is not part of a project until the model
  // trained from them is, and the endpoint stores nothing — it reads a verdict out of the bytes and drops them.
  // `about` carries the constants the panel would otherwise hardcode (the re-amp signal's download URL and the
  // MD5 the trainer recognises it by), so the two cannot drift apart.
  captureAbout: () => apiFetch('/capture/about'),
  checkCapture: (form) => apiFetch('/capture/check', { method: 'POST', body: form }),

  // The board — the plugin's own signal path, arranged. Its own route because the validation, and the file it
  // writes (`morpheus.plugin.json`), both belong on the server; see server/src/routes/board.routes.js.
  getBoard: (projectId) => apiFetch(`/board/${projectId}`),
  saveBoard: (projectId, board) => apiFetch(`/board/${projectId}`, { method: 'PUT', body: board }),
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
// there's only one.
//
// The primary connect flow is now the device flow (githubDeviceStart /
// githubDevicePoll → server/src/routes/connections.routes.js): no popup, no
// redirect URI, works in mobile browsers and webviews. connectAppUser (the
// old redirect+popup flow) is kept as a desktop-web fallback — it returns a
// URL carrying the bearer token as a query param, since a top-level
// navigation can't set an Authorization header (see server/src/auth.js's
// extractToken, which accepts ?token= specifically for this).
const connectors = {
  connectAppUser: async () => `${API_BASE}/connections/github/start?token=${encodeURIComponent(getToken() || '')}`,
  disconnectAppUser: async () => apiFetch('/connections/github', { method: 'DELETE' }),
  githubDeviceStart: () => apiFetch('/connections/github/device/start', { method: 'POST' }),
  githubDevicePoll: (poll_token) => apiFetch('/connections/github/device/poll', { method: 'POST', body: { poll_token } }),
  // Google Drive storage (Feature Backlog #12, Phase 1) — redirect-only,
  // no device flow (see connections.routes.js's Phase 1 scope note).
  connectGoogleDrive: async () => `${API_BASE}/connections/google-drive/start?token=${encodeURIComponent(getToken() || '')}`,
  disconnectGoogleDrive: async () => apiFetch('/connections/google-drive', { method: 'DELETE' }),
  // Command Deck's own Google connection (Gmail + Calendar + Drive backup +
  // Docs) — deliberately separate from connectGoogleDrive above.
  connectDeckGoogle: async () => `${API_BASE}/connections/deck-google/start?token=${encodeURIComponent(getToken() || '')}`,
  disconnectDeckGoogle: async () => apiFetch('/connections/deck-google', { method: 'DELETE' }),
  // Google Search Console (read-only search performance). Its own connection
  // rather than a scope on the Drive one — see connections.routes.js. `returnTo`
  // is where the browser lands after consent, and the server accepts only a
  // same-origin path (lib/safeRedirect.js).
  connectSearchConsole: async (returnTo = '/workspace') =>
    `${API_BASE}/connections/search-console/start?token=${encodeURIComponent(getToken() || '')}&returnTo=${encodeURIComponent(returnTo)}`,
  disconnectSearchConsole: async () => apiFetch('/connections/search-console', { method: 'DELETE' }),
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
    // The single place a login redirect is built, so the loop guard lives here
    // too: a returnTo pointing at a sign-in page (or another origin) is
    // dropped, and a redirect FROM a sign-in page is not performed at all.
    const target = loginRedirectTarget(window.location.pathname, window.location.search);
    if (!target) return;
    const base = target.split('?')[0];
    const safe = cleanReturnTo(returnTo);
    window.location.href = base + (safe ? `?returnTo=${encodeURIComponent(safe)}` : '');
  },
  loginWithProvider: (provider, returnTo) => {
    if (provider !== 'google') throw new Error(`Unsupported provider: ${provider}`);
    window.location.href = `${API_BASE}/auth/google/start${qs({ returnTo })}`;
  },
  // Morpheus Connect — device login for native/compiled apps (server/src/lib/deviceToken.js).
  // getDevicePending/approveDevice/denyDevice are used by src/pages/ConnectDevice.jsx;
  // start/poll live server-side only — a standalone .exe calls those directly,
  // never through this frontend client.
  getDevicePending: (userCode) => apiFetch(`/auth/device/pending/${encodeURIComponent(userCode)}`),
  approveDevice: (userCode) => apiFetch('/auth/device/approve', { method: 'POST', body: { user_code: userCode } }),
  denyDevice: (userCode) => apiFetch('/auth/device/deny', { method: 'POST', body: { user_code: userCode } }),
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
  // Ops Console (2026-09-02) — Northflank status/logs, a guarded DB console,
  // and Stripe billing health. See server/src/routes/admin.routes.js's
  // "C. Ops Console" section for the reasoning.
  getNorthflankStatus: () => apiFetch('/admin/ops/northflank/status'),
  getNorthflankLogs: ({ search, minutes, limit, type } = {}) =>
    apiFetch(`/admin/ops/northflank/logs${qs({ search, minutes, limit, type })}`),
  restartNorthflankService: () => apiFetch('/admin/ops/northflank/restart', { method: 'POST', body: { confirm: true } }),
  runDbQuery: (sql, confirm = false) => apiFetch('/admin/ops/db-query', { method: 'POST', body: { sql, confirm } }),
  getStripeHealth: () => apiFetch('/admin/ops/stripe-health'),
  // Currency report — AI model + npm dependency freshness. Backed by
  // server/src/freshness.js (also runs on a schedule with email-on-change);
  // getFreshness returns the last computed report, refreshFreshness forces one.
  getFreshness: () => apiFetch('/admin/freshness'),
  refreshFreshness: (notify = false) => apiFetch('/admin/freshness/refresh', { method: 'POST', body: { notify } }),
  // Free usage grants — billing exemption without full admin access.
  listBillingExempt: () => apiFetch('/admin/users/billing-exempt'),
  setBillingExempt: (email, exempt) => apiFetch('/admin/users/billing-exempt', { method: 'POST', body: { email, exempt } }),
};

export const base44 = { entities, functions, integrations, connectors, auth, admin };
