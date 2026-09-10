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

const GEMINI_HOST = 'generativelanguage.googleapis.com';
const TIMEOUT_MS = 20_000;
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
  if (!searchKey?.key) return null;
  const endpoint = `https://${GEMINI_HOST}/v1beta/models/${encodeURIComponent(searchKey.model)}:generateContent?key=${searchKey.key}`;
  for (const tool of [{ google_search: {} }, { google_search_retrieval: {} }]) {
    try {
      const res = await fetchWithTimeout(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: query }] }], tools: [tool] }),
      });
      if (res.status === 400) continue; // wrong tool name for this model
      if (!res.ok) return null;
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

// Gemini vision → structured JSON. `image` is { data: base64, mimeType }.
// Uses the same resolveSearchKey() Gemini credential as grounded search.
// Returns the parsed object, or throws.
export async function geminiVisionJson(searchKey, prompt, image) {
  if (!searchKey?.key) throw Object.assign(new Error('No Gemini key available for photo analysis.'), { status: 400 });
  const endpoint = `https://${GEMINI_HOST}/v1beta/models/${encodeURIComponent(searchKey.model)}:generateContent?key=${searchKey.key}`;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(45_000),
    body: JSON.stringify({
      contents: [{
        role: 'user',
        parts: [
          { text: prompt },
          { inline_data: { mime_type: image.mimeType || 'image/jpeg', data: image.data } },
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

  results.push(...await wikipediaSearch(query, { max: 2 }));
  if (ACADEMIC_RE.test(query)) results.push(...await arxivSearch(query, { max: 2 }));

  const seen = new Set();
  const deduped = results.filter((r) => r.url && !seen.has(r.url) && seen.add(r.url));
  return { answer, results: deduped.slice(0, maxResults + 2) };
}
