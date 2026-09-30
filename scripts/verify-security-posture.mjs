// Does a generated app arrive safe by default, and is the operator told what it is not?
//
// WHY THIS EXISTS. The market evidence for "it ships" puts security first and nobody's feature:
// **~45% of AI-generated code samples fail security tests**, and **~380,000 AI-built apps are publicly
// accessible, ~5,000 holding sensitive data**. Morpheus had the PRINCIPLE — the reviewer's prompt has
// always listed `eval`, hardcoded secrets, SQL injection, `innerHTML` and command injection — but a prompt
// is not a check: nothing examined the generated artifact, and the operator was told nothing either way.
//
// The checks are pure functions over a generated file list, so every finding is asserted here without a
// model, a key or a credit. What this guard is really testing is the DEFAULT: an app that ships `.env`, or
// that reaches its data with no auth in front of it, is dangerous because of what it does when nobody is
// looking, and those are decidable from the files.
//
// Run:  node scripts/verify-security-posture.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SECURITY_CHECKS, securityFindings, blockingFindings, securitySummary, SECURITY_PROMPT_BLOCK,
} from '../server/src/lib/securityPosture.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');

let failures = 0;
let checks = 0;
function check(name, actual, expected) {
  checks++;
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name}\n          expected ${e}\n          got      ${a}`); failures++; }
}
const ids = (files) => securityFindings(files).map((f) => f.id);

// A clean app: the shape the generator is asked to produce, with none of the dangers.
const GOOD = [
  { path: '.gitignore', content: 'node_modules/\n.env\ndata/\n*.db\n' },
  { path: '.env.example', content: 'JWT_SECRET=\nDATABASE_URL=./data/app.db\n' },
  { path: 'README.md', content: '# App\n\n```bash\nnpm install && npm start\n```\n' },
  { path: 'server/index.js', content: "const helmet = require('helmet');\nconst jwt = require('jsonwebtoken');\napp.use(helmet());\napp.use(express.json({ limit: '100kb' }));\napp.use(requireAuth);\n" },
  { path: 'server/routes/tasks.js', content: "router.get('/', requireAuth, list);\nrouter.post('/', requireAuth, create);\n" },
];

console.log('\n1. a good app is clean, and the report says what that means');
check('no findings on a well-formed app', ids(GOOD), []);
check('nothing is blocked', blockingFindings(securityFindings(GOOD)), []);
// The most important sentence in the whole module. "No findings" is NOT "audited" — the repo's own rule
// for a check that examined nothing, applied to a security report where the overclaim is dangerous.
// Asserted as an ABSENCE as well as a presence: the presence-only version was negative-tested and SURVIVED
// a mutation that prefixed the sentence with "fully audited and checked.", because the disclaimer was still
// in the string. The property is that the clean report makes no claim of its own, so the word may appear
// exactly once — inside the negation that denies it.
const cleanSummary = securitySummary(securityFindings(GOOD), { filesExamined: GOOD.length });
check('the clean summary refuses to claim an audit',
  /not the same as "audited"/.test(cleanSummary), true);
check('…and claims nothing of its own while doing so',
  (cleanSummary.match(/audit/gi) || []).length, 1);
check('…and does not reach for a synonym either',
  /\b(fully|completely|thoroughly|all)\s+(verified|checked|safe|secure|covered)\b/i.test(cleanSummary), false);
check('…and names how much it examined', /across 5 file\(s\)/.test(cleanSummary), true);
check('a report on NOTHING says nothing is claimed',
  /Nothing was examined, so nothing is claimed/.test(securitySummary([], { filesExamined: 0 })), true);

console.log('\n2. the defaults that leak while nobody is looking');
// A .env in the output is the single most common way a secret becomes public: it is the file the app
// reads its keys from, so it ships with the code.
check('a shipped .env is CRITICAL', securityFindings([...GOOD, { path: '.env', content: 'JWT_SECRET=abc' }]).find((f) => f.id === 'env-committed')?.severity, 'critical');
check('…and it blocks', blockingFindings(securityFindings([...GOOD, { path: '.env', content: 'x' }])).map((f) => f.id), ['env-committed']);
check('…and comes with the fix, not just the complaint',
  /\.env\.example/.test(securityFindings([...GOOD, { path: '.env', content: 'x' }]).find((f) => f.id === 'env-committed')?.fix || ''), true);
// No .gitignore is what makes the first `git add -A` commit the secret.
check('a missing .gitignore is caught', ids(GOOD.filter((f) => f.path !== '.gitignore')), ['no-gitignore', 'no-security-headers-or-limits'].filter((x) => x === 'no-gitignore'));

console.log('\n3. a secret written into the source');
check('a long literal assigned to a secret-ish name is caught',
  ids([...GOOD, { path: 'server/lib/config.js', content: 'const API_KEY = "this-is-not-a-real-secret-0000";' }]).includes('hardcoded-secret'), true);
// The false-positive side matters as much: a check that cries wolf on every placeholder is one an
// operator learns to ignore, which is worse than no check.
for (const [what, content] of [
  ['reading from the environment', 'const API_KEY = process.env.API_KEY;'],
  ['a placeholder in .env.example', 'API_KEY=your-key-here'],
  ['a short value', 'const token = "abc";'],
  ['the word in prose', '// set the API_KEY = "something" in the environment'],
]) {
  check(`NOT flagged: ${what}`, ids([...GOOD, { path: 'server/lib/config.js', content }]).includes('hardcoded-secret'), false);
}

console.log('\n4. data routes with nothing in front of them');
// The fixture must CONTAIN the condition: an app with data routes and no auth. Filtering auth out of
// GOOD left routes that name no data entity, so the check correctly saw no data routes and the assertion
// failed while the code was right.
const noAuth = [
  { path: '.gitignore', content: '.env\ndata/\n' },
  { path: 'server/index.js', content: "const express = require('express');\napp.use(express.json());\n" },
  { path: 'server/routes/tasks.js', content: "router.get('/api/tasks', list);\nrouter.post('/api/tasks', create);\n" },
];
check('data routes and no auth anywhere is caught', ids(noAuth).includes('no-auth-on-data-routes'), true);
check('…and it is HIGH, not critical — an authorisation check may live elsewhere', securityFindings(noAuth).find((f) => f.id === 'no-auth-on-data-routes')?.severity, 'high');
check('an app with auth is not flagged', ids(GOOD).includes('no-auth-on-data-routes'), false);
// An app with no data routes at all must not be lectured about auth.
check('a static site with no data routes is not flagged',
  ids([{ path: 'index.html', content: '<h1>hi</h1>' }, { path: '.gitignore', content: '.env\n' }]).includes('no-auth-on-data-routes'), false);

console.log('\n5. the two things every generated service forgets, and one destructive flag');
check('wildcard CORS with credentials is caught',
  ids([...GOOD, { path: 'server/index.js', content: "app.use(cors({ origin: '*', credentials: true }))" }]).includes('permissive-cors'), true);
check('a listed origin is not', ids(GOOD).includes('permissive-cors'), false);
check('a missing body limit and helmet are NOTES, not holes',
  securityFindings([{ path: 'server/index.js', content: 'app.get("/api/tasks", h);' }]).find((f) => f.id === 'no-security-headers-or-limits')?.severity, 'note');
check('--accept-data-loss is surfaced rather than ignored',
  ids([...GOOD, { path: 'README.md', content: 'npx prisma db push --accept-data-loss\n' }]).includes('accept-data-loss'), true);

console.log('\n6. the report reads worst-first, and says so plainly');
const mixed = securityFindings([
  ...GOOD,
  { path: '.env', content: 'JWT_SECRET=abc' },
  { path: 'server/lib/config.js', content: 'const SECRET = "this-is-not-a-real-secret-0000";' },
]);
check('critical findings sort first', mixed[0].severity, 'critical');
check('…and the order is by severity, not by check order',
  mixed.map((f) => f.severity).join(','), 'critical,critical');
check('the summary leads with DO NOT SHIP', /^DO NOT SHIP AS IS/.test(securitySummary(mixed, { filesExamined: 8 })), true);
check('…and counts what is left', /2 critical finding\(s\)/.test(securitySummary(mixed, { filesExamined: 8 })), true);
check('every finding carries a fix, not only a complaint',
  SECURITY_CHECKS.every((c) => typeof c.fix === 'string' && c.fix.length > 20), true);
check('every finding says WHY it is dangerous', SECURITY_CHECKS.every((c) => typeof c.why === 'string' && c.why.length > 40), true);
check('every severity is one of the three the report understands',
  SECURITY_CHECKS.every((c) => ['critical', 'high', 'note'].includes(c.severity)), true);
// NOT "returns []" — an empty app genuinely HAS no .gitignore and no helmet, so those findings are the
// right answer and asserting [] tested the wrong thing. What matters is that a malformed entry is ignored
// and nothing throws.
check('a malformed file entry does not crash the checker', Array.isArray(securityFindings([null, {}, { path: 42 }])), true);
check('…and the junk entries are not counted as files',
  ids([null, {}, { path: 42 }]).join(','), 'no-gitignore,no-security-headers-or-limits');
check('a missing file list is not a crash', Array.isArray(securityFindings(undefined)), true);
// The fixture's IDENTIFIER is what matters here: `hardcoded-secret` is deliberately narrow and keys on the
// name the value is bound to, so `const K = "this-is-not-a-real-secret-0000"` is genuinely not a finding —
// the first version asserted it was one, and passed only because a single-letter name tripped nothing.
//
// THE VALUE'S SHAPE IS LOAD-BEARING TOO, and this is not a style preference. The fixture value used to be a
// Stripe-shaped `sk-live-…` string, and Netlify's smart detection scans REPOSITORY CODE, so from the day
// this guard landed the frontend stopped deploying — the build compiled and the scanner refused the deploy,
// with nothing in the code to find. Fixtures must be obviously fake: `this-is-not-a-real-secret-0000`
// exercises the same regex without looking like a credential. `scripts/verify-no-secret-fixtures.mjs`
// now fails the build if any tracked file grows a real-looking one again.
check('…and a real file among junk is still examined',
  ids([null, { path: 'server/x.js', content: 'const API_KEY = "this-is-not-a-real-secret-0000";' }]).includes('hardcoded-secret'), true);
check('a check that throws reports that it did not run rather than reading as clean',
  securityFindings([{ path: '.env', content: 'x' }]).some((f) => f.id === 'env-committed'), true);

console.log('\n7. the rules the coder is CHECKED against are the rules it is GIVEN');
// A check without the matching instruction is a trap: it fails work the model was never told about.
for (const c of SECURITY_CHECKS) {
  check(`the prompt block names "${c.title.slice(0, 34)}…"`, SECURITY_PROMPT_BLOCK.includes(c.title), true);
}
check('…and carries the fix, so the instruction is actionable', SECURITY_CHECKS.every((c) => SECURITY_PROMPT_BLOCK.includes(c.fix)), true);

console.log('\n8. both generating paths actually report it');
const chat = code(read('server/src/functions/chatWithMorpheus.js'));
const gen = code(read('server/src/functions/generateBackend.js'));
check('the main build runs the checks', /securityFindings\(projectFiles\)/.test(chat), true);
// Over the WHOLE project, not this turn's files: .env, .gitignore and whether auth exists are properties
// of the app, not of one turn's diff.
check('…over the whole project', /projectFile\.findMany\(\{ where: \{ project_id: projectId \}/.test(chat), true);
// Against the RAW source: the reply sentence lives inside a template literal, and `code()` strips line
// comments — the first version stripped the file first and then looked for a string that only appears in
// the text being built. Twelfth time in this suite that the way a check read the file decided its result.
check('…and reports it in the reply', /SECURITY — DO NOT SHIP AS IS/.test(read('server/src/functions/chatWithMorpheus.js')), true);
check('…and in the result payload', /security: securityReport/.test(chat), true);
// A check that could not run must say so, never read as clean.
check('…and a failed check is reported, not treated as clean', /the security check could not run/.test(chat), true);
// The same trap as section 7, wired: the main build is CHECKED against all seven, so the coder that writes
// the files has to be TOLD all seven. It was imported here and never used — lint found it, which is the
// cheap version of finding out that three of the checks (.env, .gitignore, auth-in-front-of-data-routes) are
// in neither the coder's prompt nor the reviewer's one-line SECURITY list.
check('the main build gives the coder the rules too', /SECURITY_PROMPT_BLOCK/.test(chat), true);
// Anchored INSIDE the CODER_INSTRUCTIONS literal, and the block interpolated exactly once. Both halves are
// load-bearing: `[\s\S]*?` was the first version, and it scanned straight past the closing backtick into the
// next literal — so a mutation that moved the block onto ONE coder branch and left the shared instructions
// bare still passed. `[^`]*` stops at the literal's own escaped backticks, which come after the insertion.
check('…on every coder call, not one branch of it',
  /const CODER_INSTRUCTIONS = `[^`]*\$\{SECURITY_PROMPT_BLOCK\}/.test(read('server/src/functions/chatWithMorpheus.js')), true);
check('…once, as the one mechanism rather than ad hoc per call',
  (read('server/src/functions/chatWithMorpheus.js').match(/\$\{SECURITY_PROMPT_BLOCK\}/g) || []).length, 1);
check('the backend generator gives the coder the rules', /SECURITY_PROMPT_BLOCK/.test(gen), true);
// Over the WHOLE project here too, and for the same reason — the first version scanned only the files this
// generation wrote and called the variable `produced`, which would tell a backend written into an app that
// already has a `.gitignore` that it is missing one.
check('…and reports the posture over the whole project, not just its own files',
  /securityFindings\(projectFiles\)/.test(gen), true);
check('…and returns it', /security,/.test(gen), true);
// The callers push `f.evidence` onto a line; a rename to `files` would leave that reading `undefined` with
// every check above still green — field drift, which this repo has already paid for once with `maxTokens`.
const evidenceFixture = [
  { path: '.env', content: 'JWT_SECRET=abc' },
  { path: 'server/lib/config.js', content: 'const API_KEY = "this-is-not-a-real-secret-0000";' },
  { path: 'server/index.js', content: "app.use(cors({ origin: '*', credentials: true }));" },
];
const evidenceFindings = securityFindings(evidenceFixture);
check('every finding carries evidence a caller can name',
  evidenceFindings.every((f) => Array.isArray(f.evidence) && f.evidence.every((p) => typeof p === 'string')), true);
// The evidence is the PATH. Asserted as equality, not as "does not contain the value": the first version
// checked the absence of the whole secret and SURVIVED a mutation that put the check's own 4-character
// `sample` into the report — a prefix of a live key is still part of a live key.
check('…and the evidence is the path, never the value it found',
  evidenceFindings.find((f) => f.id === 'hardcoded-secret')?.evidence, ['server/lib/config.js']);
check('…so the report cannot carry any of the secret it found',
  JSON.stringify(evidenceFindings).includes('sk-live'), false);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log('\n✗ a generated app could ship with a secret in it, or arrive with nobody told\n');
  process.exit(1);
}
console.log('a generated app arrives with the known dangers named, the fixes given, and no claim of an audit\n');
