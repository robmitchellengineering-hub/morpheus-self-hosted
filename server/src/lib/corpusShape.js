// corpusShape.js — what the corpus collector accepts, with no database anywhere near it.
//
// The endpoint is PUBLIC (an SDK on a customer's laptop has no account here), so this validation IS the security. It lives in
// its own module for a second reason: the no-install guards job runs the guard that proves these decisions, and importing
// `@prisma/client` to reach them would mean that guard could never run in CI without a full install.
const MAX_OBSERVATIONS = 200;
export const VERDICTS = new Set(['caught', 'survived', 'stale', 'unstable', 'always-red', 'cannot-run', 'error']);
const HEX = /^[0-9a-f]{8,64}$/i;

/**
 * @returns {{ok: boolean, error?: string, rows: Array, rejected: number}}
 */
export function normalizeObservations(body) {
  const install = typeof body?.install === 'string' && HEX.test(body.install.replace(/-/g, '')) ? body.install.slice(0, 64) : null;
  const observations = Array.isArray(body?.observations) ? body.observations : null;
  if (!observations) return { ok: false, error: 'observations must be an array', rows: [], rejected: 0 };
  if (observations.length > MAX_OBSERVATIONS) return { ok: false, error: `at most ${MAX_OBSERVATIONS} observations per request`, rows: [], rejected: 0 };

  const rows = [];
  let rejected = 0;
  for (const o of observations) {
    // SHAPE ONLY. Every field is checked against what the SDK documents it sends; an unknown or oversized field means the payload
    // is not the one we asked for, and it is dropped rather than stored on trust.
    if (!o || !HEX.test(String(o.recipe ?? ''))) { rejected++; continue; }
    if (!VERDICTS.has(String(o.verdict ?? ''))) { rejected++; continue; }
    if (JSON.stringify(o).length > 600) { rejected++; continue; }
    rows.push({
      install_id: install,
      recipe: String(o.recipe).slice(0, 64),
      verdict: String(o.verdict),
      trials: Number.isInteger(o.trials) ? o.trials : null,
      check_kind: o.checkKind ? String(o.checkKind).slice(0, 20) : null,
      repo: o.repo ? String(o.repo).slice(0, 64) : null,
      license: o.license ? String(o.license).slice(0, 64) : null,
      observed_at: o.at && !Number.isNaN(Date.parse(o.at)) ? new Date(o.at) : new Date(),
    });
  }
  return { ok: true, rows, rejected };
}
