// Keyword research for one page: what people actually type, what the pages
// competing with it target, and what the page itself says — merged into one
// list where every phrase shows its source.
//
// WHAT THIS DELIBERATELY DOES NOT DO: produce a search volume, a difficulty
// score, a CPC, or a ranking. Those need a paid index; a model asked for them
// invents them, and an invented number is worse than no number because it gets
// acted on. See server/src/lib/keywordResearch.js, whose response shape has no
// field for one.
import { prisma } from '../db.js';
import { invokeAI } from '../ai.js';
import { getWpConnection, wpSeo } from '../lib/wpPlugin.js';
import { getDeckBusinessContext } from '../lib/deckBusinessProfile.js';
import {
  parseSuggest, extractPageSignals, mergeCandidates, researchDisclosure, normalizePhrase, contentWords,
  MAX_SEEDS, MAX_COMPETITORS, MAX_COMPETITOR_BYTES,
} from '../lib/keywordResearch.js';

const SUGGEST_URL = 'https://suggestqueries.google.com/complete/search';
const FETCH_TIMEOUT_MS = 12000;

/** Google autocomplete — real typed phrases, no key, no scraping of results. */
async function suggest(term, { hl = 'en', gl = 'au' } = {}) {
  const url = `${SUGGEST_URL}?client=firefox&hl=${encodeURIComponent(hl)}&gl=${encodeURIComponent(gl)}&q=${encodeURIComponent(term)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Morpheus/1.0)', Accept: 'application/json, text/javascript' },
    });
    if (!res.ok) return [];
    return parseSuggest(await res.text());
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One competitor page, as it describes itself. Size-capped and never trusted:
 * this is someone else's HTML.
 */
async function fetchCompetitor(rawUrl) {
  let url = String(rawUrl || '').trim();
  if (!url) return null;
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { url, error: 'not a usable address' };
  }
  if (!/^https?:$/.test(parsed.protocol)) return { url, error: 'not an http address' };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(parsed.toString(), {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Morpheus/1.0)', Accept: 'text/html' },
    });
    if (!res.ok) return { url, error: `HTTP ${res.status}` };
    const type = res.headers.get('content-type') || '';
    if (!/text\/html|application\/xhtml/i.test(type)) return { url, error: `not a web page (${type || 'unknown type'})` };
    const text = (await res.text()).slice(0, MAX_COMPETITOR_BYTES);
    return extractPageSignals(text, parsed.toString());
  } catch (err) {
    return { url, error: err.name === 'AbortError' ? 'took too long to answer' : (err.message || 'could not be read') };
  } finally {
    clearTimeout(timer);
  }
}

/** A handful of extra seed phrases from the page and the business. */
async function proposeSeeds({ userId, business, page, competitors }) {
  const lines = [
    business ? `BUSINESS: ${business}` : null,
    page.title ? `PAGE: ${page.title}` : null,
    page.focus_keyword ? `CURRENT TARGET: ${page.focus_keyword}` : null,
    page.text ? `PAGE TEXT (excerpt): ${String(page.text).slice(0, 800)}` : null,
    competitors.filter((c) => c && !c.error).length
      ? `COMPETING PAGES TARGET: ${competitors.filter((c) => c && !c.error).map((c) => c.title).filter(Boolean).join(' | ')}`
      : null,
  ].filter(Boolean);

  try {
    const { result } = await invokeAI({
      userId, // billed like every other AI call this account makes
      role: 'diagnosis',
      maxTokens: 400,
      prompt: `${lines.join('\n')}

List the phrases a person would type into Google to find this page. Short phrases, the way people actually search — not sentences, not questions about the business.

Rules:
- Do NOT suggest a phrase already given above.
- Do NOT invent specifics (place names, brands, prices) that are not in the text above.
- Between 4 and 10 phrases.

Return JSON: { "seeds": ["phrase", ...] }`,
      schema: { type: 'object', properties: { seeds: { type: 'array', items: { type: 'string' } } }, required: ['seeds'] },
    });
    return (Array.isArray(result?.seeds) ? result.seeds : []).map(normalizePhrase).filter(Boolean).slice(0, 10);
  } catch {
    // The model is a nice-to-have here: autocomplete and the competitors are
    // the real signals, so a failure to think of extra seeds must not fail the
    // research.
    return [];
  }
}

export default async function handler({ user, body }) {
  const projectId = body?.projectId;
  if (!projectId) throw Object.assign(new Error('projectId required'), { status: 400 });

  const project = await prisma.project.findFirst({
    where: { id: projectId, created_by_id: user.id },
    select: { name: true, description: true },
  });
  if (!project) throw Object.assign(new Error('Project not found'), { status: 404 });

  const competitorInputs = (Array.isArray(body?.competitors) ? body.competitors : [])
    .map((s) => String(s || '').trim())
    .filter(Boolean)
    .slice(0, MAX_COMPETITORS);

  // What page is this for? Either an item on the connected site (by id), or a
  // bare seed term if the operator is exploring before they have a page.
  const conn = await getWpConnection(projectId, user.id);
  let page = { title: '', focus_keyword: '', text: '' };
  if (conn && body?.id) {
    const read = await wpSeo(conn, 'read_content', { id: Number(body.id), chars: 1500 });
    if (read.ok && read.data?.ok && read.data.item) {
      page = { title: read.data.item.title || '', focus_keyword: '', text: read.data.item.content_text || '' };
    }
    const seo = await wpSeo(conn, 'get_seo', { id: Number(body.id) });
    if (seo.ok && seo.data?.ok && seo.data.item) {
      page.focus_keyword = seo.data.item.focus_keyword || '';
      page.title = page.title || seo.data.item.title || '';
    }
  }

  const manualSeed = normalizePhrase(body?.seed);
  if (manualSeed) page.focus_keyword = page.focus_keyword || manualSeed;

  // Competitor pages first: their headings are seeds too, and reading them
  // before asking for seeds means the extra seed ideas know what they target.
  const competitors = [];
  for (const url of competitorInputs) {
    // Sequential: three parallel fetches to three strangers' servers is a good
    // way to get rate-limited, and this runs while someone waits either way.
    // eslint-disable-next-line no-await-in-loop
    competitors.push(await fetchCompetitor(url));
  }

  const business = [await getDeckBusinessContext(user.id).catch(() => ''), project.description].filter(Boolean).join(' — ');

  // SEEDS COME FROM THE PAGE AND THE MODEL ONLY — never from a competitor's
  // headings. Scraped headings include site furniture ("Form name" from a
  // search field), and feeding those to Google's autocomplete produced
  // "form name meaning in hindi" as a keyword. The competitor's headings are
  // still used, as CANDIDATES, where a chrome filter applies.
  const seeds = [
    page.focus_keyword,
    page.title && contentWords(page.title).length <= 7 ? page.title : '',
    manualSeed,
  ]
    .map(normalizePhrase)
    .filter((s) => s && s.split(' ').length <= 6)
    .filter((s, i, all) => all.indexOf(s) === i);

  const modelSeeds = await proposeSeeds({ userId: user.id, business, page, competitors });
  const allSeeds = [...seeds, ...modelSeeds].filter((s, i, all) => all.indexOf(s) === i).slice(0, MAX_SEEDS);

  if (allSeeds.length === 0) {
    throw Object.assign(new Error('Nothing to research — give me a page, a seed phrase, or a competitor address.'), { status: 400 });
  }

  const suggests = {};
  for (const seed of allSeeds) {
    // eslint-disable-next-line no-await-in-loop
    const list = await suggest(seed);
    if (list.length) suggests[seed] = list.slice(0, 10);
  }

  const keywords = mergeCandidates({ seeds: allSeeds, suggests, competitors: competitors.filter((c) => c && !c.error), model: modelSeeds, page });

  return {
    keywords,
    seeds: allSeeds,
    competitors: competitors.map((c) => (c ? {
      url: c.url,
      error: c.error || null,
      title: c.title || '',
      description: c.description || '',
      headings: [...(c.h1 || []), ...(c.h2 || [])].slice(0, 6),
      phrases: (c.phrases || []).slice(0, 6),
      words: c.words || 0,
    } : null)).filter(Boolean),
    autocomplete_used: Object.keys(suggests).length > 0,
    count: keywords.length,
    disclosure: researchDisclosure({
      competitorCount: competitors.filter((c) => c && !c.error).length,
      autocompleteUsed: Object.keys(suggests).length > 0,
      modelUsed: modelSeeds.length > 0,
    }),
  };
}
