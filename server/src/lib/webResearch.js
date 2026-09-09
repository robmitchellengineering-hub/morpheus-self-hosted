// Web research for the build pipeline — search the web and read pages so the
// planner/coder can work against CURRENT external information (library/API
// versions, current best practices, an error message, a URL the operator
// pasted) that isn't in the project files.
//
// Backed by Tavily (https://tavily.com) — one API that does search + extract
// and returns clean text, so this stays small. Set TAVILY_API_KEY to enable;
// without it, chatWithMorpheus.js skips the web-research stage entirely.
// (A per-user key override — UserSettings, tiered like the AI gateway — is a
// natural follow-up but not built yet.)

const TAVILY = 'https://api.tavily.com';
const TIMEOUT_MS = 20_000;

export function webResearchConfigured() {
  return !!process.env.TAVILY_API_KEY;
}

export function searchKey() {
  return process.env.TAVILY_API_KEY || null;
}

async function tavily(path, body) {
  const res = await fetch(`${TAVILY}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Tavily ${path} ${res.status}: ${t.slice(0, 200)}`);
  }
  return res.json();
}

// { answer, results: [{ title, url, content }] }
export async function webSearch(apiKey, query, { maxResults = 4 } = {}) {
  const d = await tavily('/search', {
    api_key: apiKey,
    query,
    max_results: maxResults,
    search_depth: 'basic',
    include_answer: true,
  });
  return {
    answer: (d.answer || '').trim(),
    results: (d.results || []).map((r) => ({
      title: r.title || r.url,
      url: r.url,
      content: (r.content || '').replace(/\s+/g, ' ').trim().slice(0, 1200),
    })),
  };
}

// { url, title, content } — the readable text of one page
export async function webFetch(apiKey, url, { maxChars = 6000 } = {}) {
  const d = await tavily('/extract', { api_key: apiKey, urls: [url] });
  const r = (d.results || [])[0];
  if (!r) throw new Error(`Could not extract ${url}`);
  return {
    url,
    title: r.title || url,
    content: (r.raw_content || r.content || '').replace(/\n{3,}/g, '\n\n').trim().slice(0, maxChars),
  };
}

export const URL_RE = /\bhttps?:\/\/[^\s<>"')]+/gi;
