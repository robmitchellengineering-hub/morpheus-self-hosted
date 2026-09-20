// Runtime verification for keyword research.
//
// Dependency-free, so it runs in CI's no-install guards job. Run:
//   node scripts/verify-keywords.mjs
//
// The feature's promise is narrow and testable: every keyword says WHICH signal
// produced it, and the response has nowhere to put a search volume, a difficulty
// score or a ranking. That second half is the important one — a model asked for
// a volume invents a convincing one, and an invented number gets acted on. So
// the output shape is asserted to contain no such field, at any depth, and the
// UI is asserted not to render one.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  parseSuggest, extractPageSignals, mergeCandidates, normalizePhrase,
  repeatedPhrases, researchDisclosure, isChrome, titleCore, MAX_KEYWORDS,
} from '../server/src/lib/keywordResearch.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(REPO, p), 'utf8');

let checks = 0;
let failures = 0;
function check(name, actual, expected) {
  checks++;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) console.log(`  PASS  ${name}`);
  else {
    console.log(`  FAIL  ${name}\n          expected ${e}\n          got      ${a}`);
    failures++;
  }
}
const has = (haystack, needle) => String(haystack).includes(needle);

console.log('\nKeyword research — runtime verification\n');

console.log('1. Google autocomplete is parsed, not guessed at');
check('the classic payload', parseSuggest('["guitar repairs",["guitar repairs melbourne","guitar repairs near me"]]'),
  ['guitar repairs melbourne', 'guitar repairs near me']);
check('an object payload', parseSuggest({ suggestions: ['a thing', 'another thing'] }), ['a thing', 'another thing']);
check('the XML-ish fallback', parseSuggest('<toplevel><CompleteSuggestion><suggestion data="guitar setup"/></CompleteSuggestion></toplevel>'), ['guitar setup']);
check('rubbish yields nothing rather than throwing', parseSuggest('not json at all'), []);
check('an empty payload yields nothing', parseSuggest(null), []);
check('...and a 200 with an unexpected shape', parseSuggest('{"error":"rate limited"}'), []);

console.log('\n2. a competing page is read for what it says about itself');
const competitorHtml = `
<html><head>
<title>Guitar Repairs Melbourne | Best Guitar Setup</title>
<meta name="description" content="Expert guitar repairs in Melbourne. Book a setup.">
</head><body>
<h1>Guitar Repairs Melbourne</h1>
<h2>Acoustic guitar setup</h2><h2>Electric guitar setup</h2>
<p>${'guitar repairs melbourne done properly. '.repeat(6)}</p>
<p>${'We do acoustic guitar setup and electric guitar setup every day. '.repeat(4)}</p>
<script>var guitar = 'should not be read';</script>
</body></html>`;
const sig = extractPageSignals(competitorHtml, 'https://rival.example/repairs');
check('the title', sig.title, 'Guitar Repairs Melbourne | Best Guitar Setup');
check('the meta description', sig.description, 'Expert guitar repairs in Melbourne. Book a setup.');
check('the h1', sig.h1, ['Guitar Repairs Melbourne']);
check('the h2s', sig.h2, ['Acoustic guitar setup', 'Electric guitar setup']);
check('script contents are not read as page text', has(JSON.stringify(sig), 'should not be read'), false);
check('repeated phrases are found', sig.phrases.some((p) => p.phrase === 'guitar repairs melbourne'), true);
check('a page with no title does not throw', extractPageSignals('<html><body>x</body></html>', 'https://x.test').title, '');

check('n-grams keep real phrases', repeatedPhrases('guitar setup melbourne guitar setup melbourne guitar setup melbourne').some((p) => p.phrase === 'guitar setup'), true);
check('...and drop all-stopword ones', repeatedPhrases('of the and of the and of the and').length, 0);
check('...and do not start or end on a stopword', repeatedPhrases('the guitar setup of the guitar setup of').every((p) => !p.phrase.startsWith('the ')), true);

console.log('\n3. every keyword carries the signal that produced it');
const merged = mergeCandidates({
  seeds: ['guitar repairs'],
  suggests: { 'guitar repairs': ['guitar repairs melbourne', 'guitar setup near me'] },
  competitors: [{ url: 'https://rival.example', title: 'Guitar Repairs Melbourne', h1: ['Guitar Repairs Melbourne'], h2: ['Acoustic guitar setup'], phrases: [{ phrase: 'guitar repairs melbourne', count: 5 }] }],
  model: ['vintage guitar servicing'],
  page: { title: 'Our workshop', focus_keyword: 'guitar repairs' },
});
const byPhrase = Object.fromEntries(merged.map((r) => [r.phrase, r]));
check('a phrase in autocomplete AND a competitor heading keeps both sources',
  byPhrase['guitar repairs melbourne'].sources.sort(), ['autocomplete', 'competitor-heading', 'competitor-phrase', 'competitor-title']);
check('an autocomplete phrase records the seed it came from', byPhrase['guitar setup near me'].details, ['guitar repairs']);
check('a model suggestion is labelled as a model suggestion', byPhrase['vintage guitar servicing'].sources, ['model']);
check('the page\'s own keyword is included and labelled', byPhrase['guitar repairs'].sources, ['seed', 'page-keyword']);
check('multi-source phrases rank above single-source ones', merged[0].phrase, 'guitar repairs melbourne');
// With the brand suffix stripped, a long title CAN yield a usable keyword —
// that is the point of titleCore. What must still be excluded is a title whose
// informative part is itself a sentence.
check('a brand-suffixed long title yields its core, not the whole title',
  mergeCandidates({ competitors: [{ url: 'u', title: 'Guitar Repairs Melbourne | Valiant Music | Est 1998 Since Then' }] }).map((r) => r.phrase),
  ['guitar repairs melbourne']);
check('a title that is a sentence stays out',
  mergeCandidates({ competitors: [{ url: 'u', title: 'The complete guide to buying your first vintage guitar in Melbourne' }] }).length, 0);
check('a meta description is never a keyword', mergeCandidates({ competitors: [{ url: 'u', description: 'Expert guitar repairs in Melbourne. Book a setup today.' }] }).length, 0);

console.log('\n3b. site furniture never becomes a keyword');
// Found by running this against a real shop: a search field's "Form name"
// label became a keyword AND an autocomplete seed, which then dragged
// "form name meaning in hindi" back from Google.
check('a nav label is chrome', isChrome('About'), true);
check('a form label is chrome', isChrome('Form name'), true);
check('a boilerplate line is chrome', isChrome('All rights reserved'), true);
check('content is not chrome', isChrome('Acoustic guitar setup'), false);
// The case the live run produced: a cart notice glued to a quantity.
check('a cart notice is chrome', isChrome('Item added to your cart'), true);
check('...and even with a number glued to it', isChrome('00 add to cart'), true);
check('a nav term with a brand after it is chrome', isChrome('About Billy Hyde Music'), true);
check('an ambiguous first word alone is not enough to drop real content', isChrome('Shop guitar repairs'), false);
check('chrome never becomes a keyword',
  mergeCandidates({ competitors: [{ url: 'u', h1: ['About'], h2: ['Form name', 'Contact us'] }] }).length, 0);
check('but the operator\'s own seed is kept even if it looks like chrome',
  mergeCandidates({ seeds: ['about'] }).map((r) => r.phrase), ['about']);
check('a page\'s own focus keyword is kept too',
  mergeCandidates({ page: { focus_keyword: 'search' } }).map((r) => r.phrase), ['search']);
check('a brand suffix is stripped from a competitor title', titleCore('Acoustic guitar - Wikipedia'), 'Acoustic guitar');
check('...keeping the informative part of a longer title', titleCore('Guitar Repairs Melbourne | Best Guitar Setup'), 'Guitar Repairs Melbourne');
check('a title with no separator is left alone', titleCore('Guitar Repairs Melbourne'), 'Guitar Repairs Melbourne');
check('the stripped title is what becomes the keyword',
  mergeCandidates({ competitors: [{ url: 'u', title: 'Acoustic guitar - Wikipedia' }] }).map((r) => r.phrase), ['acoustic guitar']);

console.log('\n4. the response shape cannot carry an invented number');
const everyKey = (obj, out = []) => {
  if (Array.isArray(obj)) { obj.forEach((o) => everyKey(o, out)); return out; }
  if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) { out.push(k); everyKey(v, out); }
  }
  return out;
};
const sample = mergeCandidates({ seeds: ['a b'], suggests: { 'a b': ['a b c'] }, competitors: [{ url: 'u', h1: ['a b c'] }], page: { title: 'a b' } });
const keys = new Set(everyKey(sample));
const FORBIDDEN = ['volume', 'search_volume', 'volume_monthly', 'difficulty', 'kd', 'keyword_difficulty', 'cpc', 'competition', 'rank', 'ranking', 'position', 'traffic', 'impressions', 'clicks'];
check('no forbidden metrics on any keyword row', [...keys].filter((k) => FORBIDDEN.includes(k)), []);
check('the rows carry provenance', keys.has('sources') && keys.has('details'), true);

// The handler and the UI must not add one either. Comments are stripped first
// on purpose: the rule is DOCUMENTED in prose at the top of the handler, and a
// check that trips over its own documentation would push the next person to
// delete the explanation rather than keep it.
const stripComments = (src) => String(src)
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  // `//` after a colon is a URL (https://…), not a comment.
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
const handler = read('server/src/functions/researchKeywords.js');
const ui = read('src/components/matrix/website/SeoTab.jsx');
for (const word of ['volume', 'difficulty', 'KD', 'CPC']) {
  check(`the handler's code never mentions "${word}"`, new RegExp(`\\b${word}\\b`, 'i').test(stripComments(handler)), false);
}
// Precise on purpose: the UI is ALLOWED to say "there are no search volumes
// here" (it does, as the disclosure), so a check for the mere word would push
// the next person to delete the explanation. What it must never do is render a
// metric — a label with a value, or a property off the payload.
check('the UI renders no metric label or metric property',
  /(volume|difficulty|cpc|\bkd\b)\s*[:=]/i.test(stripComments(ui))
  || />\s*(search\s+)?(volume|difficulty|kd|cpc)\s*</i.test(ui), false);
check('...and it reads no metric off the payload',
  /\.(search_)?volume\b|\.difficulty\b|\.cpc\b/i.test(ui), false);
check('the UI shows the disclosure instead', has(ui, 'disclosure'), true);

console.log('\n4b. autocomplete is never seeded from a competitor\'s headings');
const handlerSrc = read('server/src/functions/researchKeywords.js');
check('the seed list is built from the page and the model only',
  /const seeds = \[[\s\S]{0,200}?page\.focus_keyword[\s\S]{0,200}?manualSeed/.test(handlerSrc), true);
check('...and does not pull competitor headings into it',
  /const seeds = \[[\s\S]{0,300}?competitors\.flatMap/.test(handlerSrc), false);

console.log('\n5. the honest disclosure is part of the payload');
const disclosure = researchDisclosure({ competitorCount: 2, autocompleteUsed: true });
check('it names both signals', has(disclosure, 'autocomplete') && has(disclosure, '2 competing pages'), true);
check('it says why there are no volumes', has(disclosure, 'deliberately no search volumes'), true);
check('one competitor reads correctly', has(researchDisclosure({ competitorCount: 1, autocompleteUsed: false }), '1 competing page'), true);

console.log('\n6. limits exist so this cannot be used to hammer a third party');
check('seeds are capped', /MAX_SEEDS = \d+/.test(read('server/src/lib/keywordResearch.js')), true);
check('competitors are capped', /MAX_COMPETITORS = \d+/.test(read('server/src/lib/keywordResearch.js')), true);
check('competitor HTML is size-capped', /MAX_COMPETITOR_BYTES = \d+/.test(read('server/src/lib/keywordResearch.js')), true);
// COUNT THEM AGAINST EACH OTHER, not against a number. The first version of
// this checked "FETCH_TIMEOUT_MS appears at least twice", which still passed
// after one of the two timeouts was deleted — because the constant declaration
// and the other call site supplied the count on their own.
const handlerCode = stripComments(handler);
const fetches = (handlerCode.match(/await fetch\(/g) || []).length;
const timeouts = (handlerCode.match(/setTimeout\([\s\S]{0,60}?FETCH_TIMEOUT_MS\)/g) || []).length;
check('the handler makes outbound requests at all (parser sanity)', fetches >= 2, true);
check('EVERY outbound fetch has its own timeout', timeouts >= fetches, true);

// A competitor that fails must return a failure, not throw: one bad address
// among three must not lose the other two.
const competitorFn = handlerCode.slice(handlerCode.indexOf('async function fetchCompetitor'));
const competitorBody = competitorFn.slice(0, competitorFn.indexOf('\n}\n') + 2);
check('the competitor reader was located (parser sanity)', competitorBody.length > 200, true);
check('it never throws — a failure is a value', /\bthrow\b/.test(competitorBody), false);
check('it has a catch for the network itself', /catch\s*\(/.test(competitorBody), true);
check('failures carry a reason for the operator', (competitorBody.match(/error:/g) || []).length >= 3, true);
check('and the response reports them per URL', has(handler, 'error: c.error || null'), true);
check('the model is optional: its failure cannot fail the research', has(handler, 'catch {'), true);
check('the rows are capped', MAX_KEYWORDS > 0 && MAX_KEYWORDS <= 100, true);
check('phrases are normalised for dedupe', normalizePhrase('  Guitar   Repairs!  '), 'guitar repairs');

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log('\nKeyword research is broken or claims more than it can know. Fix before merging.\n');
  process.exit(1);
}
console.log('keyword research holds.\n');
