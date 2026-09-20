// One site scan, shared by the button in the panel and the monthly schedule.
//
// Extracted so there is exactly ONE definition of "scan this site": the two
// callers differ in who asked and why, not in what a scan is. The rules that
// interpret the result stay in lib/siteHealth.js (pure, asserted); this file only
// does the I/O around them.
import { prisma } from '../db.js';
import { getWpConnection, wpHealth, wpStatus } from './wpPlugin.js';
import {
  findings, summarise, attention, dataFreshness, canApply, updatePlan, isPluginTooOld,
} from './siteHealth.js';

/**
 * Scan one project's connected site.
 *
 * Throws with a status + code the API can pass straight through; every failure
 * names something the operator can act on (unreachable, plugin too old, the site
 * answered an error) rather than a generic failure.
 */
export async function scanSite(user, projectId, { force = false } = {}) {
  const project = await prisma.project.findFirst({
    where: { id: projectId, created_by_id: user.id },
    select: { id: true, name: true },
  });
  if (!project) throw Object.assign(new Error('Project not found'), { status: 404, code: 'NO_PROJECT' });

  const conn = await getWpConnection(projectId, user.id);
  if (!conn) {
    throw Object.assign(new Error('No WordPress site connected. Connect one in the WEBSITE panel first.'), { status: 400, code: 'NOT_CONNECTED' });
  }

  const res = await wpHealth(conn, { force });
  if (res.status === 0) {
    throw Object.assign(new Error(`Could not reach ${conn.siteUrl} — ${res.error || 'no response'}`), { status: 502, code: 'UNREACHABLE' });
  }

  if (res.status !== 200) {
    // Ask the site what it is running so the message can name the version —
    // /status exists in every plugin version and needs no signature.
    let runningVersion = conn.meta?.pluginVersion || null;
    try {
      const status = await wpStatus(conn.siteUrl);
      if (status?.status === 200 && status.data?.version) runningVersion = status.data.version;
    } catch { /* the message is still useful without it */ }

    const old = isPluginTooOld(res, runningVersion);
    if (old.tooOld) throw Object.assign(new Error(old.message), { status: 409, code: 'PLUGIN_TOO_OLD' });
    throw Object.assign(
      new Error(res.data?.message || `The site answered HTTP ${res.status} to a health scan.`),
      { status: 502, code: 'SCAN_FAILED' },
    );
  }

  const scan = res.data || {};

  // The derivations travel WITH the findings: no caller re-decides what "needs
  // attention" means, or the rule ends up in two places that disagree.
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
