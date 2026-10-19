// TRAFFIC tab — the first workflow: IndexNow submission state, a bounded
// backfill, and the ledger that proves what was submitted.
//
// Signs and forwards to the plugin's /traffic endpoint exactly as
// wordPressSeoAction does for /seo: the site does the work (it is the thing that
// owns the URLs and talks to IndexNow), and this handler decides what Morpheus is
// allowed to ask for and shapes what comes back.
//
// The ledger rows are re-bounded and re-summarised HERE rather than trusted from
// the plugin, because the plugin's response is external input like any other: a
// site running an older or modified build must not be able to make the panel
// render an unbounded list or a count that does not add up.
import { prisma } from '../db.js';
import { getWpConnection, wpTraffic } from '../lib/wpPlugin.js';
import { TRAFFIC_ACTIONS, boundLedger, summarizeLedger } from '../lib/indexNow.js';

/** The wording for a site whose plugin predates this feature. */
const TOO_OLD = 'This site\'s Morpheus plugin does not have the TRAFFIC tab yet (it needs 0.7.0 or newer). Update it from the SETUP tab.';

export default async function handler({ user, body }) {
  const { projectId, action, data } = body || {};
  if (!projectId) throw Object.assign(new Error('projectId required'), { status: 400 });
  if (!TRAFFIC_ACTIONS.includes(action)) {
    throw Object.assign(new Error(`Unknown traffic action: ${action}`), { status: 400 });
  }

  const project = await prisma.project.findFirst({
    where: { id: projectId, created_by_id: user.id },
    select: { id: true, name: true },
  });
  if (!project) throw Object.assign(new Error('Project not found'), { status: 404 });

  const conn = await getWpConnection(projectId, user.id);
  if (!conn) {
    throw Object.assign(new Error('No WordPress site connected — connect one in the SETUP panel first.'), { status: 400 });
  }

  const res = await wpTraffic(conn, action, data && typeof data === 'object' ? data : {});

  if (res.status === 0) {
    throw Object.assign(new Error(`Could not reach ${conn.siteUrl} — ${res.error || 'no response'}`), { status: 502 });
  }
  // 404 = the route does not exist on this build; 400 unknown_action = the route
  // exists but not this action. Both mean the same thing to an operator, and both
  // are named, because WordPress's own "rest_no_route" explains nothing.
  if (res.status === 404 || res.status === 501 || (res.status === 400 && res.data?.error === 'unknown_action')) {
    throw Object.assign(new Error(TOO_OLD), { status: 409, code: 'TRAFFIC_UNSUPPORTED' });
  }
  if (res.status !== 200) {
    throw Object.assign(
      new Error(res.data?.message || res.data?.error || `The site answered HTTP ${res.status} to ${action}.`),
      { status: 502 },
    );
  }

  if (action === 'ledger') {
    const rows = boundLedger(res.data?.rows);
    return { ok: true, rows, summary: summarizeLedger(rows), max: res.data?.max ?? null };
  }
  if (action === 'settings') {
    return { ok: true, settings: res.data?.settings ?? null };
  }
  if (action === 'backfill') {
    return { ok: res.data?.ok === true, result: res.data ?? null };
  }
  // status
  return { ok: true, status: res.data ?? null };
}
