// Contrast guard for the theme tokens.
//
// WHY THIS EXISTS
//
// Body copy used to inherit --foreground, which is the bright Matrix green: every
// piece of text without a colour class of its own rendered green, and small prose
// was hard to read (Rob, 2026-09-22: "small text is easier to read ... the colours
// make obvious the things that are actionable"). The Alice Stats page had already
// worked this out in its own classes and in --text-ink; this guard pins the rule
// so it cannot be undone one theme block at a time.
//
// It computes real WCAG 2.1 contrast ratios from the HSL triplets in
// src/index.css — the actual values, not what a comment claims — and fails when a
// token that carries reading text drops below AA.
//
// Thresholds, and why each:
//   * text-ink        >= 4.5  body/reading copy, AA normal text
//   * muted-foreground>= 4.5  still sits on body text, so it gets the same bar
//   * accent          >= 3.0  links and actions: AA non-text/large (an action must
//                             be findable, not necessarily read as prose)
//   * heading         >= 3.0  large headings, AA large text
//   * primary         >= 3.0  headline numbers/titles on the same basis
//
// Run: node scripts/verify-contrast.mjs

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(join(REPO, 'src/index.css'), 'utf8');

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
const ok = (name, cond, detail = '') => {
  checks++;
  if (cond) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ''}`); failures++; }
};

// ── parse the theme blocks ──────────────────────────────────────────────────
// These blocks contain only variable declarations (no nested braces), so a flat
// selector{body} scan is exact rather than approximate.
const blocks = [];
const blockRe = /([^{}]+)\{([^{}]*)\}/g;
let m;
while ((m = blockRe.exec(css))) {
  const sel = (m[1].trim().split('\n').pop() || '').trim() || ':root';
  const vars = {};
  const varRe = /--([a-z0-9-]+):\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%/g;
  let v;
  while ((v = varRe.exec(m[2]))) vars[v[1]] = [Number(v[2]), Number(v[3]), Number(v[4])];
  if (Object.keys(vars).length) blocks.push({ sel, vars });
}

const hslToRgb = ([h, s, l]) => {
  const S = s / 100;
  const L = l / 100;
  const c = (1 - Math.abs(2 * L - 1)) * S;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const mm = L - c / 2;
  const seg = Math.floor(h / 60) % 6;
  const [r, g, b] = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][seg];
  return [r, g, b].map((n) => Math.round((n + mm) * 255));
};

const luminance = (hsl) => {
  const lin = hslToRgb(hsl).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
};

const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
};

console.log('\nTheme contrast — computed from src/index.css\n');

const themed = blocks.filter((b) => b.vars['text-ink'] && b.vars.background);
ok('theme blocks with both an ink and a background were found (parser sanity)', themed.length >= 3,
  `found ${themed.length}: ${themed.map((t) => t.sel).join(', ')}`);

const REQUIREMENTS = [
  ['text-ink', 4.5, 'body copy'],
  ['muted-foreground', 4.5, 'secondary body copy'],
  ['accent', 3, 'links and actions'],
  ['heading', 3, 'headings'],
  ['primary', 3, 'titles and headline numbers'],
];

for (const b of themed) {
  console.log(`\n${b.sel}`);
  const bg = b.vars.background;
  for (const [token, min, label] of REQUIREMENTS) {
    const value = b.vars[token];
    if (!value) continue;
    const r = contrast(value, bg);
    const pass = r >= min;
    console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${token.padEnd(17)} contrast ${String(r).padStart(5)} (needs ${min}) — ${label}`);
    checks++;
    if (!pass) failures++;
  }
}

// The rule itself: body copy must not go back to inheriting the bright green.
const bodyRule = (css.match(/\n\s*body\s*\{[^}]*\}/) || [''])[0];
ok('body copy uses the ink token', /@apply[^;]*text-ink/.test(bodyRule), bodyRule.trim());
ok('body copy does not fall back to --foreground (the bright green)', !/@apply[^;]*text-foreground/.test(bodyRule), bodyRule.trim());
ok('headings keep the brand green', /h1,\s*h2,\s*h3,\s*h4,\s*h5,\s*h6\s*\{\s*color:\s*hsl\(var\(--heading\)\)/.test(css.replace(/\s+/g, ' ')));
// Plain `a`, deliberately: @layer base loses to Tailwind utilities, so a component
// that sets its own link colour still wins. An earlier `a:not([class*='text-'])`
// guard was wrong twice over — it wrongly skipped links carrying only `text-sm`,
// and it was unnecessary.
ok('links carry the action colour', /\ba\s*\{\s*color:\s*hsl\(var\(--accent\)\)/.test(css.replace(/\s+/g, ' ')));

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log('\nThe theme no longer meets its own readability rule. Fix the token or the rule —');
  console.log('but do not lower the threshold to make a dim token pass.\n');
  process.exit(1);
}
console.log('theme contrast holds.\n');
