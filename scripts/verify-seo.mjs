// Runtime verification for the SEO generation path — the rules that decide
// what a model is allowed to write onto a live website.
//
// Dependency-free (server/src/lib/seoPrompts.js imports nothing at all), so it
// runs in CI's no-install guards job alongside verify-drift.mjs.
//
// Run:  node scripts/verify-seo.mjs
//
// Three groups, and the last one is the one that rots silently:
//
//   1. the prompt — grounding actually reaches it, and it is bounded
//   2. the normaliser — the model is untrusted input: it may not invent a post
//      id, may not smuggle a <script> into a stored post, and may not have its
//      words silently cut to fit a guideline
//   3. THE CROSS-LANGUAGE CONTRACT — the field names and action names this JS
//      sends are parsed out of the plugin's PHP and compared. A rename on
//      either side is a silent no-op at runtime: the plugin ignores an unknown
//      key, so the write just doesn't happen and nothing errors.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  buildSeoPrompt, normalizeSuggestions, suggestionWarnings,
  sanitizeGeneratedHtml, normalizeBlogDraft, buildBlogPrompt,
  SEO_INPUT_KEYS, TITLE_MAX, DESC_MAX, TITLE_HARD_MAX, MAX_GROUNDING_CHARS,
  buildLinkPrompt, normalizeLinkSuggestions, MAX_LINKS,
} from '../server/src/lib/seoPrompts.js';
import { TEMPLATE_TOKENS } from '../src/lib/seoTemplate.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(REPO, p), 'utf8');

let checks = 0;
let failures = 0;

function check(name, actual, expected) {
  checks++;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  PASS  ${name}`);
  } else {
    console.log(`  FAIL  ${name}\n          expected ${e}\n          got      ${a}`);
    failures++;
  }
}

const has = (haystack, needle) => String(haystack).includes(needle);

console.log('\nSEO generation — runtime verification\n');

// ── 1. the prompt ───────────────────────────────────────────────────────────
console.log('1. the prompt carries real grounding, and is bounded');

const items = [
  { id: 11, type: 'page', title: 'Guitar repairs', url: 'https://shop.test/repairs', word_count: 420, content_text: 'We repair guitars. '.repeat(40) },
  { id: 12, type: 'post', title: 'Setup guide', url: 'https://shop.test/setup', existing_description: 'How to set up a guitar.', content_text: 'Setting up a guitar properly takes patience.' },
];
const prompt = buildSeoPrompt({
  business: 'Valiant Music, a vintage guitar shop in Melbourne',
  brandVoice: 'plain, expert, no hype',
  site: { site_title: 'Valiant Music', tagline: 'Vintage guitars', owns_head: true },
  items,
});

check('business context reaches the prompt', has(prompt, 'Valiant Music, a vintage guitar shop in Melbourne'), true);
check('brand voice reaches the prompt', has(prompt, 'plain, expert, no hype'), true);
check('each item id is given to the model', has(prompt, 'id=11') && has(prompt, 'id=12'), true);
check('each item title is given to the model', has(prompt, 'Guitar repairs') && has(prompt, 'Setup guide'), true);
check('page text is given to the model', has(prompt, 'Setting up a guitar properly takes patience.'), true);
check('an existing description is offered as context', has(prompt, 'existing meta description: How to set up a guitar.'), true);
check('the no-fabrication rule is stated', has(prompt, 'Never invent a fact'), true);
check('the length guidance is stated', has(prompt, `${TITLE_MAX} characters`) && has(prompt, `${DESC_MAX} characters`), true);
check('the exact output shape is stated', has(prompt, '"suggestions"') && has(prompt, '"seo_title"'), true);
// The blank lines between sections are deliberate, and were silently deleted
// once by a filter(Boolean) — a prompt that reads as one wall of text is
// measurably worse for the model than one with its parts separated.
check('sections are separated by blank lines', (prompt.match(/\n\n/g) || []).length >= 4, true);
check('the link prompt separates its sections too', (buildLinkPrompt({ business: 'x', title: 'T', url: 'u', content: 'c', candidates: [{ title: 'A', url: 'https://a.test', type: 'page' }] }).match(/\n\n/g) || []).length >= 3, true);

// A pasted-in 100k-character page must not become a 100k-character prompt.
const huge = buildSeoPrompt({
  business: 'x',
  items: [{ id: 1, title: 'Huge', content_text: 'y'.repeat(100000) }],
});
check('grounding is capped per item', huge.length < MAX_GROUNDING_CHARS + 3000, true);
check('the cap did not drop the item', has(huge, 'id=1'), true);

// Thin grounding must be admitted, not faked.
const thin = buildSeoPrompt({ business: 'x', items: [{ id: 2, title: 'No body' }] });
check('an item with no body says so rather than inventing one', has(thin, 'not provided'), true);

const blogPrompt = buildBlogPrompt({
  business: 'Valiant Music',
  topic: 'refretting',
  words: 900,
  existing: [{ title: 'Repairs', url: 'https://shop.test/repairs', type: 'page' }],
});
check('the blog prompt offers the site\'s real URLs', has(blogPrompt, 'https://shop.test/repairs'), true);
check('the blog prompt asks for the requested length', has(blogPrompt, 'About 900 words'), true);

const noLinks = buildBlogPrompt({ business: 'x', existing: [] });
check('with no real URLs it forbids links outright', has(noLinks, 'Do not include links'), true);

// ── 2. the normaliser ───────────────────────────────────────────────────────
console.log('\n2. the model is untrusted input');

const usable = [
  { id: 11, title: 'Guitar repairs' },
  { id: 12, title: 'Setup guide' },
];

// A hallucinated id is the dangerous one: it would write metadata to a page the
// operator never selected.
const hall = normalizeSuggestions({ suggestions: [
  { id: 11, seo_title: 'Guitar Repairs in Melbourne', seo_description: 'x'.repeat(80), focus_keyword: 'guitar repairs' },
  { id: 999, seo_title: 'Somebody else\'s page', seo_description: 'y'.repeat(80) },
] }, usable);
check('a hallucinated id is dropped', hall.map((s) => s.id), [11]);

// Numeric strings are what a model often emits; accept them, but still bounded
// by the ids we asked about.
const strId = normalizeSuggestions({ suggestions: [
  { id: '12', seo_title: 'Setup Guide For Your Guitar', seo_description: 'z'.repeat(80) },
] }, usable);
check('a numeric-string id is accepted', strId.map((s) => s.id), [12]);

const dupes = normalizeSuggestions({ suggestions: [
  { id: 11, seo_title: 'First take on the title here', seo_description: 'a'.repeat(80) },
  { id: 11, seo_title: 'Second take on the title here', seo_description: 'b'.repeat(80) },
] }, usable);
check('the same id twice is applied once', dupes.length, 1);
check('the first take wins', dupes[0].seo_title, 'First take on the title here');

check('garbage in -> nothing out', normalizeSuggestions('not json', usable), []);
check('missing id -> nothing out', normalizeSuggestions({ suggestions: [{ seo_title: 'No id at all here' }] }, usable), []);
check('empty entry -> nothing out', normalizeSuggestions({ suggestions: [{ id: 11, seo_title: '', seo_description: '' }] }, usable), []);

// A too-long value is REPORTED, not trimmed to the guideline — cutting words
// mid-phrase is not a favour, and the operator is about to review it anyway.
const long = normalizeSuggestions({ suggestions: [
  { id: 11, seo_title: 'T'.repeat(TITLE_HARD_MAX + 50), seo_description: 'd'.repeat(DESC_MAX + 30), focus_keyword: 'k' },
] }, usable);
check('an absurd title is hard-capped', long[0].seo_title.length, TITLE_HARD_MAX);
check('an over-guideline description is hard-capped, not guideline-trimmed', long[0].seo_description.length, DESC_MAX + 30);
check('over-length is reported as a warning', has(long[0].warnings.join(' '), 'title is'), true);
check('the guideline itself is not exceeded silently', long[0].warnings.some((w) => w.includes(`guideline ${TITLE_MAX}`)), true);

const over = normalizeSuggestions({ suggestions: [
  { id: 11, seo_title: 'T'.repeat(TITLE_MAX + 5), seo_description: 'Good description '.repeat(8).trim(), focus_keyword: 'guitar repairs' },
] }, usable);
check('a mildly long title is left exactly as generated', over[0].seo_title.length, TITLE_MAX + 5);

// Two items with identical metadata is the batch-level failure the plugin's
// audit only catches later — the operator is looking at the batch now.
const same = normalizeSuggestions({ suggestions: [
  { id: 11, seo_title: 'Identical Title For Both', seo_description: 'Identical description for both of them here.', focus_keyword: 'a' },
  { id: 12, seo_title: 'Identical Title For Both', seo_description: 'Identical description for both of them here.', focus_keyword: 'b' },
] }, usable);
check('duplicate titles inside one batch are flagged', same.every((s) => has(s.warnings.join(' '), 'same title as another item')), true);

const warned = suggestionWarnings({ seo_title: 'Short one', seo_description: '', focus_keyword: '' });
check('a missing description is warned about', has(warned.join(' '), 'no description'), true);
check('a short title is warned about', has(warned.join(' '), 'guideline'), true);
const kw = suggestionWarnings({ seo_title: 'Guitar repairs in Melbourne', seo_description: 'x'.repeat(80), focus_keyword: 'banjo' });
check('a focus keyword absent from the title is warned about', has(kw.join(' '), 'not in the title'), true);
check('a suggestion carrying the item title is labelled with it', normalizeSuggestions({ suggestions: [
  { id: 11, seo_title: 'A Fine Title For Repairs', seo_description: 'w'.repeat(80), focus_keyword: 'repairs' },
] }, usable)[0].title, 'Guitar repairs');

// ── 3. HTML that must never be stored ───────────────────────────────────────
console.log('\n3. model-authored HTML cannot smuggle script through');

const dirty = sanitizeGeneratedHtml('<p>Read this</p><script>alert(1)</script><iframe src="https://evil.test"></iframe><p onclick="steal()">Click</p><a href="javascript:alert(2)">x</a>');
check('script and its body are removed', has(dirty, 'alert(1)'), false);
check('iframe is removed', has(dirty, 'iframe'), false);
check('inline event handlers are removed', has(dirty, 'onclick'), false);
check('javascript: URLs are neutralised', has(dirty, 'javascript:'), false);
check('legitimate markup survives', has(dirty, '<p>Read this</p>') && has(dirty, 'Click'), true);

const okDraft = normalizeBlogDraft({
  title: 'Refretting a worn guitar',
  excerpt: 'What refretting is and when it is worth doing.',
  content: `<p>${'Real sentences about refretting a guitar. '.repeat(20)}</p><h2>When it is worth it</h2><p>More text.</p>`,
  seo_title: 'Refretting a Worn Guitar',
  seo_description: 'd'.repeat(90),
  focus_keyword: 'refretting',
});
check('a usable draft normalises', okDraft !== null, true);
check('the draft keeps its title and body', okDraft.draft.title === 'Refretting a worn guitar' && has(okDraft.draft.content, '<h2>'), true);

check('a draft with no title is refused', normalizeBlogDraft({ title: '', content: '<p>x</p>' }), null);
check('a draft with no body is refused', normalizeBlogDraft({ title: 'Good title here', content: '<script>alert(1)</script>' }), null);
check('a draft with no seo_title falls back to the title', normalizeBlogDraft({
  title: 'A Reasonable Post Title', content: `<p>${'x'.repeat(700)}</p>`, excerpt: 'e', seo_title: '', seo_description: 'd'.repeat(80), focus_keyword: 'k',
}).draft.seo_title, 'A Reasonable Post Title');
check('a very short body is flagged for the operator', normalizeBlogDraft({
  title: 'A Reasonable Post Title', content: '<p>Too short.</p>', excerpt: 'e', seo_title: 'T', seo_description: 'd'.repeat(80), focus_keyword: 'k',
}).warnings.some((w) => has(w, 'very short')), true);

// ── 3b. internal links ──────────────────────────────────────────────────────
console.log('\n3b. internal links can only wrap a phrase that already exists');

const pageText = 'We repair electric and acoustic guitars in Melbourne, and every setup covers the truss rod and the intonation.';
const candidates = [
  { title: 'Setup Guide', url: 'https://shop.test/setup', type: 'page' },
  { title: 'Vintage Guide', url: 'https://shop.test/vintage', type: 'post' },
];
const linkArgs = { content: pageText, pageUrl: 'https://shop.test/repairs/', candidates };

const linkPrompt = buildLinkPrompt({ business: 'Valiant Music', title: 'Repairs', url: 'https://shop.test/repairs/', content: pageText, candidates });
check('the link prompt carries the page text to copy anchors from', has(linkPrompt, 'truss rod and the intonation'), true);
check('the link prompt lists the real target URLs', has(linkPrompt, 'https://shop.test/setup'), true);
check('the link prompt forbids inventing an anchor', has(linkPrompt, 'ALREADY APPEARS, character for character'), true);
check('the link prompt forbids inventing a URL', has(linkPrompt, 'Never invent or shorten a URL'), true);
check('the link prompt caps the number of links', has(linkPrompt, `at most ${MAX_LINKS} links`), true);

// The dangerous cases, all of which must be discarded rather than applied.
const linkResult = normalizeLinkSuggestions({ links: [
  { anchor: 'electric and acoustic guitars', url: 'https://shop.test/setup', why: 'relevant' },
  { anchor: 'pink elephants juggling', url: 'https://shop.test/vintage', why: 'invented phrase' },
  { anchor: 'truss rod', url: 'https://evil.test/x', why: 'invented url' },
  { anchor: 'Melbourne', url: 'https://shop.test/vintage', why: 'ok' },
  { anchor: 'truss rod', url: 'https://shop.test/setup', why: 'same page twice' },
  { anchor: 'intonation', url: 'https://shop.test/repairs/', why: 'self link' },
  { anchor: '<b>setup</b>', url: 'https://shop.test/setup', why: 'markup in the anchor' },
  { anchor: 'setup', url: 'https://shop.test/vintage', why: 'ok but the URL is taken' },
] }, linkArgs);
check('the usable links are kept, in order', linkResult.links.map((l) => l.anchor), ['electric and acoustic guitars', 'Melbourne']);
check('every kept link names its target page', linkResult.links.map((l) => l.target), ['Setup Guide', 'Vintage Guide']);
check('an invented phrase is dropped', linkResult.dropped.some((d) => has(d.reason, 'not in the page text')), true);
check('an invented URL is dropped', linkResult.dropped.some((d) => has(d.reason, "not one of this site's pages")), true);
check('a self link is dropped', linkResult.dropped.some((d) => has(d.reason, 'page itself')), true);
check('markup in an anchor is dropped', linkResult.dropped.some((d) => has(d.reason, 'punctuation or markup')), true);
check('two links to the same page are dropped to one', linkResult.dropped.some((d) => has(d.reason, 'same page')), true);
check('every dropped suggestion says why', linkResult.dropped.every((d) => typeof d.reason === 'string' && d.reason.length > 0), true);
check('the anchor is matched case-insensitively but returned as written', normalizeLinkSuggestions(
  { links: [{ anchor: 'MELBOURNE', url: 'https://shop.test/vintage', why: 'x' }] }, linkArgs).links[0].anchor, 'MELBOURNE');
check('an empty candidate list yields no links', normalizeLinkSuggestions({ links: [{ anchor: 'Melbourne', url: 'https://shop.test/x', why: 'x' }] }, { content: pageText, pageUrl: '', candidates: [] }).links, []);
check('garbage in -> nothing out', normalizeLinkSuggestions('nope', linkArgs).links, []);
// The anchor goes into live HTML, so a quote or an ampersand must never survive.
for (const bad of ['say "hello"', 'a&b', 'trailing,', 'semi;colon', '<i>x</i>']) {
  check(`anchor refused: ${bad}`, normalizeLinkSuggestions({ links: [{ anchor: bad, url: 'https://shop.test/setup', why: 'x' }] }, { ...linkArgs, content: `text with ${bad} inside it` }).links.length, 0);
}

// ── 4. the cross-language contract ─────────────────────────────────────────
console.log('\n4. the JS payload and the plugin\'s PHP agree');

const php = read('wp-plugin/morpheus/includes/seo/class-seo.php');
const jsProxy = read('server/src/functions/wordPressSeoAction.js');

// The input names in Morpheus_SEO::set_fields()'s $map — the values, because
// the keys are the internal field names and the values are the wire names.
const mapBlock = php.match(/(?:public|private|protected) static function set_fields[\s\S]*?\$map = array\(([\s\S]*?)\);/);
const phpInputs = mapBlock ? [...mapBlock[1].matchAll(/=>\s*'([a-z_]+)'/g)].map((m) => m[1]) : [];
const phpNoindex = /array_key_exists\(\s*'noindex',\s*\$data\s*\)/.test(php);

// A regex that silently matches nothing would make this whole group pass by
// accident, so the parse itself is asserted first.
check('the PHP input map was actually parsed', phpInputs.length >= 5, true);
check('the PHP map lists seo_title + seo_description', phpInputs.includes('seo_title') && phpInputs.includes('seo_description'), true);

const phpAccepted = phpNoindex ? [...phpInputs, 'noindex'].sort() : [...phpInputs].sort();
check('every field the JS sends is a field the plugin accepts', [...SEO_INPUT_KEYS].sort(), phpAccepted);
check('noindex is accepted in its own PHP branch', phpNoindex, true);

// The proxy's ALLOWED set vs the plugin's own switch — an action added on one
// side and not the other is dead on arrival.
const allowedBlock = jsProxy.match(/const ALLOWED = new Set\(\[([\s\S]*?)\]\)/);
const jsActions = allowedBlock ? [...allowedBlock[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort() : [];
const phpActions = [...php.matchAll(/case\s+'([a-z_]+)':\s*\$r\s*=/g)].map((m) => m[1]).sort();
check('the proxy action list was parsed', jsActions.length >= 6, true);
check('the plugin action list was parsed', phpActions.length >= 6, true);
check('every action the proxy allows exists in the plugin', jsActions, phpActions);

// The template tokens the settings screen offers must be the ones the plugin
// understands. A token added on one side only is a silent no-op: the operator
// types %something% and the plugin strips it out of the live title.
const phpTokensBlock = php.match(/const TEMPLATE_TOKENS = array\(([\s\S]*?)\);/);
const phpTokens = phpTokensBlock ? [...phpTokensBlock[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort() : [];
check('the plugin token list was parsed', phpTokens.length >= 3, true);
check('the UI offers exactly the tokens the plugin understands', [...TEMPLATE_TOKENS].sort(), phpTokens);

// And the write actions must stay on the velocity-gated side of the proxy. This
// asserts the RULE — anything that mutates the site is gated, and nothing that
// only reads is — rather than a fixed list of two names, so a new mutating
// action cannot quietly skip the gate (which is exactly how set_defaults
// nearly did).
const writeBlock = jsProxy.match(/const WRITE_ACTIONS = new Set\(\[([\s\S]*?)\]\)/);
const jsWrites = writeBlock ? [...writeBlock[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]) : [];
const MUTATING = /^(set_|bulk_|delete_|create_|update_)/;
const READ_ONLY = /^(get_|list_|read_|context$|audit$)/;
check('the write list was actually parsed', jsWrites.length >= 1, true);
check('every mutating action is velocity-gated', jsActions.filter((a) => MUTATING.test(a)).sort(), [...jsWrites].sort());
check('no read-only action is gated as a write', jsActions.filter((a) => READ_ONLY.test(a)).some((a) => jsWrites.includes(a)), false);

// ═══ THE WIDGET PARITY CONTRACT ═════════════════════════════════════════════
// This app renders the SAME SEO tab inside an embed, under a widget token
// (src/pages/Embed.jsx). A widget token may only call the functions its scope
// lists (server/src/lib/widgetToken.js, enforced in routes/functions.routes.js);
// anything else answers 403 "Widget tokens can't call <name>".
//
// So a function the SEO surface calls and the `seo` scope omits is a dead end
// that appears ONLY inside the widget, at whatever click needs it — which is how
// the blog flow shipped able to compose a post and unable to save it, because
// saving went through wordPressStoreAction, a `store`-scope name. Nothing failed
// until a user pressed the last button.
//
// The rule: every function the SEO surface invokes is in the `seo` scope.
const seoTabSrc = readFileSync(join(REPO, 'src/components/matrix/website/SeoTab.jsx'), 'utf8');
const panelSrc = readFileSync(join(REPO, 'src/components/matrix/website/SearchConsolePanel.jsx'), 'utf8');
const invoked = new Set(
  [...`${seoTabSrc}\n${panelSrc}`.matchAll(/functions\.invoke\(\s*'([A-Za-z][A-Za-z0-9]*)'/g)].map((m) => m[1]),
);
const scopeBlock = readFileSync(join(REPO, 'server/src/lib/widgetToken.js'), 'utf8').match(/seo:\s*\[([\s\S]*?)\]/);
const seoScope = scopeBlock ? [...scopeBlock[1].matchAll(/'([A-Za-z][A-Za-z0-9]*)'/g)].map((m) => m[1]) : [];
check('the SEO surface invokes functions (parser sanity)', invoked.size >= 5, true);
check('the seo widget scope was parsed (parser sanity)', seoScope.length >= 5, true);
check('the widget can call every function the SEO surface uses',
  [...invoked].filter((f) => !seoScope.includes(f)).sort(), []);
// getWordPressStore is listed because the SEO surface reads the site context
// through it before the seo endpoint is called, even where a given tab does not
// name it directly.
check('the scope grants nothing the surface does not use (no silent widening)',
  seoScope.filter((f) => !invoked.has(f) && f !== 'getWordPressStore').sort(), []);

// The tempting fix for that dead end was to grant the whole store dispatcher to
// the SEO scope, which would hand an SEO-only embed `delete_product` and
// `delete_page`. Assert the narrow choice, both ways round.
check('the broad store dispatcher is NOT in the seo scope', seoScope.includes('wordPressStoreAction'), false);
check('the narrow post writer is', seoScope.includes('createSitePost'), true);
const createSitePostSrc = readFileSync(join(REPO, 'server/src/functions/createSitePost.js'), 'utf8');
// Strip comments BEFORE asserting on source. Without this, `it forces the post to
// a draft` passed against the file's own header comment ("forces `status:
// 'draft'`") even when the code said `status: 'publish'` — the mutation test is
// what caught it, and it is the same trap this library records: a check that
// matches the prose describing a rule instead of the rule.
const code = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const createSitePostCode = code(createSitePostSrc);
check('it performs exactly the one plugin action', (createSitePostCode.match(/wpStore\(conn, '/g) || []).length, 1);
check('…and that action is create_post', /wpStore\(conn, 'create_post'/.test(createSitePostCode), true);
// A widget-scoped write must not be able to publish: the status comes from the
// handler, never from the caller.
check('it forces the post to a draft', /status: 'draft'/.test(createSitePostCode), true);
check('…and never reads status from the request body', /body\?\.status|body\.status/.test(createSitePostCode), false);

// ── summary ─────────────────────────────────────────────────────────────────
console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log('\nSEO generation rules are broken. Fix before merging.\n');
  process.exit(1);
}
console.log('SEO generation rules hold.\n');
