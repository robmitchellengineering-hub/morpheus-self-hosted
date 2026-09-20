// Site health and maintenance for one connected WordPress site.
//
// One function with an `action` because the widget scope is a function-name
// allow-list: one name to grant, one name to audit.
//
//   scan   — read the site and report (via lib/siteScan.js, shared with the
//            monthly schedule so there is one definition of a scan)
//   policy — read or write what the owner allows, and when
//
// There is deliberately NO apply action. Applying updates writes to a live site
// and needs a pre-update snapshot and a post-update check first; the policy that
// will gate it is already settled and asserted (lib/siteMaintenance.js), so the
// rules are in place before the ability arrives. A handler that accepted
// "apply" and quietly did less than its name would be worse than one that
// refuses.
import { prisma } from '../db.js';
import { getWpConnection, wpFix } from '../lib/wpPlugin.js';
import { scanSite } from '../lib/siteScan.js';
import { getPolicy, savePolicy } from '../lib/siteMaintenanceStore.js';
import { applyAllowedUpdates } from '../lib/siteApply.js';
import { describePolicy, nextRunAt, allowedKinds, runSummary, POLICY_DEFAULTS } from '../lib/siteMaintenance.js';

const ACTIONS = new Set(['scan', 'policy', 'apply', 'fix']);

export default async function handler({ user, body, req }) {
  const { projectId, action } = body || {};
  if (!projectId) throw Object.assign(new Error('projectId required'), { status: 400 });
  if (!ACTIONS.has(action)) throw Object.assign(new Error(`Unknown health action: ${action}`), { status: 400 });

  if (action === 'policy') {
    if (body?.policy && typeof body.policy === 'object') {
      // A widget token MAY change this (owner's decision, 2026-09-21): the dock
      // exists to operate the site from the site, and the dock only renders for a
      // logged-in administrator. What keeps it safe is not who holds the token
      // but what the token can cause:
      //
      //   * every apply flag defaults to false and is changed here explicitly;
      //   * applying still needs `confirm: true` per invocation, and the policy
      //     only permits what the owner switched on;
      //   * a major core update has no flag to switch on, so no token can reach it;
      //   * every plugin/theme update is snapshotted before it is touched.
      //
      // The residual risk is a leaked token enabling unattended updates rather
      // than running one, which is why the EMBED tab warns that the snippet
      // carries the token and belongs somewhere only admins load it.
      void req;
      const saved = await savePolicy(user, projectId, body.policy);
      if (!saved.ok) {
        throw Object.assign(new Error(saved.errors.join('; ')), { status: 400, code: 'INVALID_POLICY' });
      }
    }
    return policyPayload(await getPolicy(projectId));
  }

  if (action === 'fix') {
    const finding = String(body?.finding || body?.id || '');
    if (!finding) throw Object.assign(new Error('finding id required'), { status: 400 });

    const conn = await getWpConnection(projectId, user.id);
    if (!conn) throw Object.assign(new Error('No WordPress site connected.'), { status: 400, code: 'NOT_CONNECTED' });

    const res = await wpFix(conn, finding);
    if (res.status === 0) {
      throw Object.assign(new Error(`Could not reach ${conn.siteUrl} — ${res.error || 'no response'}`), { status: 502, code: 'UNREACHABLE' });
    }
    const old = isPluginTooOld(res, null);
    if (old.tooOld) throw Object.assign(new Error(old.message), { status: 409, code: 'PLUGIN_TOO_OLD' });
    // 409 is the site declining (a guided finding, or nothing registered) — that
    // is a real answer, not a failure to report as one.
    if (res.status !== 200 && res.status !== 409) {
      throw Object.assign(new Error(res.data?.error || `The site answered HTTP ${res.status} to a fix.`), { status: 502, code: 'FIX_FAILED' });
    }
    return {
      ok: res.data?.ok === true,
      fix: res.data || null,
      // The caller re-scans after this; the policy travels so the panel does not
      // need a second round trip to stay right.
      policy: policyPayload(await getPolicy(projectId)),
    };
  }

  if (action === 'apply') {
    // A widget token may apply updates too (owner's decision, 2026-09-21). The
    // confirmation below is what makes that acceptable: a scheduled run is the
    // only thing that applies without a person, and it applies nothing a policy
    // does not already allow.
    //
    // Explicit, per-invocation confirmation. Not a default, not inferred from the
    // policy: the policy says what MAY happen on a schedule, this says a person
    // asked for it now.
    if (body?.confirm !== true) {
      throw Object.assign(new Error('Confirmation required: pass confirm: true to apply updates.'), { status: 400, code: 'CONFIRM_REQUIRED' });
    }

    const policy = await getPolicy(projectId);
    const scan = await scanSite(user, projectId, { force: true });
    const conn = await getWpConnection(projectId, user.id);
    if (!conn) throw Object.assign(new Error('No WordPress site connected.'), { status: 400, code: 'NOT_CONNECTED' });

    const outcome = await applyAllowedUpdates({ conn, policy, scan, dryRun: body?.dry_run === true });

    // The same report a scheduled run writes, so the two cannot read differently.
    if (body?.dry_run !== true) {
      const content = runSummary({
        scan, policy,
        applied: outcome.applied,
        failed: outcome.failed,
        restored: outcome.restored,
        restoreFailed: outcome.restoreFailed,
        skipped: outcome.skipped,
      });
      try {
        await prisma.chatMessage.create({ data: { created_by_id: user.id, project_id: projectId, role: 'morpheus', content } });
      } catch { /* the result is returned either way; the report is best-effort */ }
    }

    return { ok: outcome.ok, outcome, scan, policy: policyPayload(policy) };
  }

  const scan = await scanSite(user, projectId, { force: body?.force === true });
  // The policy travels with the scan so the panel can say what is switched on
  // without a second round trip — and so it cannot show stale switches.
  return { ...scan, policy: policyPayload(await getPolicy(projectId)) };
}

/**
 * The policy, plus the sentences and dates the UI must not compute for itself.
 *
 * Row plumbing (`id`, `created_by_id`, timestamps) is stripped: the client has no
 * use for it, and last_result is parsed so the panel can show what the last
 * scheduled run actually found without a second round trip.
 */
function policyPayload(policy) {
  const { applicable, reported } = allowedKinds(policy);
  let lastResult = null;
  if (policy.last_result) {
    try { lastResult = JSON.parse(policy.last_result); } catch { lastResult = null; }
  }
  return {
    ...POLICY_DEFAULTS,
    scan_enabled: policy.scan_enabled,
    day_of_month: policy.day_of_month,
    hour_utc: policy.hour_utc,
    apply_plugins: policy.apply_plugins,
    apply_themes: policy.apply_themes,
    apply_core_minor: policy.apply_core_minor,
    allow_core_major_manual: policy.allow_core_major_manual,
    exists: policy.exists === true,
    last_scan_at: policy.last_scan_at || null,
    last_result: lastResult,
    description: describePolicy(policy),
    next_run_at: nextRunAt(policy),
    can_apply_unattended: applicable,
    report_only: reported,
  };
}
