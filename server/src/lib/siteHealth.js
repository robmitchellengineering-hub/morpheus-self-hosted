// Turning a WordPress site-health scan into something a person can act on.
//
// Pure and dependency-free on purpose: the rules below are the ones that decide
// what the operator is told, so they are asserted directly by
// scripts/verify-site-health.mjs in CI's no-install guards job (hazard H4 — the
// guard must not reach @prisma/client through lib/wpPlugin.js).
//
// WHAT THIS FILE REFUSES TO DO
//
// No score. No percentage. No "health: 82%". A single number invites
// optimisation of the number instead of the site, and there is no honest way to
// weight a missing PHP extension against an open registration form. The payload
// is a list of findings with WordPress's own verdicts on them, and this module
// orders and counts them — nothing more.
//
// Every finding keeps its SOURCE, because WordPress's Site Health and Morpheus's
// own checks are not the same authority. Presenting our own opinion as
// WordPress's verdict would be the kind of small lie that makes the real ones
// unreadable.

/** How the two sources are labelled wherever a finding is shown. */
export const SOURCE_LABELS = {
  wordpress: 'WordPress Site Health',
  morpheus: 'Morpheus check',
};

/** Worst first. `unknown` sits above `good`: an unanswered question is not a pass. */
export const SEVERITY_ORDER = ['critical', 'recommended', 'unknown', 'good'];

export function severityRank(status) {
  const i = SEVERITY_ORDER.indexOf(String(status || '').toLowerCase());
  return i === -1 ? SEVERITY_ORDER.length : i;
}

/**
 * The fix kinds a finding may carry, and the only ones a button may be built from.
 *
 * Kept here rather than in the UI so a malformed action cannot become a button
 * that does nothing: an unknown kind becomes NO fix rather than a broken one, and
 * a guided finding with no steps is refused for the same reason — "guide me" with
 * nothing to read is a dead end wearing a button.
 */
export const FIX_KINDS = ['auto', 'guided', 'updates', 'none'];

export function normaliseFix(fix) {
  if (!fix || typeof fix !== 'object') return null;
  const kind = FIX_KINDS.includes(fix.kind) ? fix.kind : null;
  if (!kind) return null;
  const steps = Array.isArray(fix.steps)
    ? fix.steps
      .filter((s) => s && typeof s.text === 'string' && s.text.trim())
      .map((s) => ({ text: s.text, link: typeof s.link === 'string' && s.link ? s.link : null }))
    : [];
  if ('guided' === kind && !steps.length) return null;
  return {
    kind,
    label: String(fix.label || ''),
    does: String(fix.does || ''),
    warning: fix.warning ? String(fix.warning) : null,
    steps,
    // Which mechanism Morpheus could PROPOSE for this finding, in the operator's own
    // words, or null when it has none. Only ever a label — the operation and its
    // arguments live in the plugin and are re-read from the site at proposal time, so a
    // panel cannot be fed a vocabulary by whatever answered the scan.
    ai: fix.ai ? String(fix.ai) : null,
  };
}

/**
 * The record of the LAST attempt at one finding, as the site wrote it.
 *
 * WHY THIS IS DERIVED HERE AND NOT IN THE PANEL
 *
 * A refused fix used to leave no trace: the site declined, the panel rescanned
 * to the same count, and nothing on screen said why — so a working refusal read
 * exactly like a broken button. The plugin now keeps the last attempt per
 * finding and the scan returns it, which means the reason survives a reload and
 * comes from the site rather than from the panel's own state. Turning it into a
 * sentence is a rule about what an operator is told, so it lives here with the
 * other rules and is asserted directly.
 *
 * WHAT IT REFUSES: to read as success. Only an explicit `done` is a success;
 * anything else — a missing outcome, an unknown string, a shape we have never
 * seen — is treated as a refusal, because a record that claims a fix worked
 * when it did not is worse than no record at all.
 */
export function attemptRecord(attempt) {
  if (!attempt || typeof attempt !== 'object') return null;
  const outcome = attempt.outcome === 'done' ? 'done' : 'refused';
  const code = typeof attempt.code === 'string' && attempt.code ? attempt.code : null;
  const message = typeof attempt.message === 'string' ? attempt.message.trim() : '';
  const at = typeof attempt.at === 'string' && attempt.at ? attempt.at : null;
  if (!message && !code && !at) return null;
  return { outcome, code, message, at };
}

/** An ISO instant as the operator reads it, in UTC — the record's own clock. */
function attemptWhen(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/**
 * The line under a finding saying what the last attempt did, or null when there
 * was none. Null rather than a reassuring sentence: an absent record is not a
 * successful one.
 *
 * The site's CODE is carried in the sentence too, because it is the one part of
 * a refusal that is the same on every site and is what a host or a support
 * conversation asks for; the message is the site's own words beside it.
 */
export function attemptLine(attempt) {
  const record = attemptRecord(attempt);
  if (!record) return null;
  const when = record.at ? attemptWhen(record.at) : null;
  const stamp = when ? ` (${when})` : '';
  const code = record.code ? ` [${record.code}]` : '';
  const why = record.message || (record.code ? `the site answered ${record.code}` : 'the site did not say why');
  return record.outcome === 'done'
    ? `Last successful fix${stamp}${code}: ${why}`
    : `Last attempt refused${stamp}${code}: ${why}`;
}

/** Every finding in one list, worst first, each tagged with where it came from. */
export function findings(scan = {}) {
  const out = [];
  for (const t of scan.tests || []) {
    out.push({
      id: t.id,
      label: t.label,
      status: String(t.status || 'unknown').toLowerCase(),
      badge: t.badge || '',
      description: t.description || '',
      links: Array.isArray(t.links) ? t.links : [],
      // The action, carried through from the plugin's registry. Dropping it here
      // is what would make every finding unactionable while the engine below was
      // fully working — the guard asserts it survives this mapper.
      fix: normaliseFix(t.fix),
      // What the last attempt at this finding did, from the site's own record.
      last_attempt: attemptRecord(t.last_attempt),
      attempt_line: attemptLine(t.last_attempt),
      source: 'wordpress',
      sourceLabel: SOURCE_LABELS.wordpress,
    });
  }
  for (const c of scan.own_checks || []) {
    out.push({
      id: c.id,
      label: c.label,
      status: String(c.status || 'unknown').toLowerCase(),
      badge: c.badge || '',
      description: c.description || '',
      links: Array.isArray(c.links) ? c.links : [],
      fix: normaliseFix(c.fix),
      last_attempt: attemptRecord(c.last_attempt),
      attempt_line: attemptLine(c.last_attempt),
      source: 'morpheus',
      sourceLabel: SOURCE_LABELS.morpheus,
    });
  }
  // Stable within a severity: keep the order WordPress and the plugin supplied,
  // so two scans of an unchanged site read the same.
  return out
    .map((f, i) => ({ ...f, _i: i }))
    .sort((a, b) => severityRank(a.status) - severityRank(b.status) || a._i - b._i)
    .map(({ _i, ...f }) => f);
}

/** Counts, and the one-line headline the panel leads with. */
export function summarise(scan = {}) {
  const all = findings(scan);
  const count = (s) => all.filter((f) => f.status === s).length;
  const critical = count('critical');
  const recommended = count('recommended');
  const unknown = count('unknown');
  const good = count('good');
  const attention = critical + recommended;

  let headline;
  if (!all.length) {
    headline = 'The scan returned no checks at all, which is not the same as a clean site — this usually means the plugin could not load WordPress\'s own health tests.';
  } else if (critical) {
    headline = `${critical} thing${critical === 1 ? '' : 's'} need${critical === 1 ? 's' : ''} fixing now, and ${recommended} more worth doing.`;
  } else if (recommended) {
    headline = `Nothing critical. ${recommended} recommendation${recommended === 1 ? '' : 's'}.`;
  } else {
    headline = 'Every check passed.';
  }

  return { total: all.length, critical, recommended, unknown, good, attention, headline };
}

/** Just the things worth doing something about, worst first. */
export function attention(scan = {}) {
  return findings(scan).filter((f) => f.status === 'critical' || f.status === 'recommended');
}

/**
 * Is the update data recent enough to trust?
 *
 * "No updates available" is only reassuring if WordPress has actually asked
 * recently — it checks twice a day. A site whose cron is broken, or whose
 * outbound requests are blocked, will happily report zero updates forever, and
 * that is precisely the site that most needs updating. So the age is part of the
 * answer, not a footnote.
 */
export function dataFreshness(scan = {}, now = Date.now()) {
  const checked = scan.update_checked_at ? Number(scan.update_checked_at) * 1000 : null;
  if (!checked || Number.isNaN(checked)) {
    return {
      known: false,
      stale: true,
      ageMs: null,
      message: 'WordPress has not checked for updates on this site yet, so "nothing to update" cannot be trusted. Open Dashboard → Updates on the site once, or check again after its next scheduled check.',
    };
  }
  const ageMs = Math.max(0, now - checked);
  const hours = ageMs / 3_600_000;
  const stale = hours > STALE_AFTER_HOURS;
  return {
    known: true,
    stale,
    ageMs,
    message: stale
      ? `WordPress last checked for updates ${describeAge(ageMs)} ago. It normally checks twice a day, so this list may be out of date — and a site that cannot reach wordpress.org reports "no updates" indefinitely.`
      : `WordPress last checked for updates ${describeAge(ageMs)} ago.`,
  };
}

/** WordPress checks twice daily; twice that is comfortably "should have run by now". */
export const STALE_AFTER_HOURS = 24;

export function describeAge(ms) {
  const mins = Math.round(ms / 60_000);
  if (mins < 2) return 'less than a minute';
  if (mins < 60) return `${mins} minutes`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.round(hours / 24);
  return `${days} days`;
}

/**
 * Can Morpheus write files on this site at all?
 *
 * Answered from the site's own report rather than assumed, because on shared
 * hosting it is routinely false and no amount of effort on our side changes it.
 * When it is false the honest move is to say so and stop, not to offer a button
 * that fails — and never to ask the operator for FTP or SSH credentials.
 */
export function canApply(scan = {}) {
  const host = scan.host || {};
  const can = scan.can || {};
  const reasons = Array.isArray(host.blockers) && host.blockers.length
    ? host.blockers
    : (can.reason ? [can.reason] : []);
  const ok = can.update_files === undefined ? !!host.can_update_files : !!can.update_files;
  return {
    ok,
    reasons,
    message: ok
      ? 'WordPress can write plugin and theme files directly, so updates can be applied from here.'
      : `Morpheus cannot change files on this site: ${reasons.join('; ') || 'the site did not say why'}. Updates have to be applied by your host or by hand until that changes — Morpheus will not ask you for FTP or SSH credentials.`,
  };
}

/** How many things an update pass would touch, and of what kind. */
export function updatePlan(scan = {}) {
  const u = scan.updates || {};
  const plugins = Array.isArray(u.plugins) ? u.plugins : [];
  const themes = Array.isArray(u.themes) ? u.themes : [];
  const core = Array.isArray(u.core) ? u.core : [];
  const total = plugins.length + themes.length + core.length;
  return {
    plugins,
    themes,
    core,
    total,
    // Core updates are called out separately from the rest: a major core update
    // is a different decision from a plugin patch, and only the site owner can
    // make it.
    hasCore: core.length > 0,
    message: total === 0
      ? 'Nothing to update.'
      : `${total} update${total === 1 ? '' : 's'} available: ${[
        plugins.length ? `${plugins.length} plugin${plugins.length === 1 ? '' : 's'}` : null,
        themes.length ? `${themes.length} theme${themes.length === 1 ? '' : 's'}` : null,
        core.length ? 'WordPress itself' : null,
      ].filter(Boolean).join(', ')}.`,
  };
}

/**
 * Does this response mean "the site's Morpheus plugin is too old to be asked"?
 *
 * Two shapes, and both had to be handled the hard way on the working-copy pull:
 * a route that does not exist answers 404 `rest_no_route`, while a route that
 * exists without that action answers 400 `unknown_action`. Before 0.6.0 there is
 * no /health route at all. The running version is supplied by the caller (it has
 * to ask the site) so the message can name it.
 */
export function isPluginTooOld(res, runningVersion = null) {
  const body = res?.data || {};
  const code = body?.code || '';
  const running = runningVersion ? ` This site runs plugin ${runningVersion}.` : '';
  if (res?.status === 404 && (code === 'rest_no_route' || /no route was found/i.test(body?.message || ''))) {
    return { tooOld: true, message: `This site's Morpheus plugin is too old to scan — it has no health endpoint.${running} Update the plugin from wp-admin → Plugins (Morpheus offers the update there), then scan again.` };
  }
  if (res?.status === 400 && code === 'unknown_action') {
    return { tooOld: true, message: `This site's Morpheus plugin does not know the health action.${running} Update the plugin in wp-admin, then scan again.` };
  }
  if (res?.status === 501 && code === 'unsupported') {
    return { tooOld: true, message: `This site's Morpheus plugin builds without the health scan.${running} Update it in wp-admin, then scan again.` };
  }
  return { tooOld: false, message: null };
}
