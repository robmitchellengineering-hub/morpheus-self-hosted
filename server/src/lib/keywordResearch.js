// Keyword research — the parsing and merging rules, with no network and no
// model in them.
//
// WHY THIS IS SPLIT OUT: the honesty of this feature is decided here, not in
// the prompt. There is exactly one hard rule — every keyword must carry the
// SIGNAL it came from, and there is no field in the output for a search volume,
// a difficulty score, a CPC or a ranking, because those numbers are not
// obtainable for free and a model will invent them convincingly. A response
// shape with nowhere to put an invented number cannot show one.
//
// The three real signals:
//   * autocomplete — what people actually type into Google. Free, no key, and
//     real: Google returns its own suggestion list.
//   * competitor  — what a page that competes with this one actually targets:
//     its title, meta description and headings, read from its own HTML.
//   * page        — the page's own title and its current focus keyword.
// A fourth, `model`, exists for phrases an LLM proposes, and is labelled as
// such so nobody mistakes it for measured demand.

// Site chrome, not content. A competitor's navigation and forms are full of
// phrases that are not what the page is about — the live run of this feature
// turned a search field's "Form name" label into a keyword AND an autocomplete
// seed, which then produced "form name meaning in hindi" from Google. Filtering
// them here keeps both the keyword list and the seed set honest.
const CHROME_PHRASES = new Set([
  'about', 'about us', 'contact', 'contact us', 'home', 'shop', 'store', 'cart', 'checkout', 'basket',
  'search', 'form name', 'your name', 'email address', 'your email', 'password', 'login', 'log in',
  'sign in', 'sign up', 'register', 'my account', 'account', 'wishlist', 'compare', 'menu', 'main menu',
  'blog', 'news', 'faq', 'faqs', 'help', 'support', 'shipping', 'delivery', 'returns', 'refunds',
  'terms', 'terms and conditions', 'privacy', 'privacy policy', 'cookie policy', 'subscribe',
  'newsletter', 'follow us', 'social', 'share', 'reviews', 'testimonials', 'gallery', 'categories',
  'brands', 'sale', 'clearance', 'gift cards', 'store locator', 'opening hours', 'open hours',
  'read more', 'learn more', 'view all', 'shop now', 'add to cart', 'buy now', 'next', 'previous',
  'added to cart', 'added to your cart', 'item added to your cart', 'your cart', 'items in cart',
  'skip to content', 'back to top', 'all rights reserved', 'copyright', 'site map', 'sitemap',
]);

// Nav terms that stay chrome even with something after them ("About Billy Hyde
// Music" is still the About page). Kept separate from the full list because a
// genuinely useful query can begin with an ambiguous word — "shop guitar
// repairs" is a real thing people type, while "shop now" is a button.
const CHROME_PREFIXES = new Set([
  'about', 'contact', 'home', 'cart', 'checkout', 'search', 'login', 'log in', 'sign in', 'sign up',
  'my account', 'wishlist', 'blog', 'news', 'faq', 'help', 'support', 'shipping', 'delivery',
  'returns', 'refunds', 'terms', 'privacy', 'subscribe', 'newsletter', 'follow us', 'back to top',
  'skip to content', 'all rights reserved', 'read more', 'learn more', 'view all', 'add to cart',
  'buy now', 'gift cards', 'store locator', 'opening hours',
]);

/**
 * Is this phrase site furniture rather than content?
 *
 * Three ways, because one was not enough against a real shop: exact match, a
 * nav term followed by more words, and — the case that let "00 add to cart"
 * through — a multi-word chrome phrase appearing anywhere inside it, usually
 * because a price or quantity got glued to the front by the scraper.
 */
export function isChrome(phrase) {
  const p = normalizePhrase(phrase);
  if (!p) return true;
  if (CHROME_PHRASES.has(p)) return true;
  const words = p.split(' ');
  if (words.length > 5) return false; // a long phrase is content, not furniture
  for (const prefix of CHROME_PREFIXES) {
    if (p === prefix || p.startsWith(prefix + ' ')) return true;
  }
  for (const chrome of CHROME_PHRASES) {
    if (!chrome.includes(' ')) continue;
    if (p.startsWith(chrome + ' ') || p.endsWith(' ' + chrome) || p.includes(' ' + chrome + ' ')) return true;
  }
  return false;
}

/**
 * The part of a page title that says what the page is about.
 *
 * Titles usually carry a brand suffix ("Acoustic guitar - Wikipedia",
 * "Guitar Repairs Melbourne | Best Guitar Setup"). The suffix is not something
 * anyone types and not what the page targets, so it is stripped for the
 * keyword signal — the full title is still reported in the competitor panel.
 */
export function titleCore(title) {
  const t = String(title || '').trim();
  if (!t) return '';
  const parts = t.split(/\s+[|·—–-]\s+/).map((x) => x.trim()).filter(Boolean);
  if (parts.length <= 1) return t;
  // Keep the longest segment: brand suffixes are usually the shorter part.
  return parts.slice().sort((a, b) => b.length - a.length)[0];
}

// How long a scraped title or heading may be and still count as something a
// person would search for. Found by a real run: a six-word marketing slogan
// passed the first gate and sat in the list looking like a keyword.
export const TITLE_MAX_WORDS = 5;
export const HEADING_MAX_WORDS = 6;

export const MAX_SEEDS = 6;
export const MAX_COMPETITORS = 3;
export const MAX_KEYWORDS = 60;
export const MAX_COMPETITOR_BYTES = 400000;

// Words that carry no keyword value on their own. Kept short and obvious —
// this trims n-grams, it is not a linguistics project.
const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'can', 'do', 'for', 'from', 'get', 'had',
  'has', 'have', 'how', 'i', 'if', 'in', 'is', 'it', 'its', 'just', 'me', 'more', 'my', 'no', 'not',
  'of', 'on', 'or', 'our', 'out', 'so', 'that', 'the', 'their', 'them', 'then', 'there', 'these',
  'they', 'this', 'to', 'up', 'us', 'was', 'we', 'were', 'what', 'when', 'where', 'which', 'who',
  'why', 'will', 'with', 'you', 'your',
]);

/** Normalise a phrase for dedupe and display. */
export function normalizePhrase(raw) {
  return String(raw ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s'-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Words that count towards a phrase being "real" (not just stopwords). */
export function contentWords(phrase) {
  return normalizePhrase(phrase).split(' ').filter((w) => w && !STOPWORDS.has(w));
}

/**
 * Google's autocomplete payload.
 *
 * Two shapes in the wild: the classic `["query", ["a","b"]]` and an
 * XML-ish response if the client parameter is ignored. Anything unexpected
 * yields no suggestions rather than an exception — this runs against a
 * third-party endpoint in a user-facing request.
 */
export function parseSuggest(payload) {
  let data = payload;
  if (typeof payload === 'string') {
    try {
      data = JSON.parse(payload);
    } catch {
      // Some endpoints answer with <suggestion data="..."/> elements.
      const found = [...String(payload).matchAll(/data="([^"]+)"/g)].map((m) => m[1]);
      return found.map((s) => String(s).trim()).filter(Boolean);
    }
  }
  if (Array.isArray(data) && Array.isArray(data[1])) {
    return data[1].map((s) => String(s).trim()).filter(Boolean);
  }
  if (data && Array.isArray(data.suggestions)) {
    return data.suggestions.map((s) => String(s).trim()).filter(Boolean);
  }
  return [];
}

/** Strip tags and decode the handful of entities that matter, for reading a page. */
export function visibleText(html) {
  return String(html ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#0?39;|&apos;|&rsquo;/gi, "'")
    .replace(/&quot;|&ldquo;|&rdquo;/gi, '"')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function tagText(html, tag) {
  const out = [];
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'gi');
  for (const m of String(html).matchAll(re)) {
    const t = visibleText(m[1]);
    if (t) out.push(t);
  }
  return out;
}

function metaContent(html, name) {
  const re = new RegExp(`<meta[^>]+name=["']${name}["'][^>]*content=["']([^"']*)["']`, 'i');
  const alt = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*name=["']${name}["']`, 'i');
  const m = String(html).match(re) || String(html).match(alt);
  return m ? m[1].trim() : '';
}

/** The most repeated 2–4 word phrases in a block of text. */
export function repeatedPhrases(text, limit = 12) {
  const words = normalizePhrase(text).split(' ').filter(Boolean);
  const counts = new Map();
  for (let n = 2; n <= 4; n++) {
    for (let i = 0; i + n <= words.length; i++) {
      const gram = words.slice(i, i + n);
      // A phrase made only of stopwords ("of the and") is noise.
      if (gram.filter((w) => !STOPWORDS.has(w)).length === 0) continue;
      // Skip phrases that start or end on a stopword: "the guitar" is weaker
      // than "guitar repairs" and produces a lot of near-duplicates.
      if (STOPWORDS.has(gram[0]) || STOPWORDS.has(gram[gram.length - 1])) continue;
      const key = gram.join(' ');
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .filter(([, n]) => n > 1)
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .slice(0, limit)
    .map(([phrase, count]) => ({ phrase, count }));
}

/**
 * What a competing page targets, read from its own HTML.
 *
 * Only things a page states about itself — never an inference about its
 * traffic or its rankings, which we cannot see.
 */
export function extractPageSignals(html, url = '') {
  const title = visibleText((String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [, ''])[1]);
  const description = metaContent(html, 'description');
  const h1 = tagText(html, 'h1').slice(0, 3);
  const h2 = tagText(html, 'h2').slice(0, 8);
  const h3 = tagText(html, 'h3').slice(0, 6);
  const body = visibleText(html);
  return {
    url,
    title,
    description,
    h1,
    h2,
    h3,
    phrases: repeatedPhrases(body, 10),
    words: body ? body.split(' ').length : 0,
  };
}

/**
 * Merge every signal into one de-duplicated list, each phrase carrying where it
 * came from and how many independent sources produced it.
 *
 * `sources` is the whole point: "guitar repairs melbourne" appearing in Google's
 * autocomplete AND in two competitors' headings is a far better signal than the
 * same phrase typed by a model, and the operator can see which is which.
 */
export function mergeCandidates({ seeds = [], suggests = {}, competitors = [], model = [], page = {} } = {}) {
  const byPhrase = new Map();

  const add = (phrase, source, detail = '') => {
    const key = normalizePhrase(phrase);
    if (!key) return;
    const words = contentWords(key);
    if (words.length === 0) return;
    // A seed the operator typed, or their own page's keyword, is always kept —
    // filtering those would silently discard what they asked about. Everything
    // scraped from someone else's page has to earn its place.
    if (source !== 'seed' && source !== 'page-keyword' && isChrome(key)) return;
    if (!byPhrase.has(key)) {
      byPhrase.set(key, { phrase: key, display: String(phrase).trim(), sources: [], details: [], seed: '' });
    }
    const row = byPhrase.get(key);
    if (!row.sources.includes(source)) row.sources.push(source);
    if (detail && !row.details.includes(detail)) row.details.push(detail);
  };

  for (const seed of seeds) add(seed, 'seed');

  for (const [seed, list] of Object.entries(suggests)) {
    for (const s of list) {
      add(s, 'autocomplete', seed);
    }
  }

  for (const c of competitors) {
    // A title is a candidate only if someone could plausibly TYPE it. A long
    // title ("Guitar Repairs Melbourne | Valiant Music | Est. 1998") is not a
    // keyword, and adding it as one just fills the list with sentences — it is
    // still shown in the competitor panel, where reading it is the point.
    const core = titleCore(c.title);
    // A title is a candidate only if someone could plausibly TYPE it: short,
    // and not a marketing line. "Melbourne, Perth & Adelaide's largest & best
    // Music" is a slogan with an ampersand in it, not a query.
    if (core && contentWords(core).length <= TITLE_MAX_WORDS && !/[&!]/.test(core)) add(core, 'competitor-title', c.url);
    for (const h of [...(c.h1 || []), ...(c.h2 || []).slice(0, 4)]) {
      if (contentWords(h).length <= HEADING_MAX_WORDS) add(h, 'competitor-heading', c.url);
    }
    for (const p of (c.phrases || []).slice(0, 4)) add(p.phrase, 'competitor-phrase', c.url);
    // Descriptions are deliberately NOT candidates: nobody searches a meta
    // description. They appear in the competitor panel instead.
  }

  if (page.title) add(page.title, 'page-title');
  if (page.focus_keyword) add(page.focus_keyword, 'page-keyword');
  for (const m of model) add(m, 'model');

  const rows = [...byPhrase.values()].map((r) => ({
    ...r,
    // Longer phrases generated FROM a shorter one are usually the more
    // specific target; both are useful, so order by how many independent
    // sources agree, then by specificity.
    weight: r.sources.length * 10 + contentWords(r.phrase).length,
  }));

  rows.sort((a, b) => b.weight - a.weight || a.phrase.localeCompare(b.phrase));
  return rows.slice(0, MAX_KEYWORDS);
}

/**
 * The disclosure the UI shows next to every result set. Kept in the module so
 * the wording cannot drift away from what the data actually is.
 */
export function researchDisclosure({ competitorCount = 0, autocompleteUsed = false, modelUsed = false } = {}) {
  const parts = [];
  if (autocompleteUsed) parts.push('what people actually type into Google (its autocomplete)');
  if (competitorCount > 0) parts.push(`what ${competitorCount} competing page${competitorCount === 1 ? '' : 's'} say about themselves (title, description and headings)`);
  if (modelUsed) parts.push('phrases an AI suggested (the weakest signal here, and labelled as such on each row)');
  return `Signals used: ${parts.join('; ')}. There are deliberately no search volumes, difficulty scores or rankings here — those come from paid indexes, and a model asked for them will invent them.`;
}
