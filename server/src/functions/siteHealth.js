// Site health and maintenance for one connected WordPress site.
//
// One function with an `action` because the widget scope is a function-name
// allow-list: one name to grant, one name to audit.
//
//   scan   — read the site and report (via lib/siteScan.js, shared with the
//            monthly schedule so there is one definition of a scan)
//   policy — read or write what the owner allows, and when
//   clean  — CLEAN MY SITE: the heavier scan for what is on the server that
//            nobody asked for (lib/siteScan.js's scanCleanSite). Its own action
//            and its own cache, because it checksums core, walks uploads/ and
//            may download plugin packages — it must not run when a panel opens.
//   fix    — apply ONE finding, by id, that the site's own registry marks `auto`
//   propose— ASK what Morpheus would do about a finding it has a mechanism for,
//            and change nothing. The vocabulary is the site's; the model chooses
//            from it; the answer is checked here and again before anything is written.
//   updates— force the plugin's own update check
//   apply  — apply the updates the policy allows, one snapshotted target at a time
//   logs   — the site's PHP error log, READ rather than merely measured
//            (lib/siteScan.js's readErrorLog). Read-only, and there is no action
//            that clears, rotates or truncates it: the operator's evidence is not
//            ours to delete. Its own request because a log tail is unbounded in
//            principle where the scan is cached for five minutes.
//
// There is deliberately NO bulk apply action for CLEAN MY SITE beyond `fix`: a
// modified core file, a modified plugin file, an admin account and a cron hook
// are reported and never applied, because re-downloading core over a live site
// and removing an account are the owner's decisions.
import { prisma } from '../db.js';
import { getWpConnection, wpFix, wpUpdates, wpHealth } from '../lib/wpPlugin.js';
import { invokeAI } from '../ai.js';
import {
  PROPOSAL_ROLE, PROPOSAL_SCHEMA, buildProposalPrompt, validateProposal, describeProposal,
} from '../lib/aiFixProposal.js';
import { scanSite, scanCleanSite, readErrorLog } from '../lib/siteScan.js';
import { getPolicy, savePolicy } from '../lib/siteMaintenanceStore.js';
import { applyAllowedUpdates } from '../lib/siteApply.js';
import { describePolicy, nextRunAt, allowedKinds, runSummary, POLICY_DEFAULTS } from '../lib/siteMaintenance.js';
import { quarantineEvidence, undoLine } from '../lib/robotsQuarantine.js';
// Used by the `fix` branch below to name a plugin too old to know an action.
// It was referenced and NEVER IMPORTED on main: `node --check` cannot see an
// unresolved identifier, so every fix against a site that answered a non-200
// threw "isPluginTooOld is not defined" instead of the sentence the operator
// needs. The dock rig found it the moment CLEAN MY SITE's press ran for real.
import { isPluginTooOld } from '../lib/siteHealth.js';
import { cleanQuarantineEvidence, cleanUndoLine } from '../lib/siteClean.js';

const ACTIONS = new Set(['scan', 'policy', 'apply', 'fix', 'propose', 'updates', 'clean', 'logs']);

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

  if (action === 'updates') {
    const conn = await getWpConnection(projectId, user.id);
    if (!conn) throw Object.assign(new Error('No WordPress site connected.'), { status: 400, code: 'NOT_CONNECTED' });

    const res = await wpUpdates(conn, { action: 'check' });
    if (res.status === 0) {
      throw Object.assign(new Error(`Could not reach ${conn.siteUrl} — ${res.error || 'no response'}`), { status: 502, code: 'UNREACHABLE' });
    }
    // 404 is the bootstrap case, not a failure: the route only exists in 0.6.4+,
    // so a site that needs this check most is exactly the site that cannot answer
    // it. The panel gets a named state and tells the operator to install the zip
    // by hand — once.
    if (res.status === 404 || res.status === 501) {
      throw Object.assign(
        new Error('This build of the plugin cannot check for its own updates yet. Install the current plugin from morpheus.nz once, by hand — after that it updates itself.'),
        { status: 409, code: 'UPDATES_UNSUPPORTED' },
      );
    }
    if (res.status !== 200) {
      throw Object.assign(new Error(res.data?.error || `The site answered HTTP ${res.status} to an update check.`), { status: 502, code: 'UPDATES_FAILED' });
    }
    return { ok: res.data?.ok === true, updates: res.data || null };
  }

  if (action === 'propose') {
    // ASK MORPHEUS WHAT IT WOULD DO — and change nothing.
    //
    // The whole design rests on this branch being read-only. The vocabulary comes from
    // the SITE (its own ai_operations), not from this request, so a compromised or
    // confused client cannot widen what may be proposed; the model chooses from that
    // vocabulary and nothing else; and the answer is checked here AND again by the
    // plugin before any file is touched. What comes back is shown to the operator, who
    // presses apply or does not.
    const findingId = String(body?.finding || body?.id || '');
    if (!findingId) throw Object.assign(new Error('finding id required'), { status: 400 });

    const conn = await getWpConnection(projectId, user.id);
    if (!conn) throw Object.assign(new Error('No WordPress site connected.'), { status: 400, code: 'NOT_CONNECTED' });

    const res = await wpHealth(conn, {});
    if (res.status === 0) {
      throw Object.assign(new Error(`Could not reach ${conn.siteUrl} — ${res.error || 'no response'}`), { status: 502, code: 'UNREACHABLE' });
    }
    const old = isPluginTooOld(res, null);
    if (old.tooOld) throw Object.assign(new Error(old.message), { status: 409, code: 'PLUGIN_TOO_OLD' });

    const scan = res.data || {};
    const all = [...(scan.tests || []), ...(scan.own_checks || [])];
    const finding = all.find((f) => String(f?.id || '') === findingId);
    if (!finding) {
      throw Object.assign(new Error('That finding is not on the site any more — re-scan and try again. Nothing was changed.'), { status: 404, code: 'FINDING_GONE' });
    }
    const menu = (scan.ai_operations || {})[findingId] || null;
    if (!menu || !menu.op) {
      throw Object.assign(new Error('Morpheus has no mechanism to propose for this finding. Nothing was changed.'), { status: 409, code: 'NO_AI_ACTION' });
    }

    const prompt = buildProposalPrompt({
      finding,
      menu,
      site: {
        wpVersion: scan.wp_version,
        phpVersion: scan.php_version,
        timezone: scan.host?.timezone_string || null,
        phpTimezone: scan.host?.php_timezone || null,
      },
    });

    let raw = null;
    try {
      const { result } = await invokeAI({
        userId: user.id,
        prompt,
        schema: PROPOSAL_SCHEMA,
        // The recorded slot for "analyse, don't build". Named explicitly: a call that
        // names no role silently takes default_model @ default_temperature, and this is
        // a reasoning-shaped request, not a classifier.
        role: PROPOSAL_ROLE,
        // Generous rather than tight. It answers with a sentence and a value, but the
        // reasoning tax is real and a schema call that is cut off mid-object THROWS —
        // which would read to the operator as a broken button.
        maxTokens: 1600,
        task: 'ai_fix_proposal',
      });
      raw = result;
    } catch (e) {
      throw Object.assign(new Error(`Morpheus could not work out what to do about this one: ${e.message}. Nothing was changed.`), { status: 502, code: 'PROPOSAL_FAILED' });
    }

    const verdict = validateProposal(raw, { findingId, menu });
    if (!verdict.ok) {
      throw Object.assign(new Error(verdict.error), { status: 409, code: verdict.code });
    }
    return {
      ok: true,
      // The honest "no" — the model declining to act, with its reason, is an answer this
      // design prefers to a plausible-looking change. The panel shows it and offers no
      // button.
      cannot: verdict.cannot,
      proposal: verdict.proposal,
      menu,
      describe: describeProposal(verdict.proposal, menu),
    };
  }

  if (action === 'fix') {
    const finding = String(body?.finding || body?.id || '');
    if (!finding) throw Object.assign(new Error('finding id required'), { status: 400 });

    const conn = await getWpConnection(projectId, user.id);
    if (!conn) throw Object.assign(new Error('No WordPress site connected.'), { status: 400, code: 'NOT_CONNECTED' });

    // A proposal is applied through the SAME route as every other fix, and the plugin
    // re-validates it against the site's own state. This handler does not decide what is
    // safe to write — it decides what may be asked.
    const proposal = body?.proposal && typeof body.proposal === 'object'
      ? { op: String(body.proposal.op || ''), args: body.proposal.args && typeof body.proposal.args === 'object' ? body.proposal.args : {} }
      : null;
    const res = await wpFix(conn, finding, proposal);
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
    // Quarantine-instead-of-delete is only a promise if the undo is visible. The
    // site's own answer names the file it renamed; this lifts that out of the
    // sentence into a field the panel states plainly, and is null for every
    // other finding. A rename on the plugin side makes it null rather than
    // wrong — see lib/robotsQuarantine.js.
    const evidence = quarantineEvidence(res.data, finding);
    // The same promise for the CLEAN MY SITE quarantine fixes. One field on the
    // wire (`quarantine`), two readers, and each only recognises its own finding
    // ids — so a rename on either side is a missing undo line rather than a wrong
    // one. A clean fix renames a LIST of files; the robots fix renames one.
    const cleanEvidence = evidence ? null : cleanQuarantineEvidence(res.data, finding);
    const undo = evidence ? undoLine(evidence) : cleanUndoLine(cleanEvidence);
    return {
      ok: res.data?.ok === true,
      fix: res.data || null,
      quarantine: evidence
        ? { ...evidence, undo }
        : (cleanEvidence ? { ...cleanEvidence, undo } : null),
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

  if (action === 'clean') {
    // CLEAN MY SITE. Its OWN action and its own cache on the plugin side,
    // because the scan is heavy — a checksum pass over core, plugins and
    // uploads/ — and must not ride along with the scan that runs when a panel
    // opens. The panel has a separate button, and this is what it calls.
    //
    // Deliberately no policy gate and no confirmation: the scan only LOOKS. The
    // one press that changes anything is the existing `fix` action below, which
    // applies one finding the site's own registry marks `auto` — and every one
    // of those renames a file and reports the undo.
    return scanCleanSite(user, projectId, { force: body?.force === true });
  }

  if (action === 'logs') {
    // THE SITE'S ERROR LOG. Read-only, and its own request: a log is the one file
    // on a site that can be gigabytes, and the health scan is cached for five
    // minutes — folding the two together would either ship log text on every panel
    // open or make the log view five minutes stale. The panel has its own button.
    //
    // Deliberately NO sibling action that clears, rotates or truncates the log.
    // An operator's evidence is not ours to delete, and a "clear log" button would
    // be the easiest way for this product to destroy the thing it was asked to show.
    // `full` is the operator asking for the WHOLE file, from a button that says so. It
    // only widens the plugin's own bounds; it cannot uncap them.
    return readErrorLog(user, projectId, { lines: body?.lines, full: body?.full === true });
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
