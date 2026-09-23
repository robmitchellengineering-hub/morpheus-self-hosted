// Prompt construction and response normalisation for AI-written SEO.
//
// WHY THIS IS A SEPARATE, PURE MODULE
//
// Two reasons, both learned the hard way in this repo:
//
//   1. The guards job installs nothing (see .github/workflows/ci.yml). The
//      rules that decide what is allowed to reach a LIVE SITE — length limits,
//      "never invent a fact", the field names the WordPress plugin accepts —
//      have to be testable without a database or a model call. So the prompt
//      builder and the response normaliser import nothing at all.
//   2. The model is not a trusted input. Everything it returns is normalised
//      and bounded here, in one place, before any handler is allowed to send
//      it to the plugin.
//
// The plugin is still the authority on what it will store (Morpheus_SEO::
// set_fields sanitises and wp_kses_post runs on post content). This module's
// job is to make sure what we SEND is honest, on-length, and free of the
// obvious script-injection shapes — and to tell the operator when the model
// broke a guideline rather than silently trimming its words to fit.

// The plugin's own guidance (includes/seo/class-seo.php) — kept numerically in
// step with it, since both sides report the same limits to the same UI.
export const TITLE_MIN = 15;
export const TITLE_MAX = 60;
export const DESC_MIN = 70;
export const DESC_MAX = 160;

// Hard ceilings, deliberately well above the guidelines. A guideline breach is
// reported as a warning so the operator can shorten it themselves; only
// something absurd gets cut, and then it is cut on the cap, not "helpfully"
// mid-word to exactly 60.
export const TITLE_HARD_MAX = 120;
export const DESC_HARD_MAX = 220;
export const MAX_EXCERPT = 320;

// The exact input field names Morpheus_SEO::set_fields() accepts. Renaming one
// of these on either side is a silent no-op at runtime (the plugin simply sees
// an unknown key and ignores it), so scripts/verify-seo.mjs asserts this list
// against the PHP source.
export const SEO_INPUT_KEYS = ['seo_title', 'seo_description', 'focus_keyword', 'canonical', 'og_image', 'noindex'];

// What a generation pass is allowed to propose. Canonical / og_image / noindex
// are structural decisions for the operator, not something to invent.
export const SEO_SUGGESTION_KEYS = ['seo_title', 'seo_description', 'focus_keyword'];

// The most items one *request* may ask for. 25 items with 1500 chars of
// grounding each is already a large prompt; beyond that the model starts
// dropping items, which looks like a generation failure to the operator.
//
// This is not "one model call" — a request is split into several calls by
// chunkSeoItems() below, because the model's hidden reasoning shares the output
// budget with the JSON it returns (see seoCallMaxTokens).
export const MAX_BATCH = 25;
export const MAX_GROUNDING_CHARS = 1500;
export const MAX_INTERNAL_LINKS = 40;

// ── one call's output budget, hidden reasoning included ─────────────────────
//
// The deployed model spends real budget on hidden reasoning BEFORE it emits any
// visible text (build library: ai-features → "a truncated call reads as a
// negative answer"). A cap sized only from the JSON that must come back is
// therefore not a cap on the JSON at all: the reasoning eats it first, the call
// returns finish_reason 'length' with an incomplete object, and ai.js turns that
// into OUTPUT_TRUNCATED — which the SEO panel then shows as a token-limit error.
//
// That is what broke "generate for every published item missing metadata":
// 900 + 25*260 = 7400 tokens had to cover the reasoning AND 25 items of JSON,
// and a single item got only 1160.
//
// So every call pays a reasoning floor first, and items are split into calls
// small enough that one verbose page cannot spend another page's share.
export const SEO_TOKENS_PER_ITEM = 400;
export const SEO_REASONING_FLOOR = 6000;
export const SEO_MIN_CALL_TOKENS = 8000;
export const SEO_MAX_CALL_TOKENS = 32000;
export const SEO_ITEMS_PER_CALL = 5;

/**
 * Output cap for one model call covering `itemCount` items.
 *
 * Monotonic in itemCount and never below SEO_MIN_CALL_TOKENS, so the floor that
 * pays for hidden reasoning cannot be squeezed out by a small batch.
 */
export function seoCallMaxTokens(itemCount) {
  const n = Math.max(1, Math.trunc(Number(itemCount) || 1));
  const wanted = SEO_REASONING_FLOOR + n * SEO_TOKENS_PER_ITEM;
  return Math.min(SEO_MAX_CALL_TOKENS, Math.max(SEO_MIN_CALL_TOKENS, wanted));
}

/**
 * Split items into calls of at most `size`, preserving order.
 *
 * A partition, not a filter: every item lands in exactly one chunk, so a batch
 * cannot be split and silently lose items.
 */
export function chunkSeoItems(items, size = SEO_ITEMS_PER_CALL) {
  const list = Array.isArray(items) ? items : [];
  const per = Math.max(1, Math.trunc(size) || SEO_ITEMS_PER_CALL);
  const out = [];
  for (let i = 0; i < list.length; i += per) out.push(list.slice(i, i + per));
  return out;
}

/**
 * Merge the suggestion lists from several calls, first entry per id wins.
 *
 * Chunking means one response per call but the operator reviews one batch, so
 * responses are stitched back into a single list before normalising. `coerceId`
 * is the same guard the normaliser uses — an id the model invented is dropped
 * rather than trusted (a hallucinated id would write SEO to someone else's page).
 */
export function mergeSeoSuggestions(lists) {
  // Accepts either the per-call lists ([[...], [...]]) or one already-flat list,
  // so a caller stitching a single response cannot silently merge nothing.
  const flat = [];
  for (const entry of Array.isArray(lists) ? lists : []) {
    if (Array.isArray(entry)) flat.push(...entry);
    else if (entry && typeof entry === 'object') flat.push(entry);
  }
  const byId = new Map();
  for (const s of flat) {
    const id = coerceId(s?.id);
    if (id == null || byId.has(id)) continue;
    byId.set(id, s);
  }
  return [...byId.values()];
}

/**
 * Ask for items in bounded chunks, halving any chunk that comes back truncated.
 *
 * `ask(chunk)` performs one model call and returns that call's raw suggestion
 * list; it must throw an error whose message contains OUTPUT_TRUNCATED when the
 * response was cut off. A chunk that truncates is split in half and retried, so
 * one verbose page costs one extra call instead of the whole batch — which is
 * exactly how the 25-item batch used to fail. A single item with nothing left to
 * split is handed to `onGiveUp` (default: rethrow), so the caller can name the
 * item instead of surfacing ai.js's "files per step" advice.
 *
 * Pure apart from `ask`: no model, no site, so scripts/verify-seo.mjs can drive
 * every branch with a fake asker.
 */
/**
 * The AI role the SEO batch calls under — its own slot so lib/timingStats.js
 * averages SEO calls against SEO calls.
 *
 * It used to pass `diagnosis`, which four much smaller callers also use, so the
 * ETA was an average of other people's work. The name lives here rather than at
 * the call site because the guard has to assert it is the same value that is
 * seeded in timingStats and sized in billing; a second spelling of "seo" in
 * another file is exactly how those three drift apart.
 */
export const SEO_AI_ROLE = 'seo';

export async function generateSeoInChunks(items, ask, options = {}) {
  const { size = SEO_ITEMS_PER_CALL, onGiveUp } = options;
  const out = [];
  const run = async (chunk) => {
    try {
      const list = await ask(chunk);
      out.push(...(Array.isArray(list) ? list : []));
    } catch (e) {
      const truncated = /OUTPUT_TRUNCATED/.test(String(e?.message || ''));
      if (!truncated) throw e; // a real failure is not made smaller by splitting
      if (chunk.length === 1) throw onGiveUp ? onGiveUp(chunk[0], e) : e;
      const mid = Math.ceil(chunk.length / 2);
      // Sequential: a burst at a shared provider is a good way to get rate-limited.
      // eslint-disable-next-line no-await-in-loop
      await run(chunk.slice(0, mid));
      // eslint-disable-next-line no-await-in-loop
      await run(chunk.slice(mid));
    }
  };
  for (const chunk of chunkSeoItems(items, size)) await run(chunk);
  return out;
}

// ── small helpers ───────────────────────────────────────────────────────────

/** One line, no newlines, trimmed, hard-capped. */
export function oneLine(value, max = TITLE_HARD_MAX) {
  if (value == null) return '';
  const s = String(value).replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max).trim() : s;
}

/** Trimmed whitespace-collapsed text, hard-capped. */
export function blockText(value, max = DESC_HARD_MAX) {
  if (value == null) return '';
  const s = String(value).replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return s.length > max ? s.slice(0, max).trim() : s;
}

/**
 * Strip the shapes that must never reach a stored post from model-authored
 * HTML: script/style/iframe blocks (with their contents), inline event
 * handlers, and javascript: URLs.
 *
 * This is NOT a general-purpose sanitiser and does not pretend to be one —
 * wp_kses_post() on the WordPress side is the authority, and it runs on write
 * regardless. This exists so a bad generation can't render live in the widget's
 * preview either.
 */
export function sanitizeGeneratedHtml(html) {
  let out = String(html || '');
  out = out.replace(/<(script|style|iframe|object|embed|form)\b[\s\S]*?<\/\1\s*>/gi, '');
  out = out.replace(/<(script|style|iframe|object|embed|form)\b[^>]*\/?>/gi, '');
  out = out.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  out = out.replace(/(href|src)\s*=\s*("|')\s*javascript:[^"']*\2/gi, '$1="#"');
  return out.trim();
}

/** Is `raw[id]` an id we actually asked about? Ids are post ids (integers). */
function coerceId(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

/**
 * Warnings for one proposal, using the plugin's published limits. Returned to
 * the operator rather than fixed silently — the whole point of generating a
 * title is choosing the words, and truncating them mid-phrase is not a favour.
 */
export function suggestionWarnings(s) {
  const w = [];
  const t = String(s.seo_title || '');
  const d = String(s.seo_description || '');
  if (!t) w.push('no title');
  else if (t.length > TITLE_MAX) w.push(`title is ${t.length} chars (guideline ${TITLE_MAX})`);
  else if (t.length < TITLE_MIN) w.push(`title is only ${t.length} chars (guideline ${TITLE_MIN}+)`);
  if (!d) w.push('no description');
  else if (d.length > DESC_MAX) w.push(`description is ${d.length} chars (guideline ${DESC_MAX})`);
  else if (d.length < DESC_MIN) w.push(`description is only ${d.length} chars (guideline ${DESC_MIN}+)`);
  if (!s.focus_keyword) w.push('no focus keyword');
  else if (t && !t.toLowerCase().includes(String(s.focus_keyword).toLowerCase())) {
    w.push(`focus keyword "${s.focus_keyword}" is not in the title`);
  }
  return w;
}


/**
 * Drop the entries that mean "this line does not apply" (null/undefined) while
 * KEEPING the empty strings, which are deliberate blank lines between sections.
 * `filter(Boolean)` silently deleted them, so every prompt ran its sections
 * together with no visual break for the model to read.
 */
const lines = (parts) => parts.filter((p) => p != null);

// ── SEO metadata for existing content ───────────────────────────────────────

function siteLines(site = {}) {
  return [
    site.site_title ? `Site: ${site.site_title}${site.tagline ? ` — ${site.tagline}` : ''}` : null,
    site.owns_head === true
      ? 'Morpheus writes the title and description tags itself on this site.'
      : site.active_plugin
        ? `These fields are stored in ${site.active_plugin}'s own fields, which is what produces the tags on this site.`
        : null,
  ].filter(Boolean); // no blank lines intended here — every entry is a real line
}

function itemLines(item, i) {
  const lines = [
    `[${i + 1}] id=${item.id} (${item.type || 'page'})`,
    `  current title: ${item.title || '(untitled)'}`,
  ];
  if (item.existing_title) lines.push(`  existing SEO title (rewrite only if it is genuinely worse): ${item.existing_title}`);
  if (item.existing_description) lines.push(`  existing meta description: ${item.existing_description}`);
  if (item.focus_keyword) lines.push(`  existing focus keyword: ${item.focus_keyword}`);
  if (item.url) lines.push(`  url: ${item.url}`);
  if (item.word_count) lines.push(`  length: ${item.word_count} words`);
  if (item.excerpt) lines.push(`  excerpt: ${oneLine(item.excerpt, 300)}`);
  const body = blockText(item.content_text, MAX_GROUNDING_CHARS);
  lines.push(body ? `  page text: ${body}` : '  page text: (not provided — work from the title alone, and keep claims general)');
  return lines.join('\n');
}

/**
 * The SEO-metadata prompt for a batch of existing content.
 *
 * The hard rules in here are the ones that make generated metadata usable on a
 * real site: never invent a fact (a fabricated price or location in a meta
 * description is a lie in search results), write for a human scanning results,
 * and match the site's own voice rather than inventing a new one.
 */
export function buildSeoPrompt({ business, brandVoice, site, items = [] } = {}) {
  const header = lines([
    'You write SEO metadata for pages that are ALREADY PUBLISHED on a real website. You are given the page text; your job is the title and description that appear in search results.',
    '',
    `BUSINESS: ${oneLine(business, 600) || 'a small business'}`,
    brandVoice ? `BRAND VOICE: ${oneLine(brandVoice, 400)}` : null,
    ...siteLines(site),
    '',
    'RULES — these are not style preferences:',
    `1. Never invent a fact. No prices, dates, locations, guarantees, awards, ratings, years or specifications that are not in the page text or the business line above. A plausible-sounding fabrication is the worst possible outcome here.`,
    `2. Title: ${TITLE_MIN}-${TITLE_MAX} characters, the actual subject of the page first. No clickbait, no "Best ... in 2025", no ALL CAPS, no site name — the search engine appends that itself.`,
    `3. Description: ${DESC_MIN}-${DESC_MAX} characters, one or two complete sentences, active voice, says what the reader gets. It is a summary, not a keyword list.`,
    `4. Focus keyword: the phrase a real person would type to find this page. 1-4 words, lower case.`,
    `5. Ordinary punctuation and Australian English. No emoji, no surrounding quotes, no markdown.`,
    `6. Write each item independently — two pages must not end up with the same title or description.`,
    `7. If the page text is thin or you were given only a title, keep every claim general enough to be true.`,
    '',
    'CONTENT TO WRITE FOR:',
  ]);

  const body = items.map(itemLines).join('\n\n');

  return `${header.join('\n')}\n${body}\n\nReturn JSON with one entry per item above, in the same order, using the EXACT id given:
{ "suggestions": [ { "id": <id>, "seo_title": "...", "seo_description": "...", "focus_keyword": "..." } ] }`;
}

export const SEO_SCHEMA = {
  type: 'object',
  properties: {
    suggestions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'integer', description: 'The exact id copied from the input item.' },
          seo_title: { type: 'string' },
          seo_description: { type: 'string' },
          focus_keyword: { type: 'string' },
        },
        required: ['id', 'seo_title', 'seo_description', 'focus_keyword'],
      },
    },
  },
  required: ['suggestions'],
};

/**
 * Map a model response back onto the items it was given.
 *
 * Anything the model invents is dropped rather than trusted:
 *   * an id we did not ask about (a hallucinated post id would write SEO to
 *     somebody else's page),
 *   * an entry that is missing an id or came back empty,
 *   * duplicates of the same id in one response.
 *
 * Warnings and cross-item duplicate detection are attached for the UI, which
 * shows them next to an APPLY button rather than blocking the operator.
 */
export function normalizeSuggestions(raw, items = []) {
  const byId = new Map();
  for (const it of items) {
    const id = coerceId(it?.id);
    if (id != null) byId.set(id, it);
  }

  const list = Array.isArray(raw?.suggestions) ? raw.suggestions
    : Array.isArray(raw) ? raw
    : raw && typeof raw === 'object' ? [raw]
    : [];

  const out = [];
  const seen = new Set();
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const id = coerceId(entry.id ?? entry.post_id ?? entry.ID);
    if (id == null || !byId.has(id) || seen.has(id)) continue;
    const s = {
      id,
      seo_title: oneLine(entry.seo_title ?? entry.title),
      seo_description: blockText(entry.seo_description ?? entry.description ?? entry.meta_description),
      focus_keyword: oneLine(entry.focus_keyword ?? entry.keyword, 60),
    };
    if (!s.seo_title && !s.seo_description) continue; // nothing usable
    seen.add(id);
    out.push(s);
  }

  // Duplicate detection happens across the whole batch, because that is the
  // only place it can be seen — the plugin's audit will flag it later, but the
  // operator is looking at the batch now.
  const titles = new Map();
  const descs = new Map();
  for (const s of out) {
    if (s.seo_title) titles.set(s.seo_title, [...(titles.get(s.seo_title) || []), s.id]);
    if (s.seo_description) descs.set(s.seo_description, [...(descs.get(s.seo_description) || []), s.id]);
  }
  return out.map((s) => {
    const warnings = suggestionWarnings(s);
    if (s.seo_title && (titles.get(s.seo_title) || []).length > 1) warnings.push('same title as another item in this batch');
    if (s.seo_description && (descs.get(s.seo_description) || []).length > 1) warnings.push('same description as another item in this batch');
    return { ...s, title: byId.get(s.id)?.title || '', warnings };
  });
}

// ── a new blog post ─────────────────────────────────────────────────────────

export function buildBlogPrompt({ business, brandVoice, site, topic, keywords, tone, words, existing = [] } = {}) {
  const target = Math.max(300, Math.min(1500, Number(words) || 700));
  const links = existing
    .filter((e) => e && e.url && e.title)
    .slice(0, MAX_INTERNAL_LINKS)
    .map((e) => `- ${oneLine(e.title, 90)} (${e.type || 'page'}) ${e.url}`)
    .join('\n');

  return `${lines([
    'You write a blog post for a real business website. It will be reviewed by the owner before it is published, so write the piece, not a proposal for the piece.',
    '',
    `BUSINESS: ${oneLine(business, 600) || 'a small business'}`,
    brandVoice ? `BRAND VOICE: ${oneLine(brandVoice, 400)}` : null,
    ...siteLines(site),
    topic ? `TOPIC: ${oneLine(topic, 300)}` : 'TOPIC: choose the most useful thing this business could publish right now, given the business line above.',
    keywords ? `TARGET PHRASES (use naturally, never stuffed): ${oneLine(keywords, 200)}` : null,
    tone ? `TONE: ${oneLine(tone, 120)}` : 'TONE: plain, specific, useful. The voice of someone who does this work.',
    '',
    'RULES:',
    `1. Never invent facts about the business: no prices, dates, addresses, staff names, awards, certifications, statistics or years that were not given to you above. If a claim would need a number you do not have, write around it.`,
    `2. About ${target} words, in the HTML fragment below — use <p>, <h2>, <h3>, <ul>/<li>, <strong>, <em>, <blockquote> and <a>. No <html>, <head>, <body>, no <script>, no inline styles, no markdown, no images.`,
    '3. Open with the reader\'s actual problem, not "In today\'s fast-paced world". No filler introduction, no summary conclusion that repeats the piece.',
    '4. Structure it so it is skimmable: 2-4 <h2> sections with real headings (not "Introduction" / "Conclusion").',
    links ? '5. Where it genuinely helps the reader, link to the site\'s own existing pages using the exact URLs listed below. Never invent a URL. At most 3 links, and only where a reader would want them.' : '5. Do not include links — no internal URLs were provided, and inventing one would be a broken link on a live site.',
    '6. Ordinary punctuation and Australian English. No emoji.',
    '',
  ]).join('\n')}${links ? `EXISTING PAGES YOU MAY LINK TO:\n${links}\n\n` : ''}Return JSON:
{
  "title": "the post title, under 70 characters",
  "excerpt": "one sentence for previews, under 200 characters",
  "content": "the post body as an HTML fragment",
  "seo_title": "search-result title, ${TITLE_MIN}-${TITLE_MAX} characters",
  "seo_description": "search-result description, ${DESC_MIN}-${DESC_MAX} characters",
  "focus_keyword": "1-4 word phrase"
}`;
}

export const BLOG_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    excerpt: { type: 'string' },
    content: { type: 'string', description: 'HTML fragment: p/h2/h3/ul/li/strong/em/blockquote/a only.' },
    seo_title: { type: 'string' },
    seo_description: { type: 'string' },
    focus_keyword: { type: 'string' },
  },
  required: ['title', 'excerpt', 'content', 'seo_title', 'seo_description', 'focus_keyword'],
};

/**
 * Normalise a generated post. Returns `{ draft, warnings }`, or null when there
 * is nothing publishable in it — a caller should then say so plainly rather
 * than storing a half-empty post.
 */
export function normalizeBlogDraft(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const title = oneLine(raw.title, 200);
  const content = sanitizeGeneratedHtml(raw.content);
  if (!title || !content) return null;

  const seo = {
    seo_title: oneLine(raw.seo_title) || title.slice(0, TITLE_MAX),
    seo_description: blockText(raw.seo_description),
    focus_keyword: oneLine(raw.focus_keyword, 60),
  };
  const warnings = suggestionWarnings(seo);
  if (!raw.excerpt) warnings.push('no excerpt was generated');
  if (content.length < 600) warnings.push('the body is very short — consider regenerating');

  return {
    draft: {
      title,
      excerpt: oneLine(raw.excerpt, MAX_EXCERPT),
      content,
      ...seo,
    },
    warnings,
  };
}

// ── internal links ─────────────────────────────────────────────────────────

// An anchor has to be cast-iron plain: it is matched against the item's real
// text and then inserted into live HTML, so quotes, brackets, ampersands or
// entities would either miss or mangle the sentence. Plain words only.
const ANCHOR_OK = /^[\p{L}\p{N}][\p{L}\p{N} '\-]{1,60}$/u;
export const MAX_LINKS = 5;

export function buildLinkPrompt({ business, title, url, content, candidates = [] } = {}) {
  const list = candidates
    .slice(0, 40)
    .map((c) => `- ${oneLine(c.title, 90)} (${c.type || 'page'}) ${c.url}`)
    .join('\n');
  return `${lines([
    'You suggest INTERNAL LINKS for one page on a real website. You are given that page\'s own text and the other pages on the site. You do not write anything new — you point out where the existing text should link to another page.',
    '',
    `PAGE: ${oneLine(title, 200)}`,
    url ? `PAGE URL: ${url}` : null,
    business ? `BUSINESS: ${oneLine(business, 400)}` : null,
    '',
    'RULES — a suggestion that breaks any of these is discarded:',
    '1. The anchor must be a phrase that ALREADY APPEARS, character for character, in the page text below. Copy it exactly: same words, same order, same spelling. Do not invent a phrase, do not reword, and do not use a phrase that only appears in the page title.',
    '2. The anchor must be 2-6 words of ordinary prose — letters, numbers, spaces, apostrophes and hyphens only. No punctuation, no HTML, no "%", no quotes.',
    `3. Pick at most ${MAX_LINKS} links, and only where a reader would genuinely want to follow one. Fewer good ones beat five thin ones.`,
    '4. Each link must point at a DIFFERENT page from the list. Never link to this page itself.',
    '5. Use the URL exactly as given in the list. Never invent or shorten a URL.',
    '',
    'THE PAGE\'S OWN TEXT:',
    blockText(content, MAX_GROUNDING_CHARS),
    '',
    'OTHER PAGES ON THE SITE THAT COULD BE LINKED TO:',
    list || '(none — return an empty list)',
  ]).join('\n')}

Return JSON: { "links": [ { "anchor": "exact phrase from the page text", "url": "one of the URLs above", "why": "one short sentence" } ] }`;
}

export const LINK_SCHEMA = {
  type: 'object',
  properties: {
    links: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          anchor: { type: 'string', description: 'A phrase copied exactly from the page text.' },
          url: { type: 'string' },
          why: { type: 'string' },
        },
        required: ['anchor', 'url', 'why'],
      },
    },
  },
  required: ['links'],
};

/**
 * Keep only the links that could actually be applied.
 *
 * Every one of these checks exists because the alternative is a live site
 * edit: an anchor the model invented would either do nothing (best case) or
 * wrap the wrong words (worst case), and a URL it invented is a 404 in a
 * customer's face. `dropped` carries the reason so the panel can be honest
 * about what was thrown away rather than silently showing fewer suggestions.
 */
export function normalizeLinkSuggestions(raw, { content = '', pageUrl = '', candidates = [] } = {}) {
  const allowed = new Map();
  for (const c of candidates) {
    if (c && typeof c.url === 'string' && c.url) allowed.set(c.url.replace(/\/+$/, ''), c);
  }
  const text = String(content || '');
  const lower = text.toLowerCase();
  const self = String(pageUrl || '').replace(/\/+$/, '');

  const list = Array.isArray(raw?.links) ? raw.links : Array.isArray(raw) ? raw : [];
  const out = [];
  const dropped = [];
  const usedUrls = new Set();
  const usedAnchors = new Set();

  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const anchor = String(entry.anchor ?? '').replace(/\s+/g, ' ').trim();
    const url = String(entry.url ?? '').trim().replace(/\/+$/, '');
    const why = oneLine(entry.why, 200);

    const key = anchor.toLowerCase();
    if (!anchor) { dropped.push({ anchor, url, reason: 'no anchor' }); continue; }
    if (!ANCHOR_OK.test(anchor)) { dropped.push({ anchor, url, reason: 'anchor has punctuation or markup in it' }); continue; }
    if (!lower.includes(key)) { dropped.push({ anchor, url, reason: 'that phrase is not in the page text' }); continue; }
    if (usedAnchors.has(key)) { dropped.push({ anchor, url, reason: 'the same phrase was suggested twice' }); continue; }
    // The self check comes first so the reason names the real problem — a page
    // linking to itself is not "not one of this site's pages", and a clear
    // reason is the whole point of reporting the drops.
    if (url === self) { dropped.push({ anchor, url, reason: 'links to the page itself' }); continue; }
    if (!allowed.has(url)) { dropped.push({ anchor, url, reason: 'not one of this site\'s pages' }); continue; }
    if (usedUrls.has(url)) { dropped.push({ anchor, url, reason: 'two links to the same page' }); continue; }

    usedAnchors.add(key);
    usedUrls.add(url);
    out.push({ anchor, url, why, target: oneLine(allowed.get(url).title, 120), type: allowed.get(url).type || 'page' });
    if (out.length >= MAX_LINKS) break;
  }
  return { links: out, dropped };
}
