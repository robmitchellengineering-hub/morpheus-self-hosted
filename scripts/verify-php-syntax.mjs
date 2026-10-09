// Is a WordPress change verified in the language it is written in — is the WIRING still there?
//
// THE HOLE THIS EXISTS FOR
//
// The first live customer target is a WordPress site, so a tenant's normal change is PHP. Until
// 2026-10-09 the verify tier read only JS/TS: `engine/verificationCoverage.js` counted code files from a
// static extension list, a PHP-only change counted zero, and coverage correctly reported `not_verified` —
// honest, and no protection at all. The delivery adapter's own note said where the real check was —
// *"PHP lint and the theme build run in the target repo's CI"* — which is an assumption about a repo
// nobody had checked, carrying the entire safety story for a change about to reach a live shop.
//
// `php-parser` (a real PHP parser, in JS, so it runs in the backend container that has no `php`) closes it.
//
// ⚠️ WHY THIS FILE IS TEXT AND NOT BEHAVIOUR. The real assertion needs the parser installed, and the guards
// job installs nothing on purpose (H4). `verify-guards-no-install.mjs` follows DYNAMIC imports, so a script
// in this job cannot even reach `syntaxCheck.js`, which lazily imports `esbuild` and `php-parser`. The
// behaviour therefore lives in `scripts/verify-php-syntax-behaviour.mjs`, run by the `lint + build` job.
// This half asserts the WIRING, and it is not decoration: the behaviour test calls the adapter directly, so
// it would still pass if a caller quietly went back to counting extensions it hopes are covered.
//
// Run:  node scripts/verify-php-syntax.mjs
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

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

console.log('\nWordPress changes are verified in the language they are written in\n');

const syntax = read('server/src/lib/syntaxCheck.js');
const engineVerify = read('server/src/lib/engine/verify.js');
const wpAdapter = read('server/src/lib/delivery/wordpress.js');

// ── The checker ─────────────────────────────────────────────────────────────
check('PHP is a language this checker knows',
  /const PHP_EXT = \/\\\.php\$\/i;/.test(syntax), true);
check('…and it is routed to a real parser, not a brace counter',
  /await import\('php-parser'\)/.test(syntax) && /parseCode\(/.test(syntax), true);
// A parser that recovers returns an AST for a file that does NOT parse — the one behaviour that would
// make this check worse than useless, because it would report a verdict on unparseable code.
check('…with error recovery OFF, because recovering hands back an AST for a file that does not parse',
  /suppressErrors: false/.test(syntax), true);

// ── What "checked" means — the anti-false-pass rule ─────────────────────────
check('the checker reports the files it READ, not the extensions it hopes are covered',
  /export async function checkSyntaxDetailed/.test(syntax) && /checked,?\s*\};|checked \};/.test(syntax), true);
// ⚠️ THE RULE THAT MAKES ADDING A LANGUAGE SAFE. If a file counted as "checked" merely because its
// extension matched, then adding `.php` would have turned today's honest `not_verified` into a PASS over
// files nothing had read — H17, caused by the change meant to fix it.
check('…and a language whose tool is MISSING contributes nothing to that list',
  /\(js\.available \? jsFiles : \[\]\)/.test(syntax)
  && /\(py\.available \? pyFiles : \[\]\)/.test(syntax)
  && /\(php\.available \? phpFiles : \[\]\)/.test(syntax), true);

// ── The callers count what was read ─────────────────────────────────────────
check('the WordPress adapter sends every present file to the checker',
  /checkSyntaxDetailed\(present\.map/.test(wpAdapter), true);
check('…and its verdict counts what was CHECKED, not what its extension said',
  /codeFiles: syntax\.checked\.length/.test(wpAdapter), true);
// The specific way this hole comes back: narrowing the input to JS again. Asserted as an ABSENCE,
// because re-adding one `.filter()` is all it takes and every other check here would still pass.
check('…and the JS-only pre-filter is GONE, which is exactly how the hole was reopened',
  /present\.filter\(\( f \) => \/\\\.\(jsx\?|present\.filter\(\(f\) => \/\\\.\(jsx\?/.test(wpAdapter), false);
check('the self-dev gate counts the same way, so one rule serves both engines',
  /checkSyntaxDetailed\(kept\.map/.test(engineVerify)
  && /const codeFiles = syntax\.checked;/.test(engineVerify)
  && /coverageError\(\{ codeFiles: codeFiles\.length/.test(engineVerify), true);

// ── And it is wired into the gate and into CI ───────────────────────────────
const ci = read('.github/workflows/ci.yml');
check('the guard is wired into the one gate and run by CI',
  /'verify-php-syntax\.mjs'/.test(read('scripts/verify.mjs')) && /node scripts\/verify-php-syntax\.mjs/.test(ci), true);
// The behavioural half needs `php-parser`, which this job does not install — so it is re-run in the one
// job that does. Asserted here, because a behaviour proven only locally is a behaviour nobody runs.
check('…and its behavioural half is re-run in the job that HAS the dependency',
  (ci.match(/node scripts\/verify-php-syntax\.mjs/g) || []).length >= 2, true);

// ── The behaviour, in a CHILD PROCESS ───────────────────────────────────────
//
// ⚠️ WHY A CHILD AND NOT AN IMPORT. This script runs in the guards job, which installs nothing, and
// `verify-guards-no-install.mjs` follows RELATIVE imports — static or dynamic — into any package they reach.
// `syntaxCheck.js` lazily imports `esbuild` and `php-parser`, so importing it here would fail that
// meta-check, and importing it only sometimes would make this guard's verdict depend on the machine.
// A spawned process with the module path as an ARGUMENT keeps the dependency out of this file's graph
// entirely, and gives one honest answer for both environments:
//
//   exit 0 — the behaviour was proven here
//   exit 3 — the parser is not installed in this environment: NOT VERIFIED, said out loud
//   exit 1 — the behaviour is broken, which is a failure wherever it runs
const PROBE = `
// node -e <src> A B puts the first argument at argv[1] — there is no script path to skip.
const [syntaxPath, adapterPath] = process.argv.slice(1);
let checkSyntaxDetailed, wordpressDelivery;
try {
  ({ checkSyntaxDetailed } = await import(syntaxPath));
  ({ wordpressDelivery } = await import(adapterPath));
} catch (e) {
  console.error('NOT_AVAILABLE ' + e.message);
  process.exit(3);
}
const out = [];
const ok = (name, cond, detail) => out.push({ name, ok: !!cond, detail: detail === undefined ? '' : JSON.stringify(detail) });
const theme = 'wp-content/themes/woodmart';
const good = { path: theme + '/page.php', content: '<?php function ok( $a ) { return $a + 1; }' };
const bad  = { path: theme + '/header.php', content: '<?php function broken( $a { return $a + 1; }' };
const notCode = { path: theme + '/readme.txt', content: 'nothing to parse here' };

const clean = await checkSyntaxDetailed([good, notCode]);
ok('a clean PHP file parses with no errors', clean.errors.length === 0, clean.errors);
ok('…and the file it read is named in checked', clean.checked.join() === good.path, clean.checked);
ok('…while a file no checker handles is not counted as read', !clean.checked.includes(notCode.path));
const broken = await checkSyntaxDetailed([bad]);
ok('a broken PHP file is caught', broken.errors.length === 1);
ok('…with a file and a line, which is what makes it actionable',
  broken.errors[0] && broken.errors[0].file === bad.path && broken.errors[0].line > 0, broken.errors[0]);
ok('…and it is in checked, because it really was read', broken.checked.join() === bad.path, broken.checked);

const pass = await wordpressDelivery.verify({ files: [good] });
ok('a valid PHP-only change is VERIFIED, not merely unchecked', pass.status === 'passed', pass.status);
ok('…with the file counted as checked', pass.checkedFiles === 1, pass.checkedFiles);
const fail = await wordpressDelivery.verify({ files: [bad] });
ok('a broken PHP-only change FAILS, before it is written', fail.status === 'failed', fail.status);
ok('…with the error named', fail.errors[0] && fail.errors[0].file === bad.path);
const empty = await wordpressDelivery.verify({ files: [notCode] });
ok('a change with nothing to parse is still NOT VERIFIED, never a pass', empty.status === 'not_verified', empty.status);
const denied = await wordpressDelivery.verify({ files: [{ path: 'wp-config.php', content: '<?php' }] });
ok('…and a denied path is not read at all', denied.status === 'not_verified' && denied.checkedFiles === 0, [denied.status, denied.checkedFiles]);

console.log(JSON.stringify(out));
`;
const probeArgv = [
  '--input-type=module', '-e', PROBE,
  join(ROOT, 'server/src/lib/syntaxCheck.js'),
  join(ROOT, 'server/src/lib/delivery/wordpress.js'),
];
let probe;
try {
  probe = spawnSync(process.execPath, probeArgv, { encoding: 'utf8', timeout: 120000 });
} catch (e) {
  probe = { status: 1, stdout: '', stderr: String(e.message) };
}

if (probe.status === 3) {
  // The repo's convention for "I could not look here": loud, and never counted as a pass. The same
  // script is run in `lint + build`, which has the dependency, so this is not a silent skip.
  console.log('  NOT VERIFIED (php-parser not installed here) the PHP behaviour — re-run in `lint + build`');
} else if (probe.status !== 0) {
  console.log(`  FAIL  the PHP probe itself could not run (exit ${probe.status})`);
  console.log(`        ${(probe.stderr || '').trim().split('\n').slice(0, 6).join('\n        ')}`);
  failures++;
} else {
  let results = [];
  try { results = JSON.parse(probe.stdout.trim().split('\n').pop()); } catch { results = null; }
  if (!Array.isArray(results) || !results.length) {
    console.log('  FAIL  the PHP probe printed nothing usable'); failures++;
  } else {
    for (const r of results) {
      checks++;
      if (r.ok) console.log(`  PASS  ${r.name}`);
      else { console.log(`  FAIL  ${r.name}\n          ${r.detail}`); failures++; }
    }
  }
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log('\n✗ a WordPress change is not verified in the language it is written in.\n');
  process.exit(1);
}
console.log('PHP is routed to a real parser, read before it reaches a site, and "could not check" is still its own answer\n');
