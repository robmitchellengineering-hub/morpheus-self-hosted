// IndexNow — the pure half of the traffic tab's first workflow.
//
// IndexNow is the one indexing lever that needs no account and no OAuth: a site
// hosts a key file and POSTs the URLs it wants crawled. This module holds only
// the parts that can be decided without a network or a database — the payload
// shape, key validation, batching, and how a bounded ledger is summarised — so
// scripts/verify-traffic.mjs can drive every branch. The plugin does the actual
// submission (it is the thing on the site); trafficAction.js is the bridge.
//
// Nothing here invents a number: there is no "indexed?" field, no ranking, no
// traffic estimate. IndexNow returns an HTTP status and that is all it returns,
// so an accepted submission is all we may claim.

export const INDEXNOW_ENDPOINT = 'https://api.indexnow.org/indexnow';

/**
 * Our own conservative cap per request. NOT IndexNow's: the spec documents up to
 * 10,000 URLs in one post (indexnow.org/documentation). 100 keeps a single
 * backfill step small enough to fail cheaply and to stay readable in the ledger.
 */
export const MAX_URLS_PER_REQUEST = 100;

/** Ledger rows kept, newest first — the plugin's own cap, mirrored here. */
export const LEDGER_LIMIT = 500;

/** URLs per backfill run, so one click cannot blast thousands at a free service. */
export const MAX_BACKFILL = 200;

/**
 * The actions the plugin's /traffic endpoint answers.
 *
 * Listed here as well as in the PHP switch because it is a contract across a
 * boundary no compiler checks: verify-traffic.mjs compares the two, so renaming
 * one side and not the other fails the guard instead of failing at runtime on a
 * customer's site, where the failure is a silent 400 nobody sees.
 */
export const TRAFFIC_ACTIONS = ['status', 'ledger', 'backfill', 'settings'];

// OUR rule, not the spec's. IndexNow allows 8–128 characters from
// [A-Za-z0-9-] (its own example key, "myIndexNowKey63638", is not hex), but this
// system generates and serves exactly 32 hex characters — the plugin makes them
// with random_bytes(16) and its rewrite rule serves `[a-f0-9]{32}.txt`. Accepting
// the wider spec set here while the other side could only ever serve 32 hex would
// be two different rules for one fact, so both sides are deliberately hex-only.
// Widening this one alone would let a key through that the site cannot serve.
const KEY_RE = /^[a-f0-9]{8,128}$/i;

/**
 * Is this a key we can submit with?
 *
 * The range is the spec's minimum and maximum, narrowed to the characters we
 * actually produce; the plugin is authoritative about what it serves, and its
 * own `key_served` check reports the truth when a key is not reachable.
 */
export function isValidKey(key) {
  return typeof key === 'string' && KEY_RE.test(key.trim());
}

/** The host IndexNow expects — no scheme, no path, no port. */
export function hostFromSiteUrl(siteUrl) {
  const raw = String(siteUrl ?? '').trim();
  if (!raw) return '';
  try {
    const u = new URL(raw.includes('://') ? raw : `https://${raw}`);
    return u.hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** Where the key file must be reachable, or '' when we cannot say. */
export function keyLocation(siteUrl, key) {
  const host = hostFromSiteUrl(siteUrl);
  if (!host || !isValidKey(key)) return '';
  return `https://${host}/${String(key).trim()}.txt`;
}

/**
 * The submission body.
 *
 * Throws rather than returning a partial payload: a payload missing its host or
 * key is rejected by IndexNow with a 400/403 that reads, from the operator's
 * side, exactly like "the feature is broken" — so it must not be sent at all.
 */
export function buildPayload({ siteUrl, key, urls } = {}) {
  const host = hostFromSiteUrl(siteUrl);
  if (!host) throw new Error('Cannot build an IndexNow payload without a site URL.');
  if (!isValidKey(key)) throw new Error('Cannot build an IndexNow payload without a valid key.');
  const list = [...new Set((Array.isArray(urls) ? urls : []).map((u) => String(u ?? '').trim()).filter(Boolean))];
  if (list.length === 0) throw new Error('Nothing to submit.');
  const sameHost = list.filter((u) => hostFromSiteUrl(u) === host);
  if (sameHost.length !== list.length) {
    // IndexNow answers 422 for URLs that do not belong to the host, so this is a
    // local refusal with a clear reason rather than a third party's error code.
    throw new Error('Every URL submitted must belong to the site\'s own host.');
  }
  return {
    host,
    key: String(key).trim(),
    keyLocation: keyLocation(siteUrl, key),
    urlList: sameHost.slice(0, MAX_URLS_PER_REQUEST),
  };
}

/** Split URLs into request-sized batches (last batch may be smaller). */
export function chunkUrls(urls, size = MAX_URLS_PER_REQUEST) {
  const list = Array.isArray(urls) ? urls : [];
  const per = Math.max(1, Math.trunc(Number(size) || MAX_URLS_PER_REQUEST));
  const out = [];
  for (let i = 0; i < list.length; i += per) out.push(list.slice(i, i + per));
  return out;
}

/**
 * Which URLs a backfill should actually send.
 *
 * `accepted` is the set of URLs already known to have been accepted, so pressing
 * backfill twice sends nothing the second time — the difference between an
 * idempotent button and one that re-submits a whole site every press.
 */
export function selectBackfillUrls({ urls = [], accepted = [], limit = MAX_BACKFILL } = {}) {
  const done = accepted instanceof Set ? accepted : new Set(accepted);
  const cap = Math.max(0, Math.trunc(Number(limit) || MAX_BACKFILL));
  return urls
    .map((u) => String(u ?? '').trim())
    .filter((u) => u && !done.has(u))
    .slice(0, cap);
}

/** One ledger row, shaped and bounded — a bad row is dropped, not guessed at. */
export function normalizeLedgerRow(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const url = String(raw.url ?? '').trim();
  if (!url) return null;
  const status = Number(raw.status);
  return {
    at: typeof raw.at === 'string' ? raw.at : '',
    url,
    action: String(raw.action ?? 'manual').slice(0, 32),
    status: Number.isFinite(status) ? Math.trunc(status) : 0,
    note: String(raw.note ?? '').slice(0, 120),
  };
}

/** Newest-first, deduplicated by nothing (each submission is its own event), capped. */
export function boundLedger(rows, limit = LEDGER_LIMIT) {
  const cap = Math.max(1, Math.trunc(Number(limit) || LEDGER_LIMIT));
  return (Array.isArray(rows) ? rows : [])
    .map(normalizeLedgerRow)
    .filter(Boolean)
    .slice(0, cap);
}

/**
 * Whether IndexNow took the submission.
 *
 * 200 means "submitted successfully"; 202 means "received — key validation
 * pending". Both are transport-level success and neither is a rejection, so both
 * count here — but they are NOT the same state, and the ledger keeps the exact
 * code so the panel can say which one happened. Collapsing them in the UI would
 * hide the one signal that says our key file is not being served yet.
 */
export function isAccepted(status) {
  const n = Number(status);
  return Number.isFinite(n) && n >= 200 && n < 300;
}

/**
 * What the ledger adds up to.
 *
 * `lastOk` is the most recent accepted submission — the only evidence a tab may
 * show for "this is working". Everything else here is a count of what we did,
 * not of what it achieved, and the UI must word it that way.
 */
export function summarizeLedger(rows = []) {
  const list = boundLedger(rows, Math.max(LEDGER_LIMIT, Array.isArray(rows) ? rows.length : 0));
  let accepted = 0;
  let failed = 0;
  let lastOk = null;
  for (const row of list) {
    if (isAccepted(row.status)) {
      accepted += 1;
      if (lastOk === null && row.at) lastOk = row.at;
    } else {
      failed += 1;
    }
  }
  return { submitted: list.length, accepted, failed, lastOk };
}

/**
 * The parts of the traffic plan this build does not contain, named so the tab
 * cannot quietly imply they exist. Kept beside the code that would grow them.
 */
export const NOT_BUILT = {
  sitemap: 'Sitemap hygiene is not built yet.',
  orphans: 'Orphan pages and internal-link automation are not built yet.',
  areas: 'Service and area pages are not built yet.',
  gbp: 'Google Business Profile needs Google\'s API approval before anything here can use it.',
};
