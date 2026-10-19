// Can a new client-side variable silently stop the frontend deploying?
//
// WHY THIS EXISTS (2026-09-30). Every `VITE_`-prefixed variable is INLINED INTO THE CLIENT BUNDLE BY
// DESIGN, so Netlify's secrets scanner finds its value in the build output and fails the deploy. The
// compile succeeded every time; the deploy failed every time; no Netlify status was attached to the merge
// commit; and the frontend silently stopped shipping at 04:41Z while the backend kept going. It read
// exactly like a broken build and it was not — an hour went into hypotheses about build minutes.
//
// `netlify.toml` now omits those keys by name. This guard is what stops the next one from being silent:
// a `VITE_` variable added to the code but not to that list breaks the deploy in a way nothing else in
// this repo can see.
//
// The other half matters more. Omitting a key is a claim that its value is PUBLIC BY CONSTRUCTION. If
// someone ever writes `VITE_STRIPE_SECRET_KEY`, the correct outcome is a RED BUILD, not an omission —
// so a secret-shaped name is a failure here regardless of the list.
//
// Run:  node scripts/verify-client-env.mjs
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
let checks = 0;
function check(name, actual, expected) {
  checks++;
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name}\n          expected ${e}\n          got      ${a}`); failures++; }
}

// Strip TOML comments before matching anything. This file's own comments name
// SECRETS_SCAN_SMART_DETECTION_ENABLED, and a check for "is the scanner disabled" satisfied by a comment
// explaining that it is NOT disabled is the trap this repo has hit ten times (H19).
const stripToml = (src) => src.split('\n').map((l) => l.replace(/(^|\s)#.*$/, '')).join('\n');

const toml = stripToml(readFileSync(join(ROOT, 'netlify.toml'), 'utf8'));
const settingOf = (key) => {
  const m = new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, 'm').exec(toml);
  return m ? m[1] : null;
};

/** Every client-side variable the code can actually inline. */
function clientVars() {
  const found = new Map();
  const scan = (file) => {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/import\.meta\.env\.(VITE_[A-Z0-9_]+)/g)) found.set(m[1], relative(ROOT, file));
    for (const m of src.matchAll(/process\.env\.(VITE_[A-Z0-9_]+)/g)) found.set(m[1], relative(ROOT, file));
  };
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { if (!/node_modules|\.git|dist|public/.test(e.name)) walk(p); }
      else if (/\.(js|jsx|ts|tsx|html)$/.test(e.name)) scan(p);
    }
  };
  walk(join(ROOT, 'src'));
  scan(join(ROOT, 'index.html'));
  return found;
}

const used = clientVars();
const omitted = (settingOf('SECRETS_SCAN_OMIT_KEYS') || '').split(',').map((s) => s.trim()).filter(Boolean);

console.log('\n1. the scanner is narrowed, not switched off');
// The lazy fix — disable detection — is offered by Netlify's own error message and would hide a real
// secret in the client bundle forever. Asserted by VALUE: unset is correct, "true" is correct, "false" is
// a failure.
check('smart detection is not disabled', settingOf('SECRETS_SCAN_SMART_DETECTION_ENABLED'), null);
check('…and the omission is by KEY, not by brittle value',
  /SECRETS_SCAN_OMIT_VALUES/.test(toml), false);
check('…with a non-empty key list', omitted.length > 0, true);

console.log('\n2. the list and the code cannot drift apart');
// The recurrence this guard exists for: add a VITE_ variable, forget the list, and the deploy fails with
// nothing in the code to find.
const missing = [...used.keys()].filter((k) => !omitted.includes(k));
check('every client-side variable is in the omit list', missing, []);
// The other direction, reported rather than failed: a stale key in the list is harmless (the scanner just
// never sees it) but it is a list drifting from reality, which is how the next person stops trusting it.
const stale = omitted.filter((k) => !used.has(k));
if (stale.length) console.log(`  NOTE  in the list but no longer used in the client: ${stale.join(', ')}`);

console.log('\n3. nothing secret is ever inlined — the reason omission must stay a claim');
// `VITE_` means public. A name promising a credential is public BY ACCIDENT, and omitting it would hide
// the leak instead of failing the build.
const SECRETISH = /(SECRET|PASSWORD|PASSWD|PRIVATE|CREDENTIAL|SERVICE_ROLE|ACCESS_KEY|CLIENT_SECRET|WEBHOOK)/i;
check('no client-side variable is named like a secret',
  [...used.keys()].filter((k) => SECRETISH.test(k)), []);
// A key whose name says "key" or "token" is a question, not automatically a failure — `wgt_`/`mgw_` style
// tokens are exactly what must never be client-side, so it is reported loudly for a human to answer.
const askable = [...used.keys()].filter((k) => /(^|_)(KEY|TOKEN)($|_)/i.test(k));
if (askable.length) console.log(`  NOTE  names containing KEY/TOKEN — confirm these are public by design: ${askable.join(', ')}`);

console.log('\n4. the contract is written down where a person can find it');
// A local dev without these cannot point the client at anything. Asserted against the same enumeration, so
// the example cannot rot either.
const example = readFileSync(join(ROOT, '.env.example'), 'utf8');
const undocumented = [...used.keys()].filter((k) => !new RegExp(`^\\s*${k}\\s*=`, 'm').test(example));
check('.env.example documents every client-side variable', undocumented, []);
// An example file that contains a real value is how a secret gets committed by the next person copying it.
// Every assignment must be empty or an obvious local placeholder.
const ALLOWED_VALUE = /^(|\/api|true|false|https?:\/\/localhost[^\s]*)$/;
check('…and every value in it is an empty or local placeholder',
  example.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && l.includes('='))
    .filter((l) => !ALLOWED_VALUE.test(l.slice(l.indexOf('=') + 1).trim())),
  []);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log('\n✗ a client-side variable can break the deploy silently, or a secret can ride out in the bundle\n');
  process.exit(1);
}
console.log(`client env is explicit: ${[...used.keys()].length} inlined variable(s), all public by construction, scanner still on\n`);
