// Uptime, as arithmetic — pure, so it can be asserted without a database or a site.
//
// WHY IT IS SEPARATE FROM THE POLLING. What Morpheus does with an observation is the
// part that can be WRONG in a way nobody notices: a percentage computed over the
// wrong window, an incident that never closes, a "down" that was really a timeout on
// our side. Those are decidable from the rows alone, which is what this module does —
// lib/siteUptimeStore.js does the I/O and functions/siteUptime.js does the request.
//
// TWO THINGS ARE DELIBERATELY NOT SIMPLIFIED AWAY:
//
//   * `status_code: 0` means the site never answered at all, and it is kept distinct
//     from an HTTP error the site itself sent. The remedies differ: a 500 is the
//     site's problem, no response is usually DNS, TLS or the host.
//   * a window with NO checks reports `null`, never 0% and never 100%. "We did not
//     look" and "it was down" are different facts, and a site nobody has checked
//     must not read as broken — the same rule the plugin's error log follows for a
//     missing file.

/** How long a check row is kept. Pruned on write, so the table cannot grow forever. */
export const RETAIN_DAYS = 30;

/** The windows the panel reports, in days. */
export const WINDOWS = [1, 7, 30];

/** A check older than this is not "now" any more, however long the site has been up. */
export const STALE_AFTER_MS = 30 * 60 * 1000;

/**
 * What one observation of the site means.
 *
 * A 200 is the site answering, whatever it says — that is what uptime is. It is
 * NOT required to be the Morpheus plugin for the site to be up, but a 200 that is
 * not our plugin is recorded as such, because "the site is up but the plugin has
 * gone" is a real and confusing state and the panel should be able to name it.
 */
export function classifyProbe(res) {
  const status = Number(res?.status || 0);
  if (status === 0) {
    return { ok: false, status_code: 0, plugin_version: null, error: String(res?.error || 'no response') };
  }
  if (status !== 200) {
    return {
      ok: false,
      status_code: status,
      plugin_version: null,
      error: String(res?.data?.message || res?.data?.error || `HTTP ${status}`),
    };
  }
  const isOurs = res?.data?.plugin === 'morpheus';
  return {
    ok: true,
    status_code: 200,
    plugin_version: isOurs && res.data.version ? String(res.data.version) : null,
    error: isOurs ? null : 'the site answered, but not with the Morpheus plugin',
  };
}

/**
 * Where the site stands over time.
 *
 * @param {Array} rows  checks, OLDEST FIRST — the order incidents need.
 * @param {number} now  ms since epoch, passed in so this is testable.
 */
export function summarise(rows, now = Date.now()) {
  const checks = Array.isArray(rows) ? rows.filter(Boolean) : [];
  const out = {
    checks: checks.length,
    state: 'unknown',
    last_checked_at: null,
    stale: false,
    plugin_version: null,
    avg_latency_ms: null,
    // Every window present from the start, as null. A window nobody has looked in is
    // "unknown", and it is the SAME fact whether there are no checks at all or none
    // inside that window — so the panel must not have to tell `null` from `undefined`.
    uptime: Object.fromEntries(WINDOWS.map((d) => [`${d}d`, null])),
    incidents: [],
  };

  if (checks.length === 0) {
    return out; // never checked — and 'unknown', not 'down'
  }

  const last = checks[checks.length - 1];
  out.last_checked_at = last.checked_at || null;
  const lastMs = last.checked_at ? Date.parse(last.checked_at) : NaN;
  out.stale = Number.isFinite(lastMs) ? (now - lastMs) > STALE_AFTER_MS : true;
  out.state = last.ok ? 'up' : 'down';

  // The version the site LAST reported, not the newest row's — a site that is down
  // right now reported nothing, and the panel should still be able to say what it
  // was running before it went.
  for (let i = checks.length - 1; i >= 0; i--) {
    if (checks[i].plugin_version) { out.plugin_version = checks[i].plugin_version; break; }
  }

  let latencySum = 0;
  let latencyN = 0;
  for (const c of checks) {
    const ms = Number(c.latency_ms || 0);
    if (c.ok && ms > 0) { latencySum += ms; latencyN++; }
  }
  out.avg_latency_ms = latencyN ? Math.round(latencySum / latencyN) : null;

  for (const days of WINDOWS) {
    const since = now - (days * 24 * 60 * 60 * 1000);
    const inWindow = checks.filter((c) => {
      const t = Date.parse(c.checked_at || '');
      return Number.isFinite(t) && t >= since;
    });
    if (inWindow.length === 0) {
      // NOT 0% and NOT 100%: we did not look.
      out.uptime[`${days}d`] = null;
      continue;
    }
    const okN = inWindow.filter((c) => c.ok).length;
    out.uptime[`${days}d`] = Math.round((okN / inWindow.length) * 1000) / 10;
  }

  // Incidents: a run of consecutive failures, closed by the next success. An open
  // incident is real — the site is down now — so it is reported with `ended_at: null`
  // rather than being held back until it recovers.
  let open = null;
  for (const c of checks) {
    const t = c.checked_at || null;
    if (!c.ok) {
      if (!open) open = { started_at: t, ended_at: null, checks: 0, error: c.error || null, status_code: Number(c.status_code || 0) };
      open.checks++;
      open.error = c.error || open.error;
      open.status_code = Number(c.status_code || 0) || open.status_code;
      continue;
    }
    if (open) {
      open.ended_at = t;
      open.duration_ms = durationBetween(open.started_at, t);
      out.incidents.push(open);
      open = null;
    }
  }
  if (open) {
    open.duration_ms = durationBetween(open.started_at, null, now);
    out.incidents.push(open);
  }

  // Newest first for reading, whatever order they arrived in.
  out.incidents.reverse();
  return out;
}

/** How long an incident lasted. No end yet means "until now". */
export function durationBetween(startIso, endIso, now = Date.now()) {
  const a = Date.parse(startIso || '');
  const b = endIso ? Date.parse(endIso) : now;
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;
  return b - a;
}

/** A duration a person reads: "3h 12m", "45s", "2d 4h". */
export function humanDuration(ms) {
  if (ms == null || !Number.isFinite(ms)) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}
