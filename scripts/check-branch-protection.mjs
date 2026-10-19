// Is GitHub actually enforcing the gates this repo requires on `main`?
//
// WHY THIS EXISTS
//
// Branch protection was enabled on 2026-09-24 with a hand-run `gh api` call, so
// until this script existed nothing on disk could tell whether it was still
// there. The comparison itself is pure and asserted in CI
// (server/src/lib/branchProtectionRules.js); this file is only the live reading.
//
// It is deliberately NOT part of scripts/verify.mjs. It needs `gh` and an
// authenticated token, and a "gate" that fails on a machine without either gets
// switched off within a week instead of being fixed. It reports loudly instead:
//
//   node scripts/check-branch-protection.mjs
//
// VERIFYING IT CAN FAIL
//
// A check nobody has watched fail is not a check. `--from <file>` takes the
// protection object from a JSON file instead of GitHub, so the drift branches can
// be exercised with no network:
//
//   node scripts/check-branch-protection.mjs --from /tmp/drift.json
//
// Exit codes: 0 = enforced as required, 1 = drift, 0 = SKIPPED (and says so).
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SELF_DEV_REQUIRED_CHECKS } from '../server/src/lib/engine/requiredChecks.js';
import { protectionVerdict, protectionMessage } from '../server/src/lib/branchProtectionRules.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BRANCH = 'main';

const fromIndex = process.argv.indexOf('--from');
const fromFile = fromIndex === -1 ? null : process.argv[fromIndex + 1];

/** Read the live rule, or `null` when GitHub says the branch is unprotected. */
function readLive() {
  let raw;
  try {
    raw = execFileSync('gh', ['api', `repos/:owner/:repo/branches/${BRANCH}/protection`], {
      cwd: REPO,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const stderr = String(err?.stderr || '');
    // 404 is a real answer, not a failure to ask: the branch is unprotected.
    if (stderr.includes('Branch not protected') || stderr.includes('404')) return null;
    return { unavailable: stderr.trim() || String(err?.message || err) };
  }
  return JSON.parse(raw);
}

let protection;
if (fromFile) {
  protection = JSON.parse(readFileSync(fromFile, 'utf8'));
  console.log(`Reading protection from ${fromFile} (not GitHub).`);
} else {
  protection = readLive();
}

if (protection && protection.unavailable) {
  // Loud, and never exit 0 silently claiming a pass — the whole hazard this repo
  // keeps hitting (H17) is a check that did not run reading as a pass.
  console.log(`SKIPPED — nothing was verified. Could not read ${BRANCH}'s protection from GitHub:`);
  console.log(`  ${protection.unavailable}`);
  console.log('Needs an authenticated `gh` (gh auth login) with admin on this repo.');
  process.exit(0);
}

const verdict = protectionVerdict(protection, SELF_DEV_REQUIRED_CHECKS);

console.log(`branches/${BRANCH} protection`);
console.log(`  required by this repo : ${verdict.required.join(', ') || '(none)'}`);
console.log(`  enforced by GitHub    : ${verdict.enforced.join(', ') || '(none)'}`);
console.log(`  strict (up to date)   : ${verdict.strict}`);
console.log(`  force-pushes allowed  : ${verdict.forcePushes}`);
console.log(`  deletion allowed      : ${verdict.deletions}`);
console.log(`  admins bypass         : ${verdict.adminsBypass}`);
console.log('');
console.log(protectionMessage(verdict));

if (!verdict.ok) {
  console.log('\nFAIL — the merge gate GitHub enforces does not match the one this repo declares.');
  process.exit(1);
}
console.log('\nPASS');
