// The template resolver is a preview, so its job is to show the operator what
// the plugin will actually produce for the tokens the client knows about — and
// to never show a token that a live title would not contain.
import { resolveTemplate, insertToken, TEMPLATE_TOKENS, TOKEN_HELP } from './seoTemplate.js';
import assert from 'node:assert';

const vars = { title: 'Guitar Repairs', siteName: 'Valiant Music', tagline: 'Vintage guitars', excerpt: 'We repair guitars properly.' };

assert.strictEqual(resolveTemplate('%title% | %sitename%', vars), 'Guitar Repairs | Valiant Music');
assert.strictEqual(resolveTemplate('%title% — %tagline%', vars), 'Guitar Repairs — Vintage guitars');
assert.strictEqual(resolveTemplate('%excerpt%', vars), 'We repair guitars properly.');

// %excerpt% falls back to the content when there is no excerpt — same rule as
// the plugin, which falls back to the first words of the body.
assert.strictEqual(resolveTemplate('%excerpt%', { title: 'x', content: 'Body first line.' }), 'Body first line.');

// The client has no body text for an item, so %content% shows a placeholder —
// labelled as an example in the UI rather than invented.
assert.strictEqual(resolveTemplate('%title% :: %content%', vars, 'first 30 words'), 'Guitar Repairs :: first 30 words');

// Unknown tokens are removed, not left in place: a literal %category% must never
// appear in an example when the plugin would strip it from the live title.
assert.strictEqual(resolveTemplate('%title% %category%', vars), 'Guitar Repairs');
assert.strictEqual(resolveTemplate('%nope%', vars), '');

// Whitespace collapse + trim, matching clean_template() on the PHP side.
assert.strictEqual(resolveTemplate('  %title%   |    %sitename%  ', vars), 'Guitar Repairs | Valiant Music');
assert.strictEqual(resolveTemplate('%title%   %sitename%', vars), 'Guitar Repairs Valiant Music');

// An empty template is empty, not the tokens.
assert.strictEqual(resolveTemplate('', vars), '');
assert.strictEqual(resolveTemplate(null, vars), '');

// Token insertion replaces the selection, which is what a phone keyboard does
// when you have highlighted a word.
assert.strictEqual(insertToken('Hello world', '%title%', 6, 11), 'Hello %title%');
assert.strictEqual(insertToken('Hello', '%sitename%'), 'Hello%sitename%');
assert.strictEqual(insertToken('', '%title%'), '%title%');

// Every token the UI offers must be a token the plugin accepts, and every one
// must have help text (an unlabelled chip is a dead end on a phone).
assert.strictEqual(TEMPLATE_TOKENS.length, 5);
for (const t of TEMPLATE_TOKENS) {
  assert.ok(TOKEN_HELP[t], `${t} has help text`);
  assert.ok(resolveTemplate(t, vars).length > 0, `${t} resolves to something with these vars`);
}

console.log('seoTemplate.test.js passed');
