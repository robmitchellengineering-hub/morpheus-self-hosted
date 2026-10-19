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
  MAX_BATCH, SEO_ITEMS_PER_CALL, SEO_TOKENS_PER_ITEM, SEO_REASONING_FLOOR,
  SEO_MIN_CALL_TOKENS, SEO_MAX_CALL_TOKENS,
  chunkSeoItems, seoCallMaxTokens, mergeSeoSuggestions, generateSeoInChunks, SEO_AI_ROLE,
} from '../server/src/lib/seoPrompts.js';
import { TEMPLATE_TOKENS } from '../src/lib/seoTemplate.js';
import {
  ROBOTS_FINDING_ID, ROBOTS_BACKUP_PREFIX, backupName, isBackupName, backupBasename,
  quarantineEvidence, undoLine,
} from '../server/src/lib/robotsQuarantine.js';
import {
  SEO_REQUEST_ITEMS, SEO_BATCH_MAX, sliceForRequests, mergeBatchResults, estimateRemainingMs,
} from '../src/lib/seoBatch.js';

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

// ── every tab the dock can render must be grantable, and granted by default ───
// Rob hit this exactly: the dock's SEO page never appeared because a new token's
// default scopes were chat/deploy/store and there was no way to change them, so
// the only fix was a new token and a new snippet on the site. A tab no token can
// render is a page the owner does not have.
const embedTabSrc = readFileSync(join(REPO, 'src/components/matrix/website/EmbedTab.jsx'), 'utf8');
// Its own reader rather than the one declared further down for the tab-strip
// checks: referencing that one here was a temporal-dead-zone error at load.
const embedForTabs = readFileSync(join(REPO, 'src/pages/Embed.jsx'), 'utf8');
const tabScopes = [...new Set([...embedForTabs.matchAll(/\{ scope: '([a-z]+)'/g)].map((m) => m[1]))];
const tickable = [...embedTabSrc.matchAll(/\{ id: '([a-z]+)', label:/g)].map((m) => m[1]);
const defaultsBlock = embedTabSrc.match(/useState\((ALL_SCOPES[^)]*)\)/);
check('the dock declares tabs (parser sanity)', tabScopes.length >= 4, true);
check('the tickable scope list was parsed (parser sanity)', tickable.length >= 4, true);
// Every scope a tab needs can be ticked on…
check('every dock tab has a grantable scope', tabScopes.filter((sc) => !tickable.includes(sc)), []);
// …and a NEW token gets them all, so the default is never what limits the dock.
check('a new token defaults to every scope, not a subset', /useState\(ALL_SCOPES\.map/.test(embedTabSrc), true);
check('…which is every tickable scope', defaultsBlock ? true : false, true);

// ── the scope editor must not be a way for a token to widen itself ───────────
// Rob's ask was "let me add a scope to an existing token rather than mint a new
// one and re-paste the snippet". The token STRING stays the same, which is the
// point — and which is also why the function that changes scopes must be
// unreachable with a token.
const tokenLib = readFileSync(join(REPO, 'server/src/lib/widgetToken.js'), 'utf8');
const updateFn = readFileSync(join(REPO, 'server/src/functions/updateWidgetToken.js'), 'utf8');
// The update function's own body. Claims about "the scope change" must be made
// about THIS code: a file-wide regex also matches createWidgetToken, which has
// the same filter for a different reason, and one mutation proved that a check
// written that way passes while the new function loses its filter.
const updateBody = tokenLib.slice(
  tokenLib.indexOf('export async function updateWidgetTokenScopes'),
  tokenLib.indexOf('export async function revokeWidgetToken'),
);
const scopeMapBlock = tokenLib.slice(tokenLib.indexOf('WIDGET_SCOPE_FUNCTIONS = {'), tokenLib.indexOf('};', tokenLib.indexOf('WIDGET_SCOPE_FUNCTIONS = {')));
// The allow-list is what makes a new function unreachable by default: anything
// not named in a scope is owner-session-only.
check('a token cannot call the scope editor (no self-escalation)', /updateWidgetToken/.test(scopeMapBlock), false);
check('…nor can it call any other token-management function',
  ['createWidgetToken', 'revokeWidgetToken', 'listWidgetTokens'].some((f) => scopeMapBlock.includes(`'${f}'`)), false);
// Unknown scope names are dropped, never stored, so a crafted request cannot
// introduce a scope the server does not know.
check('an unknown scope is filtered out of the change', /hasOwnProperty\.call\(WIDGET_SCOPE_FUNCTIONS, s\)/.test(updateBody), true);
check('an empty scope list is refused rather than stored', /NO_SCOPES/.test(tokenLib), true);
// Scoped to the owner AND to live tokens: editing must not revive a revoked
// credential or touch someone else's row.
check('the update is scoped to the owner', /created_by_id: userId, revoked: false/.test(tokenLib), true);
check('…and to the project', /project_id: projectId/.test(tokenLib), true);
// The token string is not reissued — that is why the pasted snippet keeps
// working. Asserted on the update function's OWN body: `token_hash` also appears
// further down in resolveWidgetToken, where it is a READ used to authenticate,
// and a crude slice-to-end-of-file check failed on that.
check('the update function was isolated (parser sanity)', updateBody.length > 200, true);
check('the secret is NOT regenerated by a scope change', /token_hash|hash\(secret\)/.test(updateBody), false);
check('…only the scopes column is written', /data: \{ scopes: clean\.join\(','\) \}/.test(updateBody), true);
check('the handler requires the caller to own the project', /created_by_id: user\.id/.test(updateFn), true);
check('…and says so when the token is not theirs to change', /NO_SUCH_TOKEN/.test(tokenLib), true);

// ── the hard limits, asserted so they cannot be relaxed by accident ──────────
// A widget token must never reach Morpheus's own development functions.
const routes = readFileSync(join(REPO, 'server/src/routes/functions.routes.js'), 'utf8');
check('admin/self-dev functions are refused for widget tokens', /ADMIN_FUNCTIONS\.has\(name\) \|\| !widgetMayCall\(req\.widget\.scopes, name\)/.test(routes), true);
check('…and the self-dev names are still in that set', /ADMIN_FUNCTIONS = new Set\(\[[^\]]*pushSelfDevToGithub/.test(routes), true);
// An OAuth handshake from an embedded page is not something the owner consented
// to, so every connect route refuses widget tokens.
const connRoutes = readFileSync(join(REPO, 'server/src/routes/connections.routes.js'), 'utf8');
const routeLines = connRoutes.split('\n').filter((l) => /^router\.(get|delete)\(/.test(l));
const starts = routeLines.filter((l) => /\/start'/.test(l) || /^router\.delete\(/.test(l));
const callbacks = routeLines.filter((l) => /callback'/.test(l));
check('there are connect routes to check (parser sanity)', starts.length >= 4, true);
check('every connect START and every disconnect refuses widget tokens', starts.filter((l) => !/blockWidget/.test(l)).map((l) => l.slice(0, 60)), []);
check('…and requires the owner\'s session', starts.filter((l) => !/requireAuth/.test(l)).map((l) => l.slice(0, 60)), []);
// A callback is a redirect from the provider — there is no bearer token to carry,
// so it authenticates from the SIGNED STATE instead, and `blockWidget` there would
// be a no-op that reads as a safeguard. What must be true is that it verifies state.
check('callbacks do not pretend to be widget-guarded (parser sanity)', callbacks.length >= 3, true);
check('every callback recovers identity from a signed state', /jwt\.verify\(state/.test(connRoutes), true);
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

// ── the tab strips must WRAP, not scroll tabs out of reach ──────────────────
// A tab you cannot see is a tab you do not have. The SEO tab is 6th of 7 in the
// website panel and 5th of 5 in the widget, so it is the first casualty when the
// strip runs off the screen — which is what happened on a phone: with
// `overflow-x-auto` the panel put PAGES/SEO/EMBED outside the visible area at
// 390px and four tabs out at 260px, with nothing on screen saying they existed.
// Measured in a real browser at 390/340/300/260px. Both strips now wrap to a
// second line, so every tab is reachable without a gesture nobody knows about.
const panelSrc2 = readFileSync(join(REPO, 'src/components/matrix/WebsitePanel.jsx'), 'utf8');
const embedSrc = readFileSync(join(REPO, 'src/pages/Embed.jsx'), 'utf8');
const stripClass = (src, marker) => {
  const at = src.indexOf(marker);
  if (at < 0) return '';
  const m = [...src.slice(0, at).matchAll(/className="([^"]+)"/g)].pop();
  return m ? m[1] : '';
};
const panelStrip = stripClass(panelSrc2, '{TABS.map(');
const widgetStrip = stripClass(embedSrc, '{tabs.map(');
check('the panel tab strip was found (parser sanity)', panelStrip.includes('flex'), true);
check('the widget tab strip was found (parser sanity)', widgetStrip.includes('flex'), true);
check('the panel tab strip wraps', /flex-wrap/.test(panelStrip), true);
check('…and no longer scrolls tabs out of view', /overflow-x-auto/.test(panelStrip), false);
check('the widget tab strip wraps', /flex-wrap/.test(widgetStrip), true);
// Tabs need a minimum width or they squeeze into unreadable slivers rather than
// wrapping — which is what `flex-1` did: 50px buttons at 260px. The width lives
// on the BUTTON (a template literal inside the map), so assert the region after
// the marker rather than the container's own className.
const stripRegion = (src, marker) => {
  const at = src.indexOf(marker);
  return at < 0 ? '' : src.slice(at, at + 900);
};
check('panel tabs keep their minimum width', /basis-\[96px\]/.test(stripRegion(panelSrc2, '{TABS.map(')), true);
check('widget tabs keep their minimum width', /basis-\[84px\]/.test(stripRegion(embedSrc, '{tabs.map(')), true);

// ── 5. a batch is split into calls that can each finish ─────────────────────
//
// The bug this pins: "generate for every published item missing metadata" sent
// up to MAX_BATCH items in ONE call whose output cap was 900 + n*260 — sized
// from the JSON alone, with nothing reserved for the model's hidden reasoning.
// On the deployed model the reasoning spends that budget before any visible text
// is emitted, so a full batch returned finish_reason 'length' and the panel
// showed OUTPUT_TRUNCATED ("the AI response was cut off by the token limit").
// A guard, not a comment: the arithmetic below fails if the floor is removed or
// a whole batch is put back into one call.
console.log('\n5. a batch is split into calls that can each finish');

const twentyFive = Array.from({ length: MAX_BATCH }, (_, i) => ({ id: 1000 + i, title: `Item ${i}` }));
const chunks = chunkSeoItems(twentyFive);

check('the batch cap is more than one call\'s worth', SEO_ITEMS_PER_CALL < MAX_BATCH, true);
check('a full batch really is split', chunks.length > 1, true);
check('no call exceeds the per-call item limit', chunks.every((c) => c.length <= SEO_ITEMS_PER_CALL), true);
// A partition, not a filter: a chunker that dropped an item would look like the
// model "not returning a suggestion", which is how a silent loss gets shipped.
check('every item survives the split, exactly once', chunks.flat().length === twentyFive.length, true);
check('…and in order', chunks.flat().every((it, i) => it.id === twentyFive[i].id), true);
check('ids are unique after the split', new Set(chunks.flat().map((it) => it.id)).size === twentyFive.length, true);
check('an empty batch asks for no calls', chunkSeoItems([]).length, 0);
check('one item asks for one call', chunkSeoItems([{ id: 1 }]).length, 1);

// The cap must cover the model's hidden reasoning AND the largest JSON the
// schema permits, for every batch size the caller may ask for. Worst-case JSON
// per item is derived from the hard limits the normaliser enforces, not guessed.
const worstCaseItemTokens = Math.ceil((TITLE_HARD_MAX + DESC_MAX + 60 + 80) / 4);
const caps = Array.from({ length: MAX_BATCH }, (_, i) => seoCallMaxTokens(i + 1));
check('no call is budgeted below the floor', caps.every((c) => c >= SEO_MIN_CALL_TOKENS), true);
check('no call exceeds the hard ceiling', caps.every((c) => c <= SEO_MAX_CALL_TOKENS), true);
check('the budget never shrinks as the batch grows', caps.every((c, i) => i === 0 || c >= caps[i - 1]), true);
check(
  'a full call can hold its worst-case JSON on top of the reasoning floor',
  seoCallMaxTokens(SEO_ITEMS_PER_CALL) - SEO_REASONING_FLOOR >= SEO_ITEMS_PER_CALL * worstCaseItemTokens,
  true,
);
// The old single-item cap (1160) is the one that failed first in the panel.
check('a single item is no longer budgeted below the old failing cap', seoCallMaxTokens(1) > 900 + 260, true);

// Responses come back one per call; the operator reviews one batch.
const merged = mergeSeoSuggestions([
  [{ id: 11, seo_title: 'A' }, { id: 12, seo_title: 'B' }],
  [{ id: 13, seo_title: 'C' }],
]);
check('suggestions from every call are kept', merged.map((s) => s.id), [11, 12, 13]);
check('a duplicate id keeps the first answer', mergeSeoSuggestions([[{ id: 7, seo_title: 'first' }], [{ id: 7, seo_title: 'second' }]])[0].seo_title, 'first');
check('an invented id is dropped on merge', mergeSeoSuggestions([[{ id: 'not-a-number', seo_title: 'x' }]]).length, 0);
check('an already-flat list merges too', mergeSeoSuggestions([{ id: 5, seo_title: 'E' }]).map((s) => s.id), [5]);
check('merging nothing is not an error', mergeSeoSuggestions([]).length, 0);

// The call site itself: the split is the fix, so assert the generator actually
// goes through the chunked runner — a helper nobody calls changes nothing.
const genSrc = read('server/src/functions/generateSeoMeta.js').replace(/^\s*\/\/.*$/gm, '');
check('the SEO batch generator routes through the chunked runner', has(genSrc, 'generateSeoInChunks('), true);
check('…and budgets each call from the reasoning-aware helper', has(genSrc, 'seoCallMaxTokens('), true);
check('…and no longer budgets the whole batch from the item count alone', has(genSrc, '900 + usable.length * 260'), false);
check('…and stitches the per-call responses back together', has(genSrc, 'mergeSeoSuggestions('), true);

// ── 6. the split/retry loop, driven for real ────────────────────────────────
//
// Group 5 asserts the arithmetic. This drives the loop with a fake asker, so the
// branch that actually recovers a truncated batch is executed rather than
// reasoned about — the halving is the part an off-by-one would break.
console.log('\n6. the split/retry loop, driven for real');

const sized = (chunk) => chunk.map((it) => ({ id: it.id, seo_title: `T${it.id}` }));
const truncatedError = () => new Error('OUTPUT_TRUNCATED (role=diagnosis, maxTokens=8000): The AI response was cut off by the token limit before it could finish.');

let cleanCalls = 0;
const cleanSizes = [];
const clean = await generateSeoInChunks(twentyFive, async (chunk) => {
  cleanCalls++;
  cleanSizes.push(chunk.length);
  return sized(chunk);
});
check('a clean batch answers every item', clean.length, twentyFive.length);
check('…in one call per chunk', cleanCalls, Math.ceil(twentyFive.length / SEO_ITEMS_PER_CALL));
check('…never above the per-call limit', cleanSizes.every((n) => n <= SEO_ITEMS_PER_CALL), true);

let splitCalls = 0;
const recovered = await generateSeoInChunks(twentyFive, async (chunk) => {
  splitCalls++;
  if (chunk.length > 2) throw truncatedError();
  return sized(chunk);
});
check('a truncated chunk is halved, not lost', recovered.length, twentyFive.length);
check('…with every id still answered exactly once', new Set(recovered.map((s) => s.id)).size, twentyFive.length);
check('…at a cost of no more than one call per item', splitCalls <= twentyFive.length, true);

// A real failure must not be mistaken for truncation and quietly shrunk.
let propagated = null;
try {
  await generateSeoInChunks(twentyFive, async () => { throw new Error('Could not reach https://shop.test — no response'); });
} catch (e) { propagated = e.message; }
check('a non-truncation failure propagates unchanged', propagated, 'Could not reach https://shop.test — no response');

// One item has nothing left to split: the caller gets to name it.
let gaveUp = null;
try {
  await generateSeoInChunks([{ id: 99, title: 'Long page' }], async () => { throw truncatedError(); }, {
    onGiveUp: (item) => Object.assign(new Error(`gave up on ${item.id}`), { status: 502 }),
  });
} catch (e) { gaveUp = { message: e.message, status: e.status }; }
check('a single item that still truncates is named', gaveUp?.message, 'gave up on 99');
check('…and carries a status the API layer can use', gaveUp?.status, 502);

let survived = null;
try {
  await generateSeoInChunks([{ id: 1 }], async () => { throw truncatedError(); });
} catch (e) { survived = /OUTPUT_TRUNCATED/.test(e.message); }
check('without a give-up handler the truncation error survives', survived, true);

// ── 7. a batch is requested in slices a single connection can survive ───────
//
// The bug this pins (2026-09-22): the panel sent up to 25 items in ONE request,
// which the server answered only after five sequential model calls. Each call is
// capped at 180s (ai.js AI_FETCH_TIMEOUT_MS) and the request returned no bytes
// until all of them finished, so the connection was cut long before the server
// could answer — the operator saw a bare "Failed to fetch" and a spinner that
// never resolved. The fix is an invariant, not a tuning value: ONE REQUEST MUST
// CARRY NO MORE THAN ONE MODEL CALL'S WORTH OF ITEMS. Slicing on the client also
// makes progress and the ETA measurable, which is why the timer lives there.
console.log('\n7. a batch is requested in slices one connection can survive');

const fortyOne = Array.from({ length: 41 }, (_, i) => ({ id: 2000 + i, title: `Item ${i}` }));
const slices = sliceForRequests(fortyOne);

// The contract across the boundary no compiler checks: if the client asked for
// more than the server's own chunk, the server would silently split it again and
// the request would go back to being multi-call — the original bug.
check('a client request is never more than the server call chunk', SEO_REQUEST_ITEMS <= SEO_ITEMS_PER_CALL, true);
// What one click generates must be applyable in one bulk write: the review list
// goes back through a single bulk_set_seo, which the server caps at 100 items by
// silently slicing the payload. Generating past that would look like a complete
// apply while dropping the rest.
check('one click stays within the server batch cap', SEO_BATCH_MAX <= MAX_BATCH, true);
check('one click\'s results fit a single bulk write', SEO_BATCH_MAX <= 100, true);
check('the 41-item case is more than one request', slices.length > 1, true);
check('no request exceeds the client slice size', slices.every((s) => s.length <= SEO_REQUEST_ITEMS), true);
// A partition, not a filter: dropping an item here would look like "the model
// didn't return a suggestion for that page".
check('every item is requested exactly once', slices.flat().length, fortyOne.length);
check('…and in order', slices.flat().every((it, i) => it.id === fortyOne[i].id), true);
check('the last slice holds the remainder', slices.at(-1).length, fortyOne.length % SEO_REQUEST_ITEMS || SEO_REQUEST_ITEMS);
check('an empty batch asks for nothing', sliceForRequests([]).length, 0);

// Stitching the per-request responses back into one review batch.
const mergedBatch = mergeBatchResults([
  { suggestions: [{ id: 1, seo_title: 'A' }, { id: 2, seo_title: 'B' }], requested: 5, generated: 2, missing: [3], title_only: 1, owns_head: true },
  { suggestions: [{ id: 3, seo_title: 'C' }], requested: 5, generated: 1, missing: [], title_only: 0, owns_head: true },
]);
check('suggestions from every request are kept', mergedBatch.suggestions.map((s) => s.id), [1, 2, 3]);
check('the review header counts every request', mergedBatch.generated, 3);
check('requested totals every request', mergedBatch.requested, 10);
check('the not-generated list is carried across', mergedBatch.missing, [3]);
check('title-only count is carried across', mergedBatch.title_only, 1);
check('a repeated id does not double-count', mergeBatchResults([
  { suggestions: [{ id: 7, seo_title: 'first' }], generated: 1 },
  { suggestions: [{ id: 7, seo_title: 'second' }], generated: 1 },
]).suggestions.map((s) => s.seo_title), ['first']);
check('merging nothing is not an error', mergeBatchResults([]).suggestions.length, 0);

// The ETA is measured, never invented: nothing is claimed before a slice has
// finished, and the projection uses the slices that actually ran.
check('no ETA is claimed before the first slice finishes', estimateRemainingMs({ done: 0, total: 9, elapsedMs: 40000 }), null);
check('the ETA extrapolates the slices that ran', estimateRemainingMs({ done: 2, total: 10, elapsedMs: 80000 }), 320000);
check('a finished loop has nothing left', estimateRemainingMs({ done: 10, total: 10, elapsedMs: 400000 }), 0);
check('an unknown total claims nothing', estimateRemainingMs({ done: 1, total: 0, elapsedMs: 5000 }), null);

// The call site: the panel must route the batch through the slicer, and must not
// put the whole missing list into one request again.
const seoPanelSrc = read('src/components/matrix/website/SeoTab.jsx').replace(/^\s*\/\/.*$/gm, '');
check('the SEO panel slices the batch', has(seoPanelSrc, 'sliceForRequests('), true);
check('…and stitches the responses back', has(seoPanelSrc, 'mergeBatchResults('), true);
check('…and bounds one click to what it can apply', has(seoPanelSrc, 'SEO_BATCH_MAX'), true);
check('…and no longer sends the whole batch in one request', has(seoPanelSrc, 'missing.slice(0, 25)'), false);
// The timer moved OUT of the tab and into the shared task runner (2026-09-24):
// a timer drawn by the tab stops being drawn the moment the operator leaves it,
// which is the bug the runner was built for. Asserted in both halves — the tab
// runs its actions through the runner, and the runner is what renders the clock.
check('…and its AI actions run under the shared task runner', has(seoPanelSrc, 'useTaskRunner()'), true);
check('…which is what shows the live timer', has(read('src/components/matrix/TaskRunner.jsx'), 'EtaTimer'), true);
check('…and the tab no longer draws one of its own', has(seoPanelSrc, 'EtaTimer'), false);

// ── the run survives a slice that does not answer ──────────────────────────
// Rob, 2026-09-23, on a 58-item run: "managed to do 10 before a network timeout",
// the app saying "Connection closed before Morpheus finished responding." Ten is
// two slices of five. The loop broke on the FIRST failure, so one hiccup cost
// every remaining slice — 10 done, 48 stranded. These assert the three parts of
// the fix, because each is separately droppable and each is invisible until a
// connection drops in production.
console.log('\nThe batch survives a slice that fails');
// Up to the batch merge, not to the first closing brace: the first `\n          }`
// is the end of the inner onStage arrow, which made this capture a fragment and
// fail five checks on its own tooling rather than on the code.
const batchLoop = (seoPanelSrc.match(/for \(let i = 0; i < slices\.length[\s\S]*?const merged = mergeBatchResults/) || [''])[0];
check('the batch loop was located (parser sanity)', batchLoop.length > 200, true);
// 1. a failed slice is retried before it counts as lost
check('a failed slice is retried once', /attempt < 2/.test(batchLoop), true);
check('…and the retry waits before trying again', /setTimeout\(res, 1500\)/.test(batchLoop), true);
// 2. the first failure no longer ends the run. The old form was a bare break in
//    the catch; asserting its absence is the point, not a style preference.
check('the first failure no longer ends the run',
  /catch \(e\) \{ failure = e; break; \}/.test(seoPanelSrc), false);
check('…it carries on to the remaining slices', /consecutiveFailures >= 2\) break;/.test(batchLoop) && /continue;/.test(batchLoop), true);
// THE RULE, not the string. Asserting that the old `catch (e) { …; break; }` is
// gone only catches that exact spelling: a mutation that broke early a different
// way passed it. Every `break` in this loop must be one of the two sanctioned
// exits — cancelled, or two failures in a row — so any other way of ending the
// run early fails here, however it is written.
const breakSites = [...batchLoop.matchAll(/break;/g)]
  .map((m) => batchLoop.slice(Math.max(0, m.index - 200), m.index));
check('every early exit from the batch loop is a sanctioned one (parser sanity)', breakSites.length >= 2, true);
check('…and no other break ends the run early',
  breakSites.filter((src) => !/cancelled\(\)/.test(src) && !/consecutiveFailures >= 2/.test(src)), []);
// 3. two in a row IS the end — the safety valve that stops hammering a dead server
check('two failures in a row stop the run', /consecutiveFailures >= 2\) break;/.test(batchLoop), true);
check('…and a success resets the run of failures', /consecutiveFailures = 0;/.test(batchLoop), true);
// 4. the note tells the truth about a gap in the middle rather than claiming a stop
check('the failed batches are reported to the operator',
  /did not answer — click again for those/.test(seoPanelSrc), true);
check('…and "stopped" is reserved for a run that actually stopped',
  /const stopped = cancelled\(\) \|\| consecutiveFailures >= 2;/.test(seoPanelSrc), true);
// The slice size is the other half: a request that is five model calls is long,
// and long is what gets cut. Asserted as a ceiling, not an exact value.
check('the per-request slice is small enough to finish inside the envelope',
  SEO_REQUEST_ITEMS <= 2, true);


// ── 7b. the batch streams, and both ends agree on the events ───────────────
//
// 2026-09-23, Rob: "the first batch of 5 started, the timer ran, the ETA never
// appeared, then Failed to fetch". One request was five sequential model calls
// with ZERO bytes written until all of them finished, so the connection looked
// idle and the ingress cut it — and a request cut before Express answers has no
// CORS headers, which is why the browser could only say "Failed to fetch". The
// fix is the shape chatWithMorpheus already had, so the contracts below are all
// about the two ends agreeing on that shape. Every one of them fails at runtime
// as a spinner that never moves, or an error message that says nothing.
console.log('\n7b. the batch streams, and both ends agree on the events');

const seoFn = read('server/src/functions/generateSeoMeta.js');
const apiSrc = read('src/api/base44Client.js');
const timingSrc = read('server/src/lib/timingStats.js');
// The per-role output estimates — including the `seo` entry this file asserts
// about — live in billingEstimate.js, not billing.js. They were MOVED there on
// 2026-09-23 so the rule could be tested as behaviour in CI's no-install guards
// job: billing.js reaches the Prisma client through db.js, and a guard that
// imported it would kill that job (the incident that created
// verify-guards-no-install.mjs). Reading billing.js here silently found nothing.
const billingSrc = read('server/src/lib/billingEstimate.js');
const chatFn = read('server/src/functions/chatWithMorpheus.js');
const aiSrc = read('server/src/ai.js');
// LINE comments only. A block-comment regex is not safe on a source file this
// size — chatWithMorpheus.js contains a `/*` inside a string, and stripping from
// there to the next `*/` deleted 60,000 characters and made the framing check
// fail on its own tooling. Every pattern below carries its own `type:` or `role:`
// prefix instead, so prose that merely describes the thing cannot satisfy it.
const stripJs = (src) => src.replace(/(^|\s)\/\/[^\n]*/g, '$1');
const seoFnCode = stripJs(seoFn);
const apiCode = stripJs(apiSrc);
const seoPanelStream = stripJs(read('src/components/matrix/website/SeoTab.jsx'));
const uniq = (list) => [...new Set(list)].sort();

// The vocabulary, parsed from EACH side rather than from a comment on either.
const serverEmits = uniq([...seoFnCode.matchAll(/type:\s*'([a-z]+)'/g)].map((m) => m[1]));
const clientActsOn = uniq([...(apiCode.match(/const handleLine = [\s\S]*?\n  \};/) || [''])[0]
  .matchAll(/(?:evt|finalEvent)\.type === '([a-z]+)'/g)].map((m) => m[1]));
check('the server emits events at all (parser sanity)', serverEmits.length >= 3, true);
check('the client acts on events at all (parser sanity)', clientActsOn.length >= 2, true);
check('every event the client acts on is one the server emits',
  clientActsOn.filter((t) => !serverEmits.includes(t)), []);
check('the server emits a terminal result', serverEmits.includes('result'), true);
check('the server emits a terminal error', serverEmits.includes('error'), true);
check('progress events are stage events', serverEmits.includes('stage'), true);
// A heartbeat is only safe because the reader ignores a type it does not know.
check('the server emits an event the client deliberately ignores', serverEmits.includes('ping'), true);
check('…and the client has no case for it, so it is ignored by construction',
  clientActsOn.includes('ping'), false);
// One stage event would mean the ETA is announced and then nothing moves.
check('the server emits more than one stage event', (seoFnCode.match(/type: 'stage'/g) || []).length >= 2, true);

// NDJSON, and the headers that keep a proxy from buffering it.
check('the handler writes NDJSON', has(seoFnCode, "application/x-ndjson"), true);
check('and tells the proxy not to buffer', has(seoFnCode, "'X-Accel-Buffering': 'no'"), true);
check('chat and the SEO batch frame it the same way',
  has(stripJs(chatFn), "application/x-ndjson") && has(seoFnCode, "application/x-ndjson"), true);

// The ETA is the SAME estimator chat uses, on a role of its own.
const estimates = (src) => /estimateCallMs\(\s*[A-Za-z_$]/.test(src);
check('chat\'s ETA comes from estimateCallMs', estimates(chatFn), true);
check('the SEO batch\'s ETA comes from the same function', estimates(seoFnCode), true);
check('the SEO handler imports that estimator, not a copy',
  /import \{[^}]*estimateCallMs[^}]*\} from '\.\.\/lib\/timingStats\.js'/.test(seoFn), true);
check('…and does not invent a number of its own', /etaSeconds:\s*\d{2,}/.test(seoFnCode), false);
// A null or missing ETA is the "estimating…" state the operator already saw
// forever; the event has to carry a real number.
check('the ETA is a rounded number of seconds', /etaSeconds:\s*Math\.round\(/.test(seoFnCode), true);
check('the SEO role has its own seed, so the first estimate is not the generic one',
  new RegExp(`\\b${SEO_AI_ROLE}:\\s*\\d+`).test(timingSrc), true);
check('the SEO role is recorded under that same name in ai.js', /recordCallDuration\(role,/.test(aiSrc), true);
check('…for every call, whatever the role', /if \(!role \|\| !Number\.isFinite\(ms\)/.test(timingSrc), true);
// The call site uses the CONSTANT, so the value can only be the one this guard
// imported — a second literal 'seo' in another file is how the three maps drift.
check('the SEO call passes that role to invokeAI',
  /role:\s*SEO_AI_ROLE\s*,/.test(seoFnCode), true);
check('…and that constant is the value the other maps are keyed by',
  SEO_AI_ROLE, 'seo');
// The whole point of the fork: it must NOT share the role four smaller callers use.
check('the SEO call no longer shares the diagnosis role', /role:\s*'diagnosis'/.test(seoFnCode), false);
check('the role it left is genuinely shared by others',
  (read('server/src/lib/contextSummary.js').includes("role: 'diagnosis'")
    && read('server/src/lib/deckMemory.js').includes("role: 'diagnosis'")), true);
// Forking the role must not silently re-price the call.
//
// UPDATED 2026-09-23, and the change is the point. This asserted `seo: 2000` —
// the number inherited from `diagnosis` — on the reasoning that a role fork must
// not change what a batch reserves. That reasoning was right and the number was
// wrong: the SEO call is capped at `seoCallMaxTokens(5)` = 8,000 output tokens,
// so reserving 2,000 was a 4x under-reservation against a HARD hold
// (`reserveCredits` throws 402, no overdraft grace) — it let through a call the
// balance could not cover. Rob: "Well raise it it needs to work."
//
// So the rule is no longer "the fork keeps the old number". It is "the
// reservation matches the call": the caller's own bound wins, and the per-role
// number is only a fallback for a caller that passed none. Both halves are
// asserted here because this file owns the SEO side; the estimator's own
// behaviour is covered in verify-billing-clamp.mjs.
const seoFallback = Number((billingSrc.match(/seo:\s*(\d+)/) || [])[1]);
check('the SEO fallback reserve is the SEO call cap, not the old inherited guess',
  seoFallback >= 8000, true);
check('and the diagnosis role is untouched by that change',
  /diagnosis:\s*2000\b/.test(billingSrc), true);
// The bar the number has to clear, taken from the code that sets it.
const seoCaps = [...read('server/src/lib/seoPrompts.js').matchAll(/SEO_MIN_CALL_TOKENS\s*=\s*(\d+)/g)].map((m) => Number(m[1]));
check('the fallback clears the SEO minimum cap (parser sanity)',
  seoCaps.length >= 1 && seoFallback >= seoCaps[0], true);
check('and the estimator prefers the caller\'s bound over any fallback',
  /Number\.isFinite\(cap\) && cap > 0\) return cap/.test(read('server/src/lib/billingEstimate.js')), true);
check('the role is overridable like the others',
  has(read('src/pages/AdminPanel.jsx'), `'${SEO_AI_ROLE}'`), true);

// NEGOTIATION. The client opts in; a caller that does not gets plain JSON.
check('the client opts in', /stream:\s*true/.test(seoPanelStream), true);
check('the server only streams when asked', /body\?\.stream === true/.test(seoFnCode), true);
check('…and otherwise runs the same work and returns it',
  /if \(!\(body\?\.stream === true\)[\s\S]{0,200}return run\(/.test(seoFnCode), true);
// A server that answers with one JSON object, while the client asked to stream,
// is what a deploy window looks like. The reader must not call that an error.
check('the reader still accepts a whole JSON payload',
  /finalEvent = \{ type: 'result', data: whole \}/.test(apiCode), true);
check('…and only when the object is not one of our events', /!whole\.type/.test(apiCode), true);

// A failure AFTER the first byte cannot set a status code, so it travels as the
// terminal event — and the client must turn that into the real message.
check('a streamed failure is emitted as the terminal event',
  /catch \(err\) \{[\s\S]{0,700}type: 'error'/.test(seoFnCode), true);
check('…carrying a message', /type: 'error',\s*\n\s*message:/.test(seoFnCode), true);
check('…and the field the client already reads for a function error',
  /error: err\?\.message/.test(seoFnCode), true);
check('the client turns a terminal error into a thrown error',
  /finalEvent\.type === 'error'/.test(apiCode) && /new Error\(finalEvent\.message/.test(apiCode), true);
check('the panel reads that wording back',
  has(seoPanelStream, 'failure?.data?.error'), true);

// BEFORE the first byte, a real status code — so cheap validation failures are
// not downgraded to a 200 with an error inside it.
const headAt = seoFnCode.indexOf('res.writeHead(');
check('the handler writes its head (parser sanity)', headAt > 0, true);
for (const [label, needle] of [
  ['a missing projectId', "throw Object.assign(new Error('projectId required')"],
  ['no items picked', "throw Object.assign(new Error('Pick at least one page or post to generate for.')"],
  ['too many items', 'Generate for at most'],
]) {
  const at = seoFnCode.indexOf(needle);
  check(`${label} is refused before the first byte`, at > 0 && at < headAt, true);
}
check('and the stream is opened before the model is called',
  headAt < seoFnCode.indexOf('await run('), true);

// ── 8. the site entity is emitted, and nothing partial is invented ─────────
//
// The bug this pins: emit_schema()'s doc-comment claimed "the site's own
// organization node on every page" and the code emitted no such node. With an
// SEO plugin gone, a site could carry a page node and NO site entity at all —
// which is what a live shop looked like. Asserted on the source here because CI
// has no PHP; the rendered head is asserted by tests/harness-noyoast.php, and
// the last check below keeps the two coupled.
console.log('\n8. the site entity is emitted, and nothing partial is invented');

const seoSrc = read('wp-plugin/morpheus/includes/seo/class-seo.php');
// Comments first: this file explains the rules in prose, and the prose names the
// very fields the assertions below require to be ABSENT. (The traffic guard was
// caught by exactly this — it failed on the sentence documenting its own rule.)
const seoCode = seoSrc
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  .replace(/^\s*#[^\n]*/gm, '');

check('the schema emitter builds an Organization node', /'@type'\s*=>\s*'Organization'/.test(seoCode), true);
check('…and a WebSite node', /'@type'\s*=>\s*'WebSite'/.test(seoCode), true);
check('…whose SearchAction is declared with its query-input', /'query-input'\s*=>\s*'required name=search_term_string'/.test(seoCode), true);
// Every field traces to a real setting: no invented names, URLs or logos.
check('the site name comes from WordPress', has(seoCode, "get_bloginfo( 'name' )"), true);
check('the site URL comes from home_url', has(seoCode, "home_url( '/' )"), true);
check('the logo comes from the Site Icon', has(seoCode, 'get_site_icon_url('), true);
check('…and is omitted rather than emitted empty', /if \( \$logo !== '' \)/.test(seoCode), true);
check('the nodes are serialised as JSON, not hand-built', has(seoCode, 'wp_json_encode( $nodes )'), true);

// The rule: never a partial entity, never an invented number.
check('no LocalBusiness node is emitted', has(seoCode, 'LocalBusiness'), false);
check('no aggregateRating is invented', has(seoCode, 'aggregateRating'), false);
check('no priceRange is invented', has(seoCode, 'priceRange'), false);
check('no review count is invented', has(seoCode, 'reviewCount'), false);

// The real test lives in the harness (PHP, run under WordPress Playground, not
// in CI). Coupling them means the rendered assertions cannot be deleted while
// this one still passes.
const noYoastHarness = read('wp-plugin/morpheus/tests/harness-noyoast.php');
check('the no-Yoast harness asserts the Organization node renders', has(noYoastHarness, 'the head carries an Organization node'), true);
check('…and asserts no LocalBusiness renders', has(noYoastHarness, 'no LocalBusiness node is emitted'), true);
check('…and asserts every JSON-LD block parses', has(noYoastHarness, 'every JSON-LD block parses as JSON'), true);

// ⭐ AND THE SHAPE OF THE NODE LIST — the defect that shipped on every page of every site.
//
// `emit_schema()` appended `site_entity_nodes()` (a LIST of two nodes) as a single element, so the head
// carried `[{…WebPage…},[{…Organization…},{…WebSite…}]]`. Every check above is satisfied by that shape: all
// three `@type` strings are present, and a nested array is valid JSON. It was live from 0.7.1 until
// 2026-10-08 and was found by reading the live bytes, not by any gate.
//
// These pin the exact regression rather than a spelling: a `foreach` that copies the list in element by
// element is correct behaviour and must stay green, so the negative check names the append that was the bug.
// The rendered shape is asserted in tests/harness-noyoast.php, and the coupling below keeps that assertion
// from being deleted while this one still passes.
check('the site node LIST is never appended as one element (the 2026-10-08 defect)',
  /\$nodes\[\]\s*=\s*\$site\b/.test(seoCode), false);
check('…the page node and the site nodes are merged into ONE flat list',
  /array_merge\(\s*array\(\s*\$node\s*\)\s*,\s*self::site_entity_nodes\(\)\s*\)/.test(seoCode), true);
check('…and the harness refuses a nested node list', has(noYoastHarness, 'no JSON-LD node list is nested inside another'), true);
check('…and asserts the three nodes are top-level siblings', has(noYoastHarness, 'three TOP-LEVEL nodes'), true);

// ── 8b. the panel works on the SITE's content types, not a hard-coded three ──
//
// The live failure: the store publishes a `services` CPT whose head tags WERE
// emitted (`emit_head()` keys off `is_singular()`) while the panel could not list,
// audit or bulk-fill it, because the set of types was the constant
// `array( 'post', 'page', 'product' )`. Live symptom: `/services/equipment-repairs/`
// carried a description built from its own first words including "Home / Services /",
// with nothing in the panel able to say so.
//
// ⚠️ THE SAME THEME ALSO PUBLISHES A `portfolio` ARCHIVE, AND IT IS NOT INCLUDED —
// deliberately, and measured rather than assumed. WordPress builds its sitemap from
// types it is told are public, and live `/wp-sitemap-posts-services-1.xml` answers
// 200 while `…-portfolio-1.xml` answers 404. So `portfolio` is a type the site keeps
// off the public web; the derivation respects that instead of overriding it. If Rob
// decides the panel should work on it anyway, both this and the helper's doc change
// together.
//
// Source contracts here; `tests/harness-noyoast.php` registers a real CPT and
// asserts the DEFAULT list and context include it, and the coupling below keeps
// that from being deleted.
console.log('\n8b. the panel works on the site\'s own content types');
const seoHelperCode = read('wp-plugin/morpheus/includes/helpers.php')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  .replace(/^\s*#[^\n]*/gm, '');
check('the SEO module no longer declares a post-type constant', /const POST_TYPES\s*=/.test(seoCode), false);
check('…no call site still reads the old constant', /self::POST_TYPES/.test(seoCode), false);
check('…and no hard-coded three-type list survives in it', /array\(\s*'post'\s*,\s*'page'\s*,\s*'product'\s*\)/.test(seoCode), false);
check('…it derives them from the site instead', /morpheus_public_post_types\(\)/.test(seoCode), true);
check('the shared helper exists', /function morpheus_public_post_types\s*\(/.test(seoHelperCode), true);
check('…and asks WordPress for the PUBLIC types', /get_post_types\(\s*array\(\s*'public'\s*=>\s*true\s*\)/.test(seoHelperCode), true);
check('…keeping attachments out of the content set', /'attachment'/.test(seoHelperCode), true);
check('…and the harness proves it with a post type of the site\'s own', has(noYoastHarness, 'is one of the types the panel works on'), true);
check('…including the DEFAULT list the panel actually gets', has(noYoastHarness, 'appears in the SEO list by DEFAULT'), true);

// ── 9. robots.txt advertises a sitemap that exists ─────────────────────────
//
// The live failure: a site removed Yoast, `/sitemap_index.xml` started 404ing,
// and a month-cached robots.txt kept advertising it while core's real sitemap
// went unadvertised. The filter used to defer to ANY existing Sitemap line,
// including a dead one. Rendered behaviour is asserted in
// tests/harness-noyoast.php; these are the source contracts CI can check.
console.log('\n9. robots.txt advertises a sitemap that exists');

/** The body of a named function, comment-stripped source, for scoped assertions. */
const fnBody = (src, name) => {
  const at = src.indexOf(`function ${name}(`);
  if (at < 0) return '';
  const rest = src.slice(at);
  const end = rest.indexOf('\n\t}');
  return end < 0 ? rest : rest.slice(0, end);
};

const robotsFn = fnBody(seoCode, 'filter_robots_txt');
const deadFn = fnBody(seoCode, 'sitemap_url_is_dead');
const redirFn = fnBody(seoCode, 'register_legacy_sitemap_redirect');
const bootFn = fnBody(seoCode, 'bootstrap');

check('the robots filter parses Sitemap lines (parser sanity)', /preg_match\([^)]*Sitemap:/.test(robotsFn), true);
check('…and drops a line it can prove is dead', has(robotsFn, 'sitemap_url_is_dead('), true);
check('…while keeping every live one', has(robotsFn, '$live++'), true);
check('the dead-path test only judges attributable SEO-plugin paths', has(deadFn, "/sitemap_index.xml' => array( 'yoast', 'rankmath' )"), true);
check('…and refuses another host', /url_host[^\n]*!==[^\n]*host/.test(deadFn), true);
check('…and never fetches over HTTP to decide (robots is served on every crawl)', has(deadFn, 'wp_remote_get'), false);
check('…and is only dead when that plugin is not the active one', has(deadFn, 'in_array( self::active_plugin(), $owned[ $path ], true )'), true);
check('the legacy path is redirected, not left 404ing', has(redirFn, "add_rewrite_rule( '^sitemap_index\\.xml$'"), true);
check('…and only while Morpheus owns the head', has(redirFn, 'if ( ! self::owns_head() )'), true);
check('…with a 301 to the sitemap core actually serves', has(seoCode, "wp_safe_redirect( home_url( '/wp-sitemap.xml' ), 301 )"), true);
check('the bootstrap registers both the rule and the redirect hook', has(bootFn, 'register_legacy_sitemap_redirect()') && has(bootFn, 'maybe_redirect_legacy_sitemap'), true);

// Coupled to the rendered assertions, so the harness cases cannot be deleted
// while this still passes.
check('the harness asserts a dead sitemap line is removed', has(noYoastHarness, 'a dead attributable Sitemap line is removed'), true);
check('…and that a live line survives', has(noYoastHarness, 'a live line survives'), true);
check('…and that another host is left alone', has(noYoastHarness, 'a sitemap on another host is left alone'), true);

// ── 10. a stale physical robots.txt is QUARANTINED, never deleted ──────────
//
// WHY THIS SECTION IS IN THIS FILE AND NOT verify-site-health.mjs.
//
// The subject is robots.txt: the same subject as section 9, the same plugin
// file, and the same harness boot (harness-noyoast.php, the one with no SEO
// plugin, which is also the only boot where Morpheus owns the head). This file
// also already owns the JS↔PHP contract for the SEO module (section 4). A
// health screen's own rules — no score, sources, update staleness — are a
// different subject and stay in verify-site-health.mjs.
//
// CI HAS NO PHP. Everything about the DECISION and the FILE MOVE is therefore
// asserted here from the source, and by name against the rendered assertions in
// tests/harness-noyoast.php, which runs under WordPress Playground. That
// coupling is the point: the harness cases cannot be deleted while this passes,
// and this cannot be satisfied by prose.
console.log('\n10. a stale physical robots.txt is quarantined, never deleted');

const fixesSrc = read('wp-plugin/morpheus/includes/class-fixes.php');
const fixesCode = fixesSrc
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const healthSrc = read('wp-plugin/morpheus/includes/class-health.php');
// Comments first, for the same reason as seoCode above: this file explains its
// rules in prose, and the prose names the very call the assertions below require.
const healthCode = healthSrc
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

// ── the judgement ───────────────────────────────────────────────────────────

const stateFn = fnBody(seoCode, 'robots_txt_state');
const dynFn = fnBody(seoCode, 'dynamic_sitemap_urls');
const fetchFn = fnBody(seoCode, 'fetch_url');
// A regex that matches nothing would make the rest of this group pass by
// accident, so the parse is asserted first.
check('the robots state function was parsed (parser sanity)', stateFn.length > 400, true);
check('…and the sitemap-source function', dynFn.length > 0, true);

// 1. A physical file at ABSPATH, and it must be the SERVED one.
check('detection starts from the file at ABSPATH', has(stateFn, 'ABSPATH . self::ROBOTS_FILE'), true);
check('…and only when a physical file is there at all', /if \( ! file_exists\( \$file \) \) \{/.test(stateFn), true);
check('…and asks the site what it serves at /robots.txt', has(stateFn, 'self::fetch_robots_txt()'), true);
check('…comparing those bytes with the bytes on disk', /bodies_match\( \$body, \$served \)/.test(stateFn), true);
check('…and deciding NOTHING when the site does not answer', /null === \$served[\s\S]{0,120}?return null;/.test(stateFn), true);
check('…so a file that is not served is not a finding', /! self::bodies_match\( \$body, \$served \) \)[\s\S]{0,80}?return \$base;/.test(stateFn), true);
// The read decides whether a FILE IS MOVED, so one blip must not decide it: a
// 5xx is "the site did not answer", and the answer is asked for more than once.
const robotsFetchFn = fnBody(seoCode, 'fetch_robots_txt');
check('the retrying read was parsed (parser sanity)', robotsFetchFn.length > 100, true);
check('the read retries before concluding the site did not answer', has(robotsFetchFn, 'ROBOTS_FETCH_ATTEMPTS'), true);
check('…treating a 5xx as no answer rather than as one', has(fetchFn, 'if ( $code < 500 )'), true);
check('…with a bounded ceiling', /FETCH_MAX_ATTEMPTS = 5;/.test(seoCode), true);
check('…and an unreadable file is not a finding either', /! is_string\( \$body \)[\s\S]{0,80}?return null;/.test(stateFn), true);

// 2. Staleness, judged against the sitemap the site actually serves.
check('staleness (a): each advertised sitemap is fetched', /200 !== self::fetch_url\( \$url, false \)\['code'\]/.test(stateFn), true);
// The URL the file NAMES is the thing judged. Following a redirect would let a
// 301 to any 200 page read as a working sitemap — and would call the live site
// healthy, because this plugin's own legacy-sitemap redirect turns the removed
// plugin's path into a 301.
check('…without following a redirect (a redirect is not "that sitemap answers")', (stateFn.match(/self::fetch_url\( \$url, false \)/g) || []).length, 2);
check('…while the robots.txt fetch itself DOES follow one', has(fetchFn, '$follow ? 2 : 0'), true);
check('staleness (b): the site\'s own sitemap is asked of the filter chain', has(stateFn, 'dynamic_sitemap_urls()'), true);
check('…not hard-coded to /wp-sitemap.xml', has(dynFn, "apply_filters( 'robots_txt'"), true);
check('…so a site whose SEO plugin serves another path is judged correctly', has(dynFn, 'sitemap_urls_in('), true);
check('clause (a) fires on a dead advertised sitemap', /if \( \$dead \) \{\s*\n\s*\$base\['stale'\]\s*=\s*true;/.test(stateFn), true);
check('clause (b) needs the site\'s own sitemap to be live', has(stateFn, '$base[\'missing_site_sitemap\'] && 0 === $live_advertised'), true);
check('a private site is not judged at all (nothing to advertise)', has(stateFn, '! $public'), true);
// Never a request from the robots filter itself: robots.txt is served on every
// crawl, which is why sitemap_url_is_dead() judges by attribution instead.
check('the fetch is NOT reachable from the robots filter', has(seoCode.slice(seoCode.indexOf('function filter_robots_txt'), seoCode.indexOf('function sitemap_url_is_dead')), 'fetch_url('), false);

// 3. The finding, its reason, and its action.
const robotsCheck = fnBody(healthCode, 'robots_check');
check('the health scan builds the check (parser sanity)', robotsCheck.length > 0, true);
// `healthCode`, not `healthSrc`: the prose above the call names it too, and a
// check a comment can satisfy is not a check.
check('the scan asks the SEO module for the state', has(healthCode, 'Morpheus_SEO::robots_txt_state()'), true);
check('the finding id is the one the app sends back', has(robotsCheck, `'${ROBOTS_FINDING_ID}'`), true);
// And the SAME string in both halves of the plugin: a scan that reports an id
// the registry does not know shows the operator a problem with no action, and
// /fix answers NO_FIX — the silent gap this registry exists to close.
check('…and the fix registry answers for that exact id', new RegExp(`'${ROBOTS_FINDING_ID}'\\s*=>\\s*array\\(`).test(fixesCode), true);
check('a stale served file is `recommended`', /'status'\s*=>\s*'recommended'/.test(robotsCheck), true);
check('every other outcome is `good`, not silent', (robotsCheck.match(/'status'\s*=>\s*'good'/g) || []).length, 3);
// The reason travels as the finding's own description — the site's words, not a
// generic "something is wrong".
check('the stale branch carries the reason', /'status'\s*=>\s*'recommended',\s*\n\s*'description'\s*=>\s*\(string\) \$state\['reason'\]/.test(robotsCheck), true);

// 4. THE FIX — quarantine, not delete.
const quarantineFn = fnBody(fixesCode, 'fix_quarantine_robots_txt');
check('the quarantine handler was parsed (parser sanity)', quarantineFn.length > 600, true);
check('the registry registers the finding as automatic', /'morpheus_stale_robots_txt'\s*=>\s*array\(\s*'kind'\s*=>\s*'auto'/.test(fixesCode), true);
// The silent failure this catches: a registry naming a mechanism the switch
// does not handle answers NO_MECHANISM at runtime and looks like a site bug.
// The case now ASSIGNS and breaks (every mechanism's result is recorded before
// it is returned, so the shared refusal record cannot be skipped), so the
// assertion is on that shape rather than on an immediate `return`.
check('…naming a mechanism the switch actually handles', /'fix'\s*=>\s*'quarantine_robots_txt'/.test(fixesCode) && /case 'quarantine_robots_txt':\s*\n\s*\$result = self::fix_quarantine_robots_txt\( \$id \);/.test(fixesCode), true);

check('the fix RENAMES the file', has(quarantineFn, '@rename( $file, $backup )'), true);
check('…and never deletes anything', /@?unlink\s*\(/.test(quarantineFn), false);
check('…and never writes over anything either', /file_put_contents/.test(quarantineFn), false);
check('the backup sits beside the file, under a UTC timestamp', has(fixesCode, "'.morpheus-bak-' . gmdate( 'YmdHis' )"), true);
// Each refusal is asserted WITH the condition that reaches it: the literal
// alone would still be "present" inside a branch that can never run, which is
// exactly the shape that passes while the behaviour is gone.
check('an existing backup is never overwritten (the only undo)', /if \( file_exists\( \$backup \) \) \{[\s\S]{0,140}?'BACKUP_EXISTS'/.test(quarantineFn), true);
check('the fix refuses a file that is no longer there', /if \( empty\( \$state\['physical'\] \) \) \{[\s\S]{0,140}?'NO_FILE'/.test(quarantineFn), true);
check('…and one that is not the file being served', /if \( empty\( \$state\['served'\] \) \) \{[\s\S]{0,140}?'NOT_SERVED'/.test(quarantineFn), true);
check('…re-asking the question rather than trusting a cached scan', has(quarantineFn, 'Morpheus_SEO::robots_txt_state()'), true);
check('the deny-list is consulted before anything moves', /morpheus_is_denied\( Morpheus_SEO::ROBOTS_FILE \)/.test(quarantineFn), true);

// 5. VERIFY, then ROLL BACK. Both halves, because "verified" is the claim the
// panel turns into "Done".
const verifyFn = fnBody(fixesCode, 'verify_quarantined_robots');
check('the verifier was parsed (parser sanity)', verifyFn.length > 400, true);
check('verification re-fetches the live /robots.txt', has(verifyFn, "home_url( '/robots.txt' )") && has(verifyFn, 'Morpheus_SEO::fetch_robots_txt()'), true);
check('…requires the old body to be gone', /if \( Morpheus_SEO::bodies_match\( \$previous, \$live \) \) \{\s*\n\s*return array\( 'ok' => false/.test(verifyFn), true);
// AND IT IS DECIDED BEFORE THE SITEMAP CLAUSE. Order is load-bearing, not
// cosmetic: a site still serving the old bytes whose body also advertises a live
// sitemap has nothing for the sitemap clause to complain about, so if that
// clause ran first the still-serving comparison would never be reached and the
// fix would be reported VERIFIED while the file was still being served. The
// `lastIndexOf` is deliberate — the same comparison also appears once in the
// cache-buster branch above, and it is the LATER one that must precede `$missing`.
check('…and the still-serving test precedes the sitemap clause (or a still-served body with a live sitemap slips through)',
  verifyFn.lastIndexOf('Morpheus_SEO::bodies_match( $previous, $live )') < verifyFn.indexOf('$missing = array();'), true);
check('…requires every sitemap the site serves to be advertised', has(verifyFn, 'dynamic_sitemap_urls()') && has(verifyFn, 'advertises( $live,'), true);
check('…and cannot confirm anything from a site that will not answer', /null === \$live/.test(verifyFn), true);
check('…retries behind a cache-buster before calling it a failure', has(verifyFn, 'morpheus-verify'), true);
check('the handler calls the verifier', has(quarantineFn, 'verify_quarantined_robots( $before )'), true);
check('ROLLBACK: the backup is renamed straight back', has(quarantineFn, '@rename( $backup, $file )'), true);
check('…and only when verification failed', /if \( empty\( \$verdict\['ok'\] \) \) \{/.test(quarantineFn), true);
check('…with the reason, and whether the file is back', has(quarantineFn, "'NOT_VERIFIED'") && /'restored'\s*=>\s*\(bool\) \$put_back,/.test(quarantineFn) && has(quarantineFn, "\$verdict['why']"), true);
// The undo is only a field the panel can state if the plugin sends it.
check('the outcome names the backup on BOTH paths', (quarantineFn.match(/'backup'\s*=>\s*\$backup,/g) || []).length, 2);

// 6. The deny-list is intact: this feature must not have widened it.
const helpersSrc = read('wp-plugin/morpheus/includes/helpers.php');
const denyBlock = helpersSrc.match(/function morpheus_is_denied[\s\S]*?\n\}/);
check('the deny-list was parsed (parser sanity)', !!denyBlock && denyBlock[0].length > 200, true);
check('robots.txt is NOT on the deny-list (the fix reads it, so it must be)', /robots/i.test(denyBlock ? denyBlock[0] : ''), false);

// ── the cross-boundary contract ─────────────────────────────────────────────
//
// The app echoes back whatever id the scan produced, so a rename on the plugin
// side does not error — it quietly stops the app recognising the fix, and the
// operator loses the undo path from the panel while everything reports success.
check('the app\'s finding id is the plugin\'s', ROBOTS_FINDING_ID, 'morpheus_stale_robots_txt');
check('…and that id really is in the plugin\'s registry', fixesCode.includes(`'${ROBOTS_FINDING_ID}'`), true);
check('the app\'s backup prefix is the plugin\'s', ROBOTS_BACKUP_PREFIX, 'robots.txt.morpheus-bak-');
check('…and the plugin\'s own name format is 14 UTC digits', /'\.morpheus-bak-' \. gmdate\( 'YmdHis' \);/.test(fixesCode), true);

// The app's side of the drive: the FIX button reaches the one signed /fix route.
const fnSrc = read('server/src/functions/siteHealth.js');
// The action set is PARSED, not pinned: it grew again when CLEAN MY SITE arrived
// (`clean`), and a literal list fails for the wrong reason every time. What this
// assertion owns is that the FIX action exists and is declared in the one set;
// verify-clean-site.mjs owns whether the new member is safe.
const actionSet = fnSrc.match(/const ACTIONS = new Set\(\[([^\]]*)\]\)/);
const actions = actionSet ? [...actionSet[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]) : [];
check('the app has a fix action', /action === 'fix'/.test(fnSrc) && actions.includes('fix'), true);
check('…and the robots quarantine is reachable through the signed routes it names', actions.includes('scan') && actions.includes('fix'), true);
check('…which sends the site\'s own finding id, not a mechanism name', /body\?\.finding \|\| body\?\.id/.test(fnSrc), true);
check('…to the plugin\'s /fix route', /wpFix\(conn, finding, proposal\)/.test(fnSrc)
  && /wpCall\(conn, 'fix', proposal \? \{ id, proposal \} : \{ id \}\)/.test(read('server/src/lib/wpPlugin.js')), true);
check('…and the plugin registers that route (signed)', /register_rest_route\( MORPHEUS_REST_NS, '\/fix'/.test(read('wp-plugin/morpheus/includes/class-rest.php')), true);
check('the app reads the quarantine evidence out of the result', /quarantineEvidence\(res\.data, finding\)/.test(fnSrc), true);

// ── the pure module's behaviour ─────────────────────────────────────────────
const backup = backupName(new Date(Date.UTC(2026, 8, 23, 16, 2, 0)));
check('the backup name is the documented shape', backup, 'robots.txt.morpheus-bak-20260923160200');
check('…and is recognised as one', isBackupName(backup), true);
check('a near-miss name is NOT one', isBackupName('robots.txt.morpheus-bak-20260923'), false);
check('…nor is a plain .bak', isBackupName('robots.txt.bak'), false);
check('a Windows path still yields the basename', backupBasename(`C:\\site\\${backup}`), backup);
// The gate that stops an arbitrary path being treated as the operator's undo.
check('a path whose basename is not a backup name yields nothing', backupBasename('/srv/site/robots.txt'), '');

const quarantined = quarantineEvidence({ backup: `/srv/site/${backup}`, verified: true, restored: false }, ROBOTS_FINDING_ID);
check('a verified quarantine yields the undo path', quarantined?.name, backup);
check('…and is reported as quarantined', quarantined?.quarantined, true);
check('…which the panel states in words', /robots\.txt\.morpheus-bak-20260923160200/.test(undoLine(quarantined) || ''), true);
// A rollback must never read as "your site changed".
const rolledBack = quarantineEvidence({ backup: `/srv/site/${backup}`, verified: false, restored: true }, ROBOTS_FINDING_ID);
check('a rollback is NOT reported as quarantined', rolledBack?.quarantined, false);
check('…and says the file was put back', /put back/.test(undoLine(rolledBack) || ''), true);
// "Success" without a recoverable file is the one outcome quarantine cannot have.
check('a success with no backup yields no evidence', quarantineEvidence({ did: 'done', verified: true }, ROBOTS_FINDING_ID), null);
check('…and no undo line', undoLine(null), null);
check('…nor for evidence that names no file', undoLine({ name: '', quarantined: true, restored: false }), null);
check('another finding\'s backup is not a quarantine', quarantineEvidence({ backup: `/srv/site/${backup}`, verified: true }, 'morpheus_file_editor'), null);

const uiSrc = read('src/components/matrix/website/HealthTab.jsx');
check('the panel stores what the site sent about the quarantine', has(uiSrc, 'quarantine: payload.quarantine || null'), true);
check('…and prints the undo, not just a generic success', (uiSrc.match(/result\.quarantine\?\.undo/g) || []).length, 2);

// ── coupled to the rendered assertions ──────────────────────────────────────
//
// PHP needs a running WordPress, which CI does not have. These keep the
// behaviour asserted in tests/harness-noyoast.php from quietly disappearing.
check('the harness asserts a good physical file produces no finding', has(noYoastHarness, 'robots: a good physical file produces NO finding'), true);
check('…and that a stale served one does', has(noYoastHarness, 'robots: the stale file IS a finding'), true);
check('…and that a file which is not served is neither', has(noYoastHarness, 'robots: a file that is not served is not a finding'), true);
check('…and that the scan turns it into a recommended finding with a fix', has(noYoastHarness, "robots: a stale served file is a recommendation, not silence"), true);
check('…and that the fix quarantines rather than deletes', has(noYoastHarness, 'robots: …which exists — QUARANTINED, not deleted'), true);
check('…and that the backup name is the documented one', has(noYoastHarness, 'robots: …under the documented timestamped name'), true);
check('…and that the outcome names where the backup is', has(noYoastHarness, 'robots: the outcome says where the backup is'), true);
check('…and that the dynamic robots.txt is served afterwards', has(noYoastHarness, 'robots: the dynamic robots.txt advertises the sitemap the site serves'), true);
check('…and that a fix which cannot verify rolls the file back', has(noYoastHarness, 'robots: a fix that cannot verify is NOT reported as verified'), true);
check('…and that the file really is back', has(noYoastHarness, "robots: …with its original contents"), true);
// Case 7's probe body fails on BOTH counts, so on its own it would stay green if
// the still-serving comparison were deleted — this is the case that isolates it,
// and it is the one whose mutation was observed to fail. See the comment on 7b.
check('…and that a still-served old body is refused on its own', has(noYoastHarness, 'robots: still serving the old file is NOT reported as verified'), true);
check('…and that the still-serving reason is the one given', has(noYoastHarness, 'robots: …and the reason is the STILL-SERVING one'), true);
check('…and that the case proves the sitemap clause did not decide it', has(noYoastHarness, 'robots: …NOT the sitemap clause, which this case isolates from'), true);
check('…and that a warm cache does not undo a working fix', has(noYoastHarness, 'robots: a warm cache does not undo a fix that actually worked'), true);

// ── summary ─────────────────────────────────────────────────────────────────
console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log('\nSEO generation rules are broken. Fix before merging.\n');
  process.exit(1);
}
console.log('SEO generation rules hold.\n');
