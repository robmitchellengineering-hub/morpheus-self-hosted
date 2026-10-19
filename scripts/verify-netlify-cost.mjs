// Does the repository still refuse to build a deploy preview for every pull request?
//
// WHY THIS EXISTS. On 2026-10-01 morpheus.nz answered `503 usage_exceeded` on every path — including
// robots.txt — because the Netlify account ran out of build credits. `netlify.toml` records it. On 2026-10-05
// it happened again, and the volume was easy to count: five pull requests for one workstream plus a few
// rebase force-pushes was about thirteen FULL builds, because every push builds — a preview for a branch and
// a production deploy for main. Rob paid for more credits both times.
//
// The preview half is the larger half and it buys almost nothing here: the three checks that gate a merge are
// GitHub Actions (`guards (no install)`, `lint + build`, `render`), and `npm run render:check` is the local
// equivalent of what a preview would show.
//
// ⚠️ AND THIS GUARD EXISTS BECAUSE A CONFIGURATION LINE IS THE EASIEST THING IN A REPOSITORY TO DELETE
// SILENTLY. It is two lines in a file nobody reads, its absence costs nothing until the next outage, and the
// person who removes it will have a reason ("the preview was useful for this one change") that looks
// reasonable in isolation. That is the shape of every rule in this file's neighbourhood, so it is asserted.
//
// IT ASSERTS THE ABSENCE OF THE TRAP AS WELL AS THE PRESENCE OF THE FIX. `netlify.toml` already warns that a
// PATH-based `ignore` is a trap — an incomplete path list leaves the deployed site quietly stale, and it
// cannot be tested from a repository. This guard would otherwise be satisfied by exactly that: a rule that
// skips builds for `scripts/**` and takes `main` with it on the day the path list is wrong. So a `git diff`
// in the ignore command fails here too.
//
// Dependency-free — reads two text files. Run: node scripts/verify-netlify-cost.mjs
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
let checks = 0;
function check(name, actual, expected) {
  checks++;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name}\n          expected ${e}\n          got      ${a}`); failures++; }
}
function truthy(name, ok) {
  checks++;
  if (ok) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name}`); failures++; }
}

const toml = readFileSync(join(ROOT, 'netlify.toml'), 'utf8');

/**
 * The `[build]` table's own keys, without a TOML parser.
 *
 * A parser would be the tidier way to read one key, and it is not worth a dependency in the job that
 * deliberately installs nothing. The failure this has to avoid is reading `ignore` out of a DIFFERENT table —
 * `[build.environment]` is full of key/value lines — so the slice is bounded by the next table header.
 */
function buildTable(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.trim() === '[build]');
  if (start < 0) return null;
  const out = {};
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('[')) break; // the next table; [build.environment] is one
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq > 0) out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

console.log('\n1. the [build] table carries an ignore command');
const build = buildTable(toml);
truthy('netlify.toml has a [build] table', build !== null);
check('…with an ignore command in it', typeof build?.ignore, 'string');

console.log('\n2. the command skips deploy previews, and nothing else');
// `CONTEXT` is one of production | deploy-preview | branch-deploy | dev, and `ignore` exits 0 to STOP a build.
// So the command has to name the preview context and compare against it — a command that returns 0
// unconditionally would stop PRODUCTION deploys, which is the one outcome worse than the bill.
const ignore = build?.ignore || '';
truthy('…keyed on the deploy context rather than on paths', /\$CONTEXT/.test(ignore) || /CONTEXT/.test(ignore));
truthy('…and specifically on the deploy-preview context', /deploy-preview/.test(ignore));
// The exact semantics, evaluated rather than trusted: exit 0 for a preview, non-zero for every other context.
// A rule that skipped production would never be noticed until the live site stopped updating.
const { spawnSync } = await import('node:child_process');
const statusFor = (context) => spawnSync('bash', ['-c', ignore.replace(/^"|"$/g, '')], {
  env: { ...process.env, CONTEXT: context },
}).status;
check('a deploy preview is SKIPPED (exit 0)', statusFor('deploy-preview'), 0);
check('production is NOT skipped (non-zero)', statusFor('production') !== 0, true);
check('a branch deploy is NOT skipped (non-zero)', statusFor('branch-deploy') !== 0, true);

console.log('\n3. and it is the context rule, not the path rule this repository already rejected');
// The documented trap: `git diff --quiet $CACHED_COMMIT_REF $COMMIT_REF <paths>` skips builds by path, and an
// incomplete path list leaves the deployed site stale. Asserted as an absence, because this is the shape a
// well-meaning "let us also skip docs-only changes" edit would take.
truthy('the ignore command does NOT diff paths (the stale-site trap)', !/git\s+diff/.test(ignore));
truthy('…and does not skip unconditionally, which would stop production deploys',
  !/^\s*(exit\s+0|true|:)\s*$/.test(ignore.replace(/^"|"$/g, '').trim()));

console.log('\n4. the reasoning is still next to the rule');
// The rule is two lines; the reason it exists is five paragraphs above it. A future session that deletes the
// rule should have to delete the incident record with it, which is a harder thing to do by accident.
truthy('netlify.toml still records why previews are off', /DEPLOY PREVIEWS ARE OFF/.test(toml));
truthy('…and still names the trap it is not', /NOT THE TRAP THIS FILE ALREADY WARNS ABOUT/.test(toml));

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log('\n✗ every push builds, and a preview per pull request is most of the bill.\n');
  process.exit(1);
}
console.log('pull requests do not build the site; merges to main still do\n');
