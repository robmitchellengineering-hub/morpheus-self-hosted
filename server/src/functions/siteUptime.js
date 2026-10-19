// Uptime for one connected WordPress site.
//
//   status — what the site's availability has been (read-only)
//   check  — ask the site now, record the answer, and report it
//
// WHY A NEW FUNCTION rather than an action on siteHealth: the health scan is a heavy
// signed call that runs when a panel opens, and uptime is the opposite — one
// unauthenticated GET to /status, cheap enough to run on a schedule and to record
// every time. Keeping them apart means the check can be recorded without paying for
// a scan, and a scan cannot accidentally look like an uptime observation.
//
// THE PROBE IS /status, WHICH NEEDS NO SECRET. It answers in every plugin build, so a
// site with a stale plugin is still monitored — and the version it reports is stored
// per check, which is how "this site has fallen behind" becomes visible over time
// without anyone asking it.
import { prisma } from '../db.js';
import { getWpConnection, wpStatus } from '../lib/wpPlugin.js';
import { classifyProbe, summarise, RETAIN_DAYS, WINDOWS } from '../lib/siteUptime.js';
import { recordCheck, recentChecks, uptimeReady } from '../lib/siteUptimeStore.js';

const ALLOWED = new Set(['status', 'check']);

export default async function handler({ user, body }) {
  const { projectId, action = 'status' } = body || {};
  if (!projectId) throw Object.assign(new Error('projectId required'), { status: 400 });
  if (!ALLOWED.has(action)) throw Object.assign(new Error(`Unknown uptime action: ${action}`), { status: 400 });

  const project = await prisma.project.findFirst({
    where: { id: projectId, created_by_id: user.id },
    select: { id: true, name: true },
  });
  if (!project) throw Object.assign(new Error('Project not found'), { status: 404 });

  const conn = await getWpConnection(projectId, user.id);
  if (!conn) {
    throw Object.assign(
      new Error('No WordPress site connected. Connect one in the WEBSITE panel first.'),
      { status: 400, code: 'NOT_CONNECTED' },
    );
  }

  // The migration ships with this code and production applies additive SQL by hand,
  // so say "not set up yet" instead of showing an empty history that reads as "fine".
  const ready = await uptimeReady();

  let justChecked = null;
  if (action === 'check') {
    const startedAt = new Date();
    const t0 = Date.now();
    const res = await wpStatus(conn.siteUrl);
    const latency = Date.now() - t0;
    const probe = classifyProbe(res);
    await recordCheck({ projectId, userId: user.id, probe, latencyMs: latency, checkedAt: startedAt });
    justChecked = { ...probe, latency_ms: latency, checked_at: startedAt.toISOString() };
  }

  const rows = ready ? await recentChecks(projectId) : [];

  return {
    ok: true,
    ready,
    checked: action === 'check',
    just_checked: justChecked,
    site: { url: conn.siteUrl, name: project.name },
    retain_days: RETAIN_DAYS,
    windows: WINDOWS,
    ...summarise(rows),
  };
}
