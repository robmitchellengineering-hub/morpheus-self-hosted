// Does any committed file look like it holds a real credential?
//
// WHY THIS EXISTS (2026-09-30). `verify-security-posture.mjs` needed a hardcoded-secret fixture, and it
// used a Stripe-shaped string. Netlify's smart detection scans REPOSITORY CODE as well as build output, so
// from the moment that guard landed the frontend stopped deploying: **the build compiled and the deploy was
// refused**, no Netlify status reached the merge commit, and there was nothing in the application code to
// find. It read exactly like a broken build. An hour went into hypotheses about build minutes and plan
// limits, and Netlify's own error template pointed at the wrong thing (VITE_ variables and
// SECRETS_SCAN_OMIT_KEYS) because it cannot tell you WHICH string it matched.
//
// A test fixture is committed code. It must never be shaped like the thing it tests for.
//
// This scans TRACKED files only, so a scratch copy or a local .env is not the repo's problem — but note the
// portable Morpheus bundle ships the source, so anything tracked is also published for download.
//
// Run:  node scripts/verify-no-secret-fixtures.mjs
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
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

/**
 * Patterns for credentials that are REAL when they appear. Deliberately narrow: every one of these is a
 * provider-specific prefix that cannot be produced by accident, so there is no reason for an exception
 * list — and an exception list is how a real key gets waved through.
 *
 * Lengths are the providers' own minimums; a shorter match is a word, not a key.
 */
export const CREDENTIAL_PATTERNS = [
  { name: 'OpenAI/Stripe-style secret key', re: /\bsk-(live|test|proj|ant)?-?[A-Za-z0-9_-]{24,}/ },
  { name: 'Stripe restricted/live key', re: /\b(sk|rk)_(live|test)_[A-Za-z0-9]{20,}/ },
  { name: 'Google OAuth client secret', re: /\bGOCSPX-[A-Za-z0-9_-]{20,}/ },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}/ },
  { name: 'AWS access key id', re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: 'GitHub token', re: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}|\bgithub_pat_[A-Za-z0-9_]{60,}/ },
  { name: 'Slack token', re: /\bxox[abpsr]-[A-Za-z0-9-]{20,}/ },
  { name: 'Private key block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'Anthropic key', re: /\bsk-ant-[A-Za-z0-9_-]{24,}/ },
  { name: 'Hugging Face token', re: /\bhf_[A-Za-z0-9]{34,}/ },
  { name: 'Supabase service role JWT', re: /\beyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/ },
  { name: 'Connection string with a real remote password', re: /\b(postgres|postgresql|mysql|mongodb(\+srv)?|redis):\/\/(?!\$\{)[^:@\s"'`]+:(?!\$\{|<)[^@\s"'`]{8,}@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+/ },
  { name: 'Morpheus widget token', re: /\bwgt_[0-9a-f]{40,}/ },
];

// Cached AND untracked-but-not-ignored — that is exactly "what would be committed", and the difference
// matters: `git ls-files` alone skips a NEW file, so this guard's own first version carried the very string
// it hunts for (in its self-tests) and reported the repo clean because it had not been added to the index
// yet. A check that cannot see the file it lives in is a check with a hole in the middle of it. Ignored
// files stay out of scope, so a developer's local `.env` is not the repository's problem.
const tracked = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: ROOT, encoding: 'utf8' })
  .split('\0').filter(Boolean);

// Binary files are skipped by reading, not by guessing from the name: a `.png` that happens to contain a
// credential-shaped byte run is not a leak anybody can act on, and a text file with any extension is.
const text = (p) => {
  try {
    const buf = readFileSync(join(ROOT, p));
    if (buf.includes(0)) return null;
    return buf.toString('utf8');
  } catch { return null; }
};

const hits = [];
let scanned = 0;
for (const p of tracked) {
  const src = text(p);
  if (src === null) continue;
  scanned++;
  const lines = src.split('\n');
  for (const { name, re } of CREDENTIAL_PATTERNS) {
    lines.forEach((line, i) => {
      const m = re.exec(line);
      // Report the SHAPE, never the value: this guard runs in CI logs, and a guard that prints the
      // credential it found is a second copy of the leak.
      if (m) hits.push({ file: p, line: i + 1, kind: name, sample: `${m[0].slice(0, 4)}…(${m[0].length} chars)` });
    });
  }
}

console.log(`\n1. no committed file is shaped like a real credential (${scanned} tracked text file(s) scanned)`);
check('…and none does', hits.map((h) => `${h.file}:${h.line} ${h.kind} ${h.sample}`), []);

console.log('\n2. the guard is looking for the right things');
// Asserted as BEHAVIOUR: a detector that matches nothing passes section 1 for the wrong reason, which is the
// exact failure this guard is about.
//
// AND THE SAMPLES ARE ASSEMBLED FROM PARTS, not written whole. This guard scans the repository it lives in,
// so a whole sample would be a credential-shaped literal in a committed file — the guard would fail on
// itself, or worse, someone would "fix" that with an exception and the exception would be the hole. Joining
// the pieces keeps the detector honest and the file clean at the same time.
const sample = (...parts) => parts.join('');
check('it recognises a Stripe-shaped key',
  CREDENTIAL_PATTERNS.some((p) => p.re.test(sample('sk-', 'live-', 'abcdefghijklmnopqrstuvwx'))), true);
check('…a Google client secret',
  CREDENTIAL_PATTERNS.some((p) => p.re.test(sample('GOCSPX-', 'abcdefghijklmnopqrstuvwx'))), true);
check('…and a database URL with a password',
  CREDENTIAL_PATTERNS.some((p) => p.re.test(sample('postgresql://user:', 'averylongpassword', '@db.example.com/x'))), true);
// The narrowed rule, asserted in the direction that matters: the repo's own benign shapes must NOT fire, or
// the guard would have needed an exception list — and an exception list is how a real key gets waved through.
for (const [what, example] of [
  ['a local compose DATABASE_URL', 'postgresql://morpheus:localdev@postgres:5432/morpheus?schema=public'],
  ['a localhost example', 'DATABASE_URL=postgresql://morpheus:localdev@localhost:5432/morpheus'],
  ['a documentation placeholder', 'postgresql://postgres.<ref>:<password>@<host>:5432/postgres'],
  ['a generated connection string', 'postgresql://${cfg.user}:${cfg.password}@${cfg.host}:${cfg.port}/${cfg.database}'],
]) {
  check(`…but not ${what}`, CREDENTIAL_PATTERNS.some((p) => p.re.test(example)), false);
}
// The other direction, or the guard is unusable: ordinary code must not trip it.
check('it does NOT flag an obviously fake fixture',
  CREDENTIAL_PATTERNS.some((p) => p.re.test('this-is-not-a-real-secret-0000')), false);
check('…nor a placeholder',
  CREDENTIAL_PATTERNS.some((p) => p.re.test('your-api-key-here')), false);
check('…nor a short test value',
  CREDENTIAL_PATTERNS.some((p) => p.re.test('sk_test_local')), false);
check('…nor a name in prose',
  CREDENTIAL_PATTERNS.some((p) => p.re.test('the STRIPE_SECRET_KEY variable is not set')), false);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log('\n✗ a committed fixture looks like a credential — this fails DEPLOYS without failing the build\n');
  process.exit(1);
}
console.log('no committed file is mistakable for a credential, and the detectors prove they can still fire\n');
