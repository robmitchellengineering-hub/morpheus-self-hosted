// Site health and maintenance for one connected WordPress site.
//
// One function with an `action` because the widget scope is a function-name
// allow-list: one name to grant, one name to audit.
//
// `scan` is read-only and is all that exists so far. Applying fixes is a
// separate change on purpose — it writes to someone's live site, and it needs a
// pre-update snapshot and a post-update check before it can be offered at all.
// There is deliberately no "apply" action here that quietly does less than the
// name promises.
import { prisma } from '../db.js';
import { getWpConnection, wpHealth, wpStatus } from '../lib/wpPlugin.js';
import {
  findings, summarise, attention, dataFreshness, canApply, updatePlan, isPluginTooOld,
} from '../lib/siteHealth.js';

const ACTIONS = new Set(['scan']);

export default async function handler({ user, body }) {
  const { projectId, action } = body || {};
  if (!projectId) throw Object.assign(new Error('projectId required'), { status: 400 });
  if (!ACTIONS.has(action)) throw Object.assign(new Error(`Unknown health action: ${action}`), { status: 400 });

  const project = await prisma.project.findFirst({
    where: { id: projectId, created_by_id: user.id },
    select: { id: true, name: true },
  });
  if (!project) throw Object.assign(new Error('Project not found'), { status: 404 });

  const conn = await getWpConnection(projectId, user.id);
  if (!conn) {
    throw Object.assign(new Error('No WordPress site connected. Connect one in the WEBSITE panel first.'), { status: 400, code: 'NOT_CONNECTED' });
  }

  const res = await wpHealth(conn, { force: body?.force === true });
  if (res.status === 0) {
    throw Object.assign(new Error(`Could not reach ${conn.siteUrl} — ${res.error || 'no response'}`), { status: 502, code: 'UNREACHABLE' });
  }

  if (res.status !== 200) {
    // Ask the site what it is running so the message can name the version —
    // /status exists in every plugin version and needs no signature. Best
    // effort: if it fails, the message just omits the version.
    let runningVersion = conn.meta?.pluginVersion || null;
    try {
      const status = await wpStatus(conn.siteUrl);
      if (status?.status === 200 && status.data?.version) runningVersion = status.data.version;
    } catch { /* the message is still useful without it */ }

    const old = isPluginTooOld(res, runningVersion);
    if (old.tooOld) {
      throw Object.assign(new Error(old.message), { status: 409, code: 'PLUGIN_TOO_OLD' });
    }
    throw Object.assign(
      new Error(res.data?.message || `The site answered HTTP ${res.status} to a health scan.`),
      { status: 502, code: 'SCAN_FAILED' },
    );
  }

  const scan = res.data || {};

  // The derivations travel WITH the findings: the panel must not re-decide what
  // "needs attention" means, or the rule ends up in two places that disagree.
  // Everything here is pure and asserted by scripts/verify-site-health.mjs.
  return {
    ok: true,
    ...scan,
    site: { url: conn.siteUrl, name: project.name },
    summary: summarise(scan),
    findings: findings(scan),
    attention: attention(scan),
    freshness: dataFreshness(scan),
    can_apply: canApply(scan),
    update_plan: updatePlan(scan),
  };
}
