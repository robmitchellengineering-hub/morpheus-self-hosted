// Web research for the build pipeline — search the web and read pages so the
// planner/coder can work against CURRENT external information (library/API
// versions, current best practices, an error string, a URL the operator
// pasted) that isn't in the project files.
//
// FREE / no-signup by design (2026-09-09, Rob). Provider stack, best-effort,
// each tier degrades to nothing rather than failing the build:
//   1. Gemini `google_search` grounding — real web search. Uses a Gemini key
//      (the caller's own Settings AI key if it's a Gemini endpoint, else this
//      deployment's FALLBACK_LLM_* key). ~5,000 grounded queries/month free
//      per key on the Gemini 3.x family, then usage-billed to that key's
//      owner. No key => grounded search is simply skipped.
//   2. Wikipedia REST API — general knowledge. No key.
//   3. arXiv API — academic papers, when the query looks research-y. No key.
//   4. `/llms.txt` — a site's own LLM-readable summary, for "how does X work".
//      No key, plain GET.
//   5. Direct `fetch()` + HTML→text — for a URL the operator pasted. No key.
//
// There is deliberately no paid search API here and nothing to configure for
// tiers 2–5, so `webResearchConfigured()` is always true.
import { getUserSettings } from '../ai.js';
import { decrypt } from '../crypto.js';
import { rankResults, searchCacheKey, isCacheFresh, parseDuckDuckGoResults } from './searchResults.js';

const GEMINI_HOST = 'generativelanguage.googleapis.com';
const TIMEOUT_MS = 20_000;
// Our own search gets a tighter budget than a page read: a search that has not answered in ten seconds
// is not going to, and the reply is waiting on it.
const SEARCH_TIMEOUT_MS = 10_000;
const UA = 'MorpheusResearchBot/1.0 (+https://morpheus.nz)';

export const URL_RE = /\bhttps?:\/\/[^\s<>"')]+/gi;

// Tiers 2–5 need nothing configured, so web research is always available; the
// grounded-search tier just adds quality when a Gemini key is around.
export function webResearchConfigured() {
  return true;
}

function geminiModel(m) {
  const v = String(m || '').trim().replace(/^models\//, '');
  if (!v || /^(auto|latest|default)$/i.test(v)) return 'gemini-flash-latest';
  return v;
}

// A Gemini key + model for google_search grounding, or null. Prefers the
// caller's own AI connection when it points at Gemini (their quota, their
// bill), then falls back to this deployment's Gemini fallback key.
export async function resolveSearchKey(userId) {
  const isGemini = (u) => typeof u === 'string' && u.includes(GEMINI_HOST);
  try {
    const s = await getUserSettings(userId);
    if (s?.ai_api_key && isGemini(s.ai_base_url)) {
      return { key: decrypt(s.ai_api_key), model: geminiModel(s.ai_model), source: 'user' };
    }
  } catch { /* fall through to the deployment key */ }
  if (process.env.FALLBACK_LLM_API_KEY && isGemini(process.env.FALLBACK_LLM_BASE_URL)) {
    return { key: process.env.FALLBACK_LLM_API_KEY, model: geminiModel(process.env.FALLBACK_LLM_MODEL), source: 'platform' };
  }
  return null;
}

// ── Why grounded search is off, when it is ───────────────────────────────────────────────────────
//
// A 429, a revoked key or a network wall each take grounded search away completely, and the caller
// then answers from Wikipedia — which cannot settle a current rate, deadline or permit rule. That
// degradation was invisible: `return null` with no log, so it looked exactly like a question that
// needed no search. Logged ONCE per process (a research turn would otherwise write the same line on
// every message), and exposed so a caller or an admin surface can say why.
let groundedUnavailableReason = null;

/** null when grounded search is working; otherwise why it was last found unavailable. */
export function groundedSearchUnavailableReason() {
  return groundedUnavailableReason;
}

function warnGroundedUnavailable(reason) {
  if (groundedUnavailableReason) return; // once per process is enough to diagnose it
  groundedUnavailableReason = reason;
  console.warn(
    `[webResearch] Gemini grounded search is UNAVAILABLE (${reason}) — research falls back to `
    + 'Wikipedia/arXiv, which cannot answer current or jurisdiction-specific facts. Logged once per process.',
  );
}

// Our own search is a scraped HTML endpoint with no contract, so it can go quiet in ways a real API
// cannot. Reported once per process, for the same reason as the grounded one: a search tier that has
// stopped answering looks exactly like a question with no results.
let ownSearchUnavailableReason = null;

/** null when our own search is answering; otherwise why it was last found unavailable. */
export function searchUnavailableReason() {
  return ownSearchUnavailableReason;
}

function warnSearchUnavailable(reason) {
  if (ownSearchUnavailableReason === reason) return;
  ownSearchUnavailableReason = reason;
  console.warn(`[webResearch] our own web search is unavailable (${reason}) — falling back to Wikipedia/arXiv. Logged once per distinct reason.`);
}

async function errorDetail(res) {
  try {
    const body = await res.json();
    const msg = body?.error?.message || body?.message;
    return msg ? ` — ${String(msg).slice(0, 160)}` : '';
  } catch { return ''; }
}

async function fetchWithTimeout(url, opts = {}) {
  return fetch(url, {
    ...opts,
    headers: { 'User-Agent': UA, ...(opts.headers || {}) },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

async function fetchJson(url, opts) {
  const res = await fetchWithTimeout(url, opts);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ── Tier 1: Gemini google_search grounding ───────────────────────────────
// { answer, sources: [{ title, url }] } or null. Newer Gemini models take
// `google_search`; older ones want `google_search_retrieval` — try both.
export async function geminiGroundedSearch(searchKey, query) {
  if (!searchKey?.key) {
    warnGroundedUnavailable('no Gemini key is configured for this deployment (FALLBACK_LLM_* or the account\'s own Gemini connection)');
    return null;
  }
  const endpoint = `https://${GEMINI_HOST}/v1beta/models/${encodeURIComponent(searchKey.model)}:generateContent?key=${searchKey.key}`;
  for (const tool of [{ google_search: {} }, { google_search_retrieval: {} }]) {
    try {
      const res = await fetchWithTimeout(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: query }] }], tools: [tool] }),
      });
      if (res.status === 400) continue; // wrong tool name for this model
      if (!res.ok) {
        // ⚠️ NOT SILENT (2026-10-04). This used to `return null` and say nothing, so the caller fell
        // back to Wikipedia with no way for anyone to tell that grounded search was off. Measured in
        // production: the fallback Gemini key is configured and healthy — a PLAIN call returns 200 —
        // while every GROUNDED call returns 429 "You exceeded your current quota", which is why
        // Jarvis reported Wikipedia-shaped results for "best stocks" and could not pull up current
        // permit rules. A silent 429 looks exactly like a question that needed no search.
        warnGroundedUnavailable(`HTTP ${res.status}${await errorDetail(res)}`);
        return null;
      }
      const d = await res.json();
      const cand = d?.candidates?.[0];
      const answer = (cand?.content?.parts || []).map((p) => p.text || '').join('').trim();
      const sources = (cand?.groundingMetadata?.groundingChunks || [])
        .map((c) => c.web).filter(Boolean)
        .map((w) => ({ title: (w.title || w.uri || '').trim(), url: w.uri }))
        .filter((s) => s.url);
      if (!answer && sources.length === 0) return null;
      return { answer, sources };
    } catch { return null; }
  }
  return null;
}

// Gemini vision → structured JSON. `images` is one { data: base64, mimeType }
// or an array of them. Uses the same resolveSearchKey() Gemini credential as
// grounded search. Returns the parsed object, or throws.
export async function geminiVisionJson(searchKey, prompt, images) {
  if (!searchKey?.key) throw Object.assign(new Error('No Gemini key available for photo analysis.'), { status: 400 });
  const list = (Array.isArray(images) ? images : [images]).filter((i) => i && i.data).slice(0, 6);
  const endpoint = `https://${GEMINI_HOST}/v1beta/models/${encodeURIComponent(searchKey.model)}:generateContent?key=${searchKey.key}`;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(60_000),
    body: JSON.stringify({
      contents: [{
        role: 'user',
        parts: [
          { text: prompt },
          ...list.map((im) => ({ inline_data: { mime_type: im.mimeType || 'image/jpeg', data: im.data } })),
        ],
      }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0.3 },
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Gemini vision call failed (HTTP ${res.status})${body ? ': ' + body.slice(0, 300) : ''}`);
  }
  const d = await res.json();
  const text = (d?.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();
  if (!text) throw new Error('Gemini returned an empty response.');
  try { return JSON.parse(text); }
  catch { throw new Error('Gemini did not return valid JSON.'); }
}

// ── Tier 2: Wikipedia ────────────────────────────────────────────────────
export async function wikipediaSearch(query, { max = 2 } = {}) {
  try {
    const s = await fetchJson(
      `https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&origin=*&srlimit=${max}&srsearch=${encodeURIComponent(query)}`,
    );
    const hits = s?.query?.search || [];
    const out = [];
    for (const h of hits.slice(0, max)) {
      try {
        const title = String(h.title || '').replace(/ /g, '_');
        const sum = await fetchJson(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`);
        out.push({
          title: `Wikipedia — ${sum.title || h.title}`,
          url: sum?.content_urls?.desktop?.page || `https://en.wikipedia.org/wiki/${encodeURIComponent(title)}`,
          content: String(sum.extract || stripTags(h.snippet || '')).slice(0, 1200),
        });
      } catch { /* skip this hit */ }
    }
    return out;
  } catch {
    return [];
  }
}

// ── Tier 3: arXiv ────────────────────────────────────────────────────────
export async function arxivSearch(query, { max = 2 } = {}) {
  try {
    const res = await fetchWithTimeout(
      `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&start=0&max_results=${max}`,
    );
    if (!res.ok) return [];
    const xml = await res.text();
    return xml.split('<entry>').slice(1, max + 1).map((e) => {
      const pick = (t) => (e.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`)) || [])[1]?.replace(/\s+/g, ' ').trim() || '';
      return { title: `arXiv — ${pick('title')}`, url: pick('id'), content: pick('summary').slice(0, 1200) };
    }).filter((r) => r.url);
  } catch {
    return [];
  }
}

// ── Tier 4: llms.txt ─────────────────────────────────────────────────────
// { url, content } or null. `input` may be a full URL or a bare host.
export async function fetchLlmsTxt(input) {
  let origin;
  try {
    origin = new URL(/:\/\//.test(input) ? input : `https://${input}`).origin;
  } catch {
    return null;
  }
  for (const path of ['/llms.txt', '/llms-full.txt']) {
    try {
      const res = await fetchWithTimeout(origin + path);
      if (!res.ok) continue;
      const text = (await res.text()).trim();
      if (text && !/^<(!doctype|html)/i.test(text)) return { url: origin + path, content: text.slice(0, 8000) };
    } catch { /* try the next path */ }
  }
  return null;
}

// ── Tier 5: direct page fetch ────────────────────────────────────────────
// { url, title, content } — the readable text of one page.
export async function webFetch(url, { maxChars = 6000 } = {}) {
  const res = await fetchWithTimeout(url, { headers: { Accept: 'text/html,text/plain,*/*' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const raw = await res.text();
  const isHtml = /html/i.test(res.headers.get('content-type') || '') || /^\s*<(!doctype|html)/i.test(raw);
  const text = isHtml ? htmlToText(raw) : raw;
  return {
    url,
    title: (raw.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1]?.trim() || url,
    content: text.replace(/\n{3,}/g, '\n\n').trim().slice(0, maxChars),
  };
}

function stripTags(s) {
  return String(s).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

function htmlToText(html) {
  return html
    .replace(/<(script|style|noscript|nav|header|footer|svg|form|iframe)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const ACADEMIC_RE = /\b(paper|papers|study|studies|arxiv|preprint|benchmark|dataset|state[- ]of[- ]the[- ]art|architecture|algorithm)\b/i;

// Orchestrator used by the pipeline. `searchKey` is the object from
// resolveSearchKey() (or null). Returns the shape researchWeb() expects:
// { answer, results: [{ title, url, content }] }.
export async function webSearch(searchKey, query, { maxResults = 4 } = {}) {
  const results = [];
  let answer = '';

  const grounded = await geminiGroundedSearch(searchKey, query);
  if (grounded) {
    answer = grounded.answer;
    for (const s of grounded.sources.slice(0, maxResults)) {
      results.push({ title: s.title || s.url, url: s.url, content: '' });
    }
  }

  // OUR OWN SEARCH (2026-10-04). Every hosted grounding option is closed to this account, and this is
  // what replaced them: a real, keyless web search, measured against the two questions Jarvis had
  // failed on — it put revenue.nsw.gov.au and environment.nsw.gov.au first for both. It runs BEFORE
  // Wikipedia because it can answer a current, jurisdiction-specific question and Wikipedia cannot.
  results.push(...await duckduckgoSearch(query, { maxResults }));

  results.push(...await wikipediaSearch(query, { max: 2 }));
  if (ACADEMIC_RE.test(query)) results.push(...await arxivSearch(query, { max: 2 }));

  const seen = new Set();
  const deduped = results.filter((r) => r.url && !seen.has(r.url) && seen.add(r.url));
  return { answer, results: deduped.slice(0, maxResults + 2) };
}

// ── Our own search: DuckDuckGo's HTML endpoint ────────────────────────────────────────────────────
//
// NOT an official API. It is a public HTML page that this parses, with no key, no quota and no
// contract — which is the whole reason it is here, and also its main risk: it can rate-limit, change
// shape, or stop answering. Three things keep that honest:
//
//   · the results are RANKED AND FILTERED in `lib/searchResults.js`, because the raw list carries ads
//     (measured: the top two for "2008 RAV4 idle squeal cause" were `y.js?ad_domain=` adverts) and
//     several pages from one host;
//   · a short TTL CACHE means asking the same thing twice in a session does not ask twice;
//   · it is ONE tier among several, and a failure returns `[]` rather than throwing — the caller keeps
//     Wikipedia, and the reply says plainly that it could not check if nothing comes back.
const SEARCH_CACHE_TTL_MS = 15 * 60 * 1000;
const SEARCH_CACHE_MAX = 100;
const searchCache = new Map();

/** Testing seam, and a way for a long-lived process to drop its cache. */
export function clearSearchCache() {
  searchCache.clear();
}

function readSearchCache(key, nowMs = Date.now()) {
  const entry = searchCache.get(key);
  if (!entry) return null;
  if (!isCacheFresh(entry, nowMs, SEARCH_CACHE_TTL_MS)) { searchCache.delete(key); return null; }
  return entry.results;
}

function writeSearchCache(key, results, nowMs = Date.now()) {
  // Oldest-out, so a long-lived process cannot grow the map without bound.
  if (searchCache.size >= SEARCH_CACHE_MAX) {
    const oldest = searchCache.keys().next().value;
    if (oldest !== undefined) searchCache.delete(oldest);
  }
  searchCache.set(key, { at: nowMs, results });
}


/**
 * Search the web with no key and no quota.
 *
 * @param {string} query
 * @param {{maxResults?: number, fetchImpl?: Function}} [options]
 * @returns {Promise<Array<{title: string, url: string, snippet: string, content: string}>>}
 */
export async function duckduckgoSearch(query, { maxResults = 4, fetchImpl = fetch } = {}) {
  const q = String(query || '').trim();
  if (!q) return [];
  const cacheKey = searchCacheKey(q);
  const cached = readSearchCache(cacheKey);
  if (cached) return cached.slice(0, maxResults);

  try {
    const res = await fetchImpl(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`, {
      headers: { 'User-Agent': UA, Accept: 'text/html' },
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      warnSearchUnavailable(`HTTP ${res.status}`);
      return [];
    }
    const ranked = rankResults(parseDuckDuckGoResults(await res.text()), { max: maxResults });
    const results = ranked.map((r) => ({ title: r.title || r.url, url: r.url, snippet: r.snippet || '', content: r.snippet || '' }));
    if (results.length) writeSearchCache(cacheKey, results);
    return results;
  } catch (err) {
    warnSearchUnavailable(err?.name === 'TimeoutError' ? 'timed out' : (err?.message || 'failed'));
    return [];
  }
}
