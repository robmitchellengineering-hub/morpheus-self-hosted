// One site scan, shared by the button in the panel and the monthly schedule.
//
// Extracted so there is exactly ONE definition of "scan this site": the two
// callers differ in who asked and why, not in what a scan is. The rules that
// interpret the result stay in lib/siteHealth.js and lib/siteClean.js (pure,
// asserted); this file only does the I/O around them.
//
// CLEAN MY SITE is a SECOND scan here rather than a mode of the first, and that
// is deliberate: it checksums core, walks uploads/ and may download plugin
// packages, so it must not ride along with the scan that runs when a panel
// opens. Two actions, two caches, two buttons — see scanCleanSite() below.
import { prisma } from '../db.js';
import { getWpConnection, wpHealth, wpClean, wpStatus } from './wpPlugin.js';
import {
  findings, summarise, attention, dataFreshness, canApply, updatePlan, isPluginTooOld,
} from './siteHealth.js';
import { cleanFindings, cleanSummary, cleanLimits, safeSet, reportOnly } from './siteClean.js';

/**
 * Scan one project's connected site.
 *
 * Throws with a status + code the API can pass straight through; every failure
 * names something the operator can act on (unreachable, plugin too old, the site
 * answered an error) rather than a generic failure.
 */
export async function scanSite(user, projectId, { force = false } = {}) {
  const { project, conn } = await connectedSite(user, projectId);

  const res = await wpHealth(conn, { force });
  await assertScannable(conn, res, 'a health scan');

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

/**
 * CLEAN MY SITE: the heavy scan, as its own signed request.
 *
 * A plugin build older than 0.8.4 IGNORES the body and answers with a health
 * scan. That is the quiet failure this function exists to catch: a 200 whose
 * payload has no `findings` array is not a clean site, it is a stale plugin.
 * Reporting "nothing found" there would be the worst outcome this feature can
 * produce.
 */
export async function scanCleanSite(user, projectId, { force = false } = {}) {
  const { project, conn } = await connectedSite(user, projectId);

  const res = await wpClean(conn, { force });
  await assertScannable(conn, res, 'a clean scan');

  const scan = res.data || {};
  if (!Array.isArray(scan.findings)) {
    throw Object.assign(
      new Error('This site\'s Morpheus plugin is too old to clean — it answers a clean scan with a health scan, so nothing was checked. Update the plugin in wp-admin → Plugins, then scan again.'),
      { status: 409, code: 'PLUGIN_TOO_OLD' },
    );
  }

  const all = cleanFindings(scan);

  // The safe set is computed HERE, from the site's own registry answer, so the
  // panel cannot widen it and a site that downgrades a fix from `auto` to
  // `guided` shrinks the single press without any change on this side.
  return {
    ok: true,
    ...scan,
    site: { url: conn.siteUrl, name: project.name },
    findings: all,
    summary: cleanSummary(scan),
    cleanable: safeSet(all),
    report_only: reportOnly(all),
    limits_detail: cleanLimits(scan),
  };
}

/** The project + the site connection for this owner, or a named refusal. */
async function connectedSite(user, projectId) {
  const project = await prisma.project.findFirst({
    where: { id: projectId, created_by_id: user.id },
    select: { id: true, name: true },
  });
  if (!project) throw Object.assign(new Error('Project not found'), { status: 404, code: 'NO_PROJECT' });

  const conn = await getWpConnection(projectId, user.id);
  if (!conn) {
    throw Object.assign(new Error('No WordPress site connected. Connect one in the WEBSITE panel first.'), { status: 400, code: 'NOT_CONNECTED' });
  }
  return { project, conn };
}

/**
 * The failure shapes every signed scan shares: unreachable, too old, an error.
 *
 * One place, because two copies of the "too old" handling is how one of them
 * silently stops naming the plugin version the operator has to update.
 */
async function assertScannable(conn, res, what) {
  if (res.status === 0) {
    throw Object.assign(new Error(`Could not reach ${conn.siteUrl} — ${res.error || 'no response'}`), { status: 502, code: 'UNREACHABLE' });
  }
  if (res.status === 200) return;

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
    new Error(res.data?.message || `The site answered HTTP ${res.status} to ${what}.`),
    { status: 502, code: 'SCAN_FAILED' },
  );
}
