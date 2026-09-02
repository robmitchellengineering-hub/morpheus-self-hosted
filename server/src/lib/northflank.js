// Ops Console (2026-09-02) — read-only Northflank API client.
//
// Why this exists: diagnosing a production issue used to mean opening a
// separate Northflank browser tab to read runtime logs and check deploy
// status by hand. This gives the Admin Panel's Ops Console (and SelfDev's
// "DIAGNOSE FROM LOGS" button) the same information from inside Morpheus
// itself, so an operator (or the self-dev AI, via the log text dropped into
// chat) can go straight from "something's broken" to a proposed fix without
// leaving the app.
//
// Deliberately read-only: nothing here can trigger a deploy, rebuild, or
// restart. Northflank's CD already auto-deploys automatically on every push
// to main (that's what SelfDev's PUSH TO PRODUCTION relies on — see
// pushSelfDevToGithub.js) so there's no real gap a write capability here
// would fill, and keeping this surface read-only means the API token backing
// it only ever needs view/observability scope, never anything that could
// take the service down by itself.
//
// Auth: a single project-scoped API token. Create one in Northflank at Team
// Settings → API → Tokens, using (or creating) an RBAC role granting "View
// Services" + "View Observability" on this project — no write permissions
// needed. Set as NORTHFLANK_API_TOKEN. Every function below degrades to a
// clear "not configured" result (never a crash) when it's unset.
const NF_API = 'https://api.northflank.com/v1';

export function isNorthflankConfigured() {
  return Boolean(process.env.NORTHFLANK_API_TOKEN);
}

// Defaults match this deployment's own known project/service — see the
// Northflank URLs used throughout MORPHEUS-STATUS docs (team
// morpheusv1s-team, project morpheus-self-hosted, service morpheus-backend).
// Overridable via env for anyone self-hosting Morpheus under a different
// Northflank project/service name.
function projectId() {
  return process.env.NORTHFLANK_PROJECT_ID || 'morpheus-self-hosted';
}
function serviceId() {
  return process.env.NORTHFLANK_SERVICE_ID || 'morpheus-backend';
}

async function nfFetch(path, { query } = {}) {
  const token = process.env.NORTHFLANK_API_TOKEN;
  if (!token) {
    throw Object.assign(new Error('Northflank not configured — set NORTHFLANK_API_TOKEN'), {
      status: 400,
      code: 'NORTHFLANK_NOT_CONFIGURED',
    });
  }
  const url = new URL(`${NF_API}${path}`);
  for (const [k, v] of Object.entries(query || {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error?.message || data?.message || `Northflank API error: HTTP ${res.status}`);
  }
  return data;
}

// Service status: build/deployment state, currently deployed commit/branch,
// replica health. Northflank wraps most responses in { data: {...} }; fall
// back to the raw body in case a given endpoint doesn't.
export async function getServiceStatus() {
  const body = await nfFetch(`/projects/${projectId()}/services/${serviceId()}`);
  return body?.data || body;
}

// Runtime (or build) logs, newest-window-first internally but returned
// oldest-first (natural reading order, and what you want when concatenating
// into an AI diagnosis prompt). `search` does server-side substring
// filtering (Northflank's textIncludes) so a 60-minute pull doesn't come
// back as thousands of routine request lines when you only care about
// errors.
export async function getServiceLogs({ search, minutesBack = 60, limit = 200, type = 'runtime' } = {}) {
  const body = await nfFetch(`/projects/${projectId()}/services/${serviceId()}/logs`, {
    query: {
      type: type === 'build' ? 'build' : 'runtime',
      queryType: 'range',
      duration: Math.max(1, Math.round(minutesBack * 60)),
      lineLimit: Math.min(Math.max(1, Number(limit) || 200), 1000),
      direction: 'backward',
      textIncludes: search || undefined,
    },
  });
  const lines = Array.isArray(body?.data) ? body.data : [];
  return lines
    .slice()
    .reverse()
    .map((l) => ({ ts: l.ts, log: l.log, containerId: l.containerId }));
}
