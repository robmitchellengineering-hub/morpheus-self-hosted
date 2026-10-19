// The search-result preview is a writing aid, so its whole job is truncating
// the way a reader would actually see it. These assertions are about the two
// ways that goes wrong: cutting mid-word, and hiding the fact that the value
// shown is the fallback rather than something the operator wrote.
import { serpPreview, truncateAtWord, serpBreadcrumb, SERP_TITLE_MAX, SERP_DESC_MAX } from './serpPreview.js';
import assert from 'node:assert';

// ── word-boundary truncation ────────────────────────────────────────────────
const short = truncateAtWord('Guitar Repairs in Melbourne', 60);
assert.strictEqual(short.text, 'Guitar Repairs in Melbourne');
assert.strictEqual(short.truncated, false, 'text within the limit is untouched');

const long = truncateAtWord('Guitar Repairs in Melbourne — Setups, Refrets and Crack Repairs Done Properly', 60);
assert.ok(long.truncated, 'over-length text is marked truncated');
assert.ok(long.text.length <= 61, `truncated title stays within the limit (got ${long.text.length})`);
assert.ok(long.text.endsWith('…'), 'an ellipsis marks the cut');
assert.ok(!/Melbourn…$/.test(long.text), 'a word is never cut in half');
assert.ok(!/\s…$/.test(long.text), 'the ellipsis never follows a space');

// A single unbroken token still has to be shortened.
const token = truncateAtWord('A'.repeat(120), 60);
assert.strictEqual(token.text.length, 61, 'one long token is hard-cut rather than left over-length');
assert.ok(token.text.endsWith('…'));

// Trailing punctuation from the cut is not left dangling before the ellipsis.
const punct = truncateAtWord('one two three, four five six seven eight nine ten', 20).text;
assert.ok(punct.endsWith('…'), 'the cut is marked');
assert.ok(!punct.includes(',…'), 'a comma left by the cut is stripped before the ellipsis');

// Empty in, empty out — not "…".
assert.deepStrictEqual(truncateAtWord('', 60), { text: '', truncated: false });
assert.deepStrictEqual(truncateAtWord(null, 60), { text: '', truncated: false });

// ── breadcrumb ──────────────────────────────────────────────────────────────
assert.strictEqual(serpBreadcrumb('https://www.valiantmusic.com.au/guitar-repairs/'), 'valiantmusic.com.au › guitar-repairs');
assert.strictEqual(serpBreadcrumb('https://shop.test/2026/09/19/a-post/'), 'shop.test › 2026 › 09 › 19 › a-post');
assert.strictEqual(serpBreadcrumb('https://shop.test/'), 'shop.test');
assert.strictEqual(serpBreadcrumb(''), '');
assert.strictEqual(serpBreadcrumb('not a url'), 'not a url', 'an unparseable url is shown as-is, not hidden');

// ── the whole preview ───────────────────────────────────────────────────────
const p = serpPreview({
  title: 'Guitar Repairs in Melbourne',
  description: 'Electric and acoustic repairs, quoted before any work starts.',
  url: 'https://www.valiantmusic.com.au/guitar-repairs/',
});
assert.strictEqual(p.title, 'Guitar Repairs in Melbourne');
assert.strictEqual(p.titleTruncated, false);
assert.strictEqual(p.breadcrumb, 'valiantmusic.com.au › guitar-repairs');
assert.strictEqual(p.usedFallback, false);

// EMPTY FIELDS ARE NOT AN EMPTY RESULT: what the site would actually emit is
// the post title and the excerpt, and the preview has to show that.
const fallback = serpPreview({ title: '', description: '', titleFallback: 'Guitar Repairs', descriptionFallback: 'A short excerpt.', url: 'https://shop.test/repairs/' });
assert.strictEqual(fallback.title, 'Guitar Repairs');
assert.strictEqual(fallback.description, 'A short excerpt.');
assert.strictEqual(fallback.usedFallback, true, 'the UI is told the values are not the operator\'s own');

// Limits come from the live site's context when it provides them.
const custom = serpPreview({ title: 'x'.repeat(80), titleMax: 30 });
assert.ok(custom.titleTruncated && custom.title.length <= 31, 'a site-supplied title limit is honoured');

assert.strictEqual(SERP_TITLE_MAX, 60);
assert.strictEqual(SERP_DESC_MAX, 160);

console.log('serpPreview.test.js passed');
