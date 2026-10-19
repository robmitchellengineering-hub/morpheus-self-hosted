// Turning a raw result list into the two or three pages worth READING.
//
// WHY THIS EXISTS. Morpheus runs its own web search (2026-10-04) because every hosted grounding option
// turned out to be closed to this account: Gemini's grounded search is "Not available" on the free tier
// for Gemini 3.x, its 2.5 models — which still had a free allowance — answer 404 "no longer available to
// new users", Google's Custom Search JSON API is closed to new customers, and Brave's free tier was
// killed in Feb 2026. Measured directly against the two questions Jarvis had failed on, DuckDuckGo's
// HTML endpoint answered both, and put the ACTUAL government page first:
//
//   "NSW land tax threshold 2026"  → revenue.nsw.gov.au/…/understanding-land-tax/…
//   "dingo permit NSW ownership"   → environment.nsw.gov.au/…/wildlife-licences/native-animals-as-pets
//
// But the raw list is not usable as-is, and this module is the difference:
//
//   1. IT CONTAINS ADS. Measured: the top TWO results for "2008 RAV4 idle squeal cause" were
//      `duckduckgo.com/y.js?ad_domain=…&ad_provider=bingv7aa` — a repair-manual shop and an eBay listing,
//      ahead of the real answer. Fetching those would waste the request and feed Jarvis an advert.
//   2. IT REPEATS HOSTS. One question returns four pages from the same site; reading three of them costs
//      three fetches for one source's opinion.
//   3. ORDER IS NOT AUTHORITY. For a jurisdiction-specific fact, the tax office's own page beats a
//      mortgage broker's summary of it, whatever the ranking says. So official domains go first — and it
//      is only a PREFERENCE (a stable sort), never a filter: if the only page answering the question is a
//      forum, a forum is what gets read.
//
// Import-free and pure on purpose, so `scripts/verify-web-research.mjs` can test every rule with fixtures
// in CI's no-install guards job. The network lives in webResearch.js; the decisions live here.

/** Hosts that are search plumbing rather than an answer. */
const AD_HOST_PARTS = ['duckduckgo.com', 'bing.com', 'googleadservices.com', 'doubleclick.net'];

/** Official-looking suffixes, checked longest-first so `.gov.au` is not read as `.au`. */
const OFFICIAL_SUFFIXES = [
  '.gov.au', '.govt.nz', '.gov.uk', '.gov', '.mil', '.edu.au', '.edu', '.ac.uk', '.ac.nz',
  '.gov.ie', '.govt.au', '.gouv.fr', '.gc.ca', '.europa.eu',
];

export function hostOf(url) {
  try { return new URL(String(url)).host.replace(/^www\./, '').toLowerCase(); } catch { return ''; }
}

/**
 * An advertisement or a click-tracker, not a result.
 *
 * DuckDuckGo's own redirector counts too: a `/y.js?ad_domain=` link is an ad served through their
 * domain, and a `/l/?uddg=` link is the wrapper this code already unwraps — if one survives unwrapping,
 * it is a result that could not be resolved and must not be fetched.
 */
export function isAdOrTracker(url) {
  const raw = String(url || '');
  if (!/^https?:\/\//i.test(raw)) return true;
  let parsed;
  try { parsed = new URL(raw); } catch { return true; }
  const host = parsed.host.replace(/^www\./, '').toLowerCase();
  const path = parsed.pathname;
  if (host === 'duckduckgo.com' && (path.startsWith('/y.js') || path.startsWith('/l/'))) return true;
  if (parsed.searchParams.has('ad_domain') || parsed.searchParams.has('ad_provider')) return true;
  if (AD_HOST_PARTS.some((h) => host === h || host.endsWith(`.${h}`)) && /ad|click|y\.js|aclk/i.test(path + parsed.search)) return true;
  return false;
}

/** A government, military or academic host — where a jurisdiction-specific fact actually lives. */
export function isOfficial(url) {
  const host = hostOf(url);
  if (!host) return false;
  return OFFICIAL_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/**
 * Deduplicate by host, keeping the first (best-ranked) page from each.
 *
 * First-seen wins deliberately: within one site, the search engine's own ordering is a better guide to
 * which page answers the question than anything this module could infer from the URL.
 */
export function dedupeByHost(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const host = hostOf(item?.url);
    if (!host || seen.has(host)) continue;
    seen.add(host);
    out.push(item);
  }
  return out;
}

/**
 * The results worth reading: no ads, no trackers, one page per host, official sources first, capped.
 *
 * The sort is STABLE BY CONSTRUCTION (official rank, then original index) rather than trusting the
 * engine's stability, so the search engine's relevance order is preserved inside each group.
 *
 * @param {Array<{url?: string, title?: string, snippet?: string}>} items
 * @param {{max?: number}} [options]
 * @returns {Array<object>}
 */
export function rankResults(items, { max = 3 } = {}) {
  const clean = (Array.isArray(items) ? items : [])
    .filter((item) => item && typeof item === 'object')
    .filter((item) => !isAdOrTracker(item.url));
  const capped = Number.isFinite(max) && max > 0 ? max : 3;
  return dedupeByHost(clean)
    .map((item, index) => ({ item, index, official: isOfficial(item.url) ? 0 : 1 }))
    .sort((a, b) => (a.official - b.official) || (a.index - b.index))
    .slice(0, capped)
    .map((entry) => entry.item);
}

/**
 * The cache key for a query — case- and whitespace-insensitive, so "NSW land tax" and "nsw  land  tax"
 * are one lookup. A repeated question must not hit the search endpoint twice.
 */
export function searchCacheKey(query) {
  return String(query ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Is a cached entry still usable? `ttlMs` injected so the rule is testable without a clock.
 *
 * An entry with no usable timestamp is NOT fresh: an unknown age is an absence of evidence, and serving
 * a stale answer as current is the failure this feature exists to prevent.
 */
export function isCacheFresh(entry, nowMs, ttlMs) {
  const at = Number(entry?.at);
  if (!Number.isFinite(at) || at <= 0) return false;
  if (!Number.isFinite(nowMs) || !Number.isFinite(ttlMs)) return false;
  return nowMs - at < ttlMs;
}

// ── Parsing the result page ───────────────────────────────────────────────────────────────────────
//
// Here rather than beside the fetch, deliberately: this is the FRAGILE part — it reads a public HTML
// page that owes us nothing and can change shape without notice — so it has to be testable with a
// saved fixture in CI's no-install job. `webResearch.js` imports Prisma and the AI gateway, so anything
// that lives there cannot be tested by a guard at all. A guard that cannot run is not a pass.

const decodeEntities = (html) => String(html || '')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
  .replace(/\s+/g, ' ').trim();

/**
 * Parse DuckDuckGo's HTML result list, unwrapping the redirector to the real URL.
 *
 * @param {string} html
 * @returns {Array<{title: string, url: string, snippet: string}>} raw, in the engine's order
 */
export function parseDuckDuckGoResults(html) {
  const out = [];
  const linkRe = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  for (const m of String(html || '').matchAll(linkRe)) {
    let url = m[1];
    // Results arrive wrapped: //duckduckgo.com/l/?uddg=<encoded>&rut=…
    const wrapped = url.match(/[?&]uddg=([^&]+)/);
    if (wrapped) { try { url = decodeURIComponent(wrapped[1]); } catch { /* keep the raw href */ } }
    if (url.startsWith('//')) url = `https:${url}`;
    out.push({ title: decodeEntities(m[2]), url, snippet: '' });
  }
  // Snippets sit in a separate block, positionally after each link — pair them up in order.
  const snippets = [...String(html || '').matchAll(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => decodeEntities(m[1]));
  snippets.forEach((snippet, i) => { if (out[i] && snippet) out[i].snippet = snippet; });
  return out.filter((r) => r.url);
}
