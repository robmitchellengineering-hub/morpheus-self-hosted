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

// One batch = one model call. 25 items with 1500 chars of grounding each is
// already a large prompt; beyond that the model starts dropping items, which
// looks like a generation failure to the operator.
export const MAX_BATCH = 25;
export const MAX_GROUNDING_CHARS = 1500;
export const MAX_INTERNAL_LINKS = 40;

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

// ── SEO metadata for existing content ───────────────────────────────────────

function siteLines(site = {}) {
  return [
    site.site_title ? `Site: ${site.site_title}${site.tagline ? ` — ${site.tagline}` : ''}` : null,
    site.owns_head === true
      ? 'Morpheus writes the title and description tags itself on this site.'
      : site.active_plugin
        ? `These fields are stored in ${site.active_plugin}'s own fields, which is what produces the tags on this site.`
        : null,
  ].filter(Boolean);
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
  const header = [
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
  ].filter(Boolean);

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

  return `${[
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
  ].filter(Boolean).join('\n')}${links ? `EXISTING PAGES YOU MAY LINK TO:\n${links}\n\n` : ''}Return JSON:
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
