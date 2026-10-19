// Does Portable Morpheus actually install on Windows and Linux, or only on the machine it was written on?
//
// WHY THIS EXISTS. Two spawn calls in the install path worked on macOS and were broken on Windows, and
// broken in the worst way available: several steps in, after the user had already been told things were
// going well.
//
//   1. `spawnSync('npm', ...)` — Node 20 refuses to spawn a `.cmd` without a shell (the fix for
//      CVE-2024-27980), and npm on Windows IS `npm.cmd`. So dependency installation died.
//   2. `execFileSync('<...>/.bin/prisma', ...)` — on Windows that directory holds `prisma.cmd` and a
//      shebang-only `prisma` that is not executable. So the schema step died too, in a script
//      (`dev-db.mjs`) two layers away from anything that looked platform-specific.
//
// Neither is reachable from a Mac, so neither was ever going to be found by running the installer
// here. What can be checked from here is the DECISION: `lib/platformCli.js` is pure and takes the
// platform as an argument, so this guard exercises win32, linux and darwin argv on any host — and
// separately asserts that the two CLIs actually go through it rather than spawning directly again.
//
// It also pins the per-platform STEPS, because "it installs on Linux" is not a claim a user can act
// on. Three of the four things that go wrong on a fresh machine are outside this repo (no Node, no C
// toolchain, no way to double-click a shell script), so the steps have to name them.
//
// Run:  node scripts/verify-portable-platform.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  PLATFORM_STEPS, platformSteps, setupCommand, pathCommand, nodeCommand, binCommand,
  spawnOptions, quoteForCmd,
} from '../server/src/lib/platformCli.js';
import { LAUNCHERS } from '../server/src/lib/portableLaunch.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
// Comments out before asserting: three checks in this session's sibling guards matched their own
// explanatory prose, and the two files below both QUOTE the bug they fix in a comment.
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');

let failures = 0;
let checks = 0;
function check(name, actual, expected) {
  checks++;
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name}\n          expected ${e}\n          got      ${a}`); failures++; }
}

const PLATFORMS = ['darwin', 'linux', 'win32'];

console.log('\n1. one spawn mechanism, and it is not a shell flag');
// The Windows fix lives in the ARGV (`cmd.exe /c`), so `shell` stays false EVERYWHERE. Passing both
// would wrap the command twice — which works, and therefore hides: `cmd.exe /c "cmd.exe /c npm ..."`
// only shows up as duplicated quoting, and only on the platform nobody here is testing on.
check('no platform asks spawn for a shell', PLATFORMS.map((p) => spawnOptions(p).shell).join(','), 'false,false,false');
check('the wrapper is in the argv instead',
  pathCommand('win32', 'npm', ['x'])[0] === 'cmd.exe' && pathCommand('win32', 'npm', ['x'])[1] === '/c', true);

console.log('\n2. a command that POSIX runs directly, Windows runs through cmd.exe');
check('npm on macOS is plain argv', pathCommand('darwin', 'npm', ['install']).join(' '), 'npm install');
check('npm on Linux is plain argv', pathCommand('linux', 'npm', ['install']).join(' '), 'npm install');
check('npm on Windows goes through cmd /c', pathCommand('win32', 'npm', ['install']).join(' '), 'cmd.exe /c npm install');
check('…and flags survive the round trip',
  pathCommand('win32', 'npm', ['install', '--no-audit', '--no-fund']).join(' '), 'cmd.exe /c npm install --no-audit --no-fund');
check('an empty argv is still just the command', pathCommand('linux', 'npm').join(' '), 'npm');

console.log('\n3. node is never wrapped — it is a real executable on every platform');
check('node argv is identical everywhere',
  PLATFORMS.map((p) => nodeCommand(process.execPath, 'server/scripts/dev-db.mjs', ['start']).join(' ')).length >= 1
  && new Set(PLATFORMS.map((p) => nodeCommand(process.execPath, 'x.mjs', []).join('|'))).size, 1);
check('…and it does not invoke a shell', nodeCommand('/usr/bin/node', 'x.mjs').join(' '), '/usr/bin/node x.mjs');

console.log('\n4. a node_modules CLI is named explicitly on Windows');
// `.bin/prisma` on Windows is a shebang-only file that Node cannot execute, sitting beside the
// `prisma.cmd` that works. The path passed in is therefore the extensionless one, every time.
const bin = join('/repo', 'server', 'node_modules', '.bin', 'prisma');
check('on macOS the path is used as given', binCommand('darwin', bin, ['db', 'push'])[0], bin);
check('on Windows the .cmd is named', binCommand('win32', bin, ['db', 'push'])[1], '/c');
check('…and the command is the shell', binCommand('win32', bin, ['db', 'push'])[0], 'cmd.exe');
check('…with the .cmd suffix added, not assumed',
  /prisma\.cmd/.test(binCommand('win32', bin, ['db', 'push']).join(' ')), true);
check('…and the POSIX form has no suffix', /prisma$/.test(binCommand('linux', bin, ['db', 'push'])[0]), true);

console.log('\n5. quoting, because cmd is not a POSIX shell');
check('a plain argument is left alone', quoteForCmd('install'), 'install');
check('a path with spaces is quoted', quoteForCmd('C:\\Program Files\\nodejs\\node.exe'), '"C:\\Program Files\\nodejs\\node.exe"');
// `&` inside an unquoted cmd argument starts a SECOND command; this is command injection, not a
// cosmetic issue, and a temp path or user name is enough to produce one.
check('an ampersand cannot start a second command', quoteForCmd('a&b'), '"a&b"');
check('…nor a pipe', quoteForCmd('a|b'), '"a|b"');
// `%` expands a variable even inside quotes, so it is escaped rather than trusted.
check('a percent is escaped, quoted or not', quoteForCmd('a%b'), 'a%%b');
check('an empty argument stays a distinct argument', quoteForCmd(''), '""');
check('a caret cannot escape a quote', quoteForCmd('a^b'), '"a^b"');

console.log('\n6. the two CLIs go through it instead of spawning their own way');
const setup = code(read('scripts/portable-setup.mjs'));
const devDb = code(read('server/scripts/dev-db.mjs'));
check('the setup runs npm through pathCommand, all three times',
  (setup.match(/pathCommand\(process\.platform, 'npm'/g) || []).length, 3);
check('…and never spawns a bare npm again', /run\('npm'/.test(setup), false);
// THE ARGV SPLIT, which is where this went wrong the first time: `run(cmd, args, cwd)` was called as
// `run(...pathCommand(...), cwd)`, so `args` arrived as the STRING 'install' and Node threw
// ERR_INVALID_ARG_TYPE at the first npm call — after the database had already been started. Every
// platform hit it, and the guard above passed anyway because it only asked whether pathCommand was
// mentioned. So: the helper must exist, and every npm call must go through it.
check('the argv split has one helper, so no call site can get it wrong', /function runCli\(command, cwd\)/.test(setup), true);
check('…and every npm call goes through it',
  (setup.match(/runCli\(pathCommand/g) || []).length, 3);
check('…and no call spreads an argv into run() again',
  /run\(\.\.\.pathCommand|run\(\.\.\.[a-zA-Z]/.test(setup), false);
check('…and each npm call names the directory it runs in',
  (setup.match(/runCli\(pathCommand\(process\.platform, 'npm', \[[^\]]*\]\), (ROOT|SERVER)\)/g) || []).length, 3);
check('…and never asks for a shell as well', /shell: needsShell/.test(setup), false);
check('…using the one spawn helper, so the two CLIs cannot diverge',
  /spawnOptions\(process\.platform\)/.test(setup), true);
check('dev-db runs prisma through binCommand', /binCommand\(/.test(devDb), true);
check('…and no longer execs the .bin path directly', /execFileSync\(join\(SERVER, 'node_modules', '\.bin'/.test(devDb), false);
check('…and never asks for a shell as well', /shell: needsShell/.test(devDb), false);
check('…using the same spawn helper as the setup', /spawnOptions\(process\.platform\)/.test(devDb), true);
check('the platform rule has ONE home, imported rather than copied',
  /from '\.\.\/\.\.\/server\/src\/lib\/platformCli\.js'/.test(devDb)
  && /from '\.\.\/server\/src\/lib\/platformCli\.js'/.test(setup), true);

console.log('\n7. every platform a user can download for has steps');
for (const p of PLATFORMS) {
  const steps = platformSteps(p);
  check(`${p}: has a plain-language label`, typeof steps?.label === 'string' && steps.label.length > 2, true);
  check(`${p}: names Node as a prerequisite`, steps.prerequisites.some((s) => /Node/.test(s.need)), true);
  // Only the things the user must actually DO need a command; "no database to install" is a
  // reassurance, and demanding a command for it would force a fake one into the copy.
  check(`${p}: every prerequisite that is an ACTION says how, with a command or a URL`,
    steps.prerequisites.filter((s) => !/^No /.test(s.need))
      .every((s) => /https:\/\/|apt install|dnf |brew |xcode-select|new Command Prompt/i.test(s.how)), true);
  check(`${p}: and the one reassurance names where the database lives instead`,
    steps.prerequisites.some((s) => /server[\\/]data[\\/]pg/.test(s.how)), true);
  check(`${p}: says no database needs installing`, steps.prerequisites.some((s) => /No database/.test(s.need)), true);
  check(`${p}: names the launcher file that ships`, Boolean(LAUNCHERS.find((l) => l.file === steps.launcher && l.platform === p)), true);
  check(`${p}: says what to do when the launcher is refused`,
    /Right-click|SmartScreen|chmod|trust/i.test(steps.launcherNote), true);
  check(`${p}: says where to run things`, typeof steps.terminal === 'string' && steps.terminal.length > 5, true);
}
check('an unsupported platform gets nothing rather than a wrong guess', platformSteps('sunos'), null);
check('there is a step entry per platform the install supports, and no extras',
  Object.keys(PLATFORM_STEPS).sort().join(','), 'darwin,linux,win32');

console.log('\n8. the setup command is one form, not one per platform');
check('it is the same string everywhere', setupCommand('win32'), setupCommand('darwin'));
check('…and it is the script that exists', setupCommand(), 'node scripts/portable-setup.mjs');

console.log('\n9. --check can be read for another platform, so these steps are not guesswork');
check('the setup accepts --platform', /--platform/.test(setup), true);
check('…and it only changes what --check prints', /REPORT_PLATFORM/.test(setup) && /const PLATFORM_ARG/.test(setup), true);
check('…rejecting an unknown value instead of printing nothing',
  /PLATFORM_STEPS_HAS\(PLATFORM_ARG\) \? PLATFORM_ARG : process\.platform/.test(setup), true);
// EXECUTED, not just read: the whole point is that a Mac can print the Windows steps, and a path typo
// in the module would otherwise pass every assertion above.
for (const p of PLATFORMS) {
  const proc = spawnSync(process.execPath, [join(ROOT, 'scripts/portable-setup.mjs'), '--check', '--platform', p], { encoding: 'utf8', timeout: 60000 });
  const said = `${proc.stdout}${proc.stderr}`;
  check(`--check --platform ${p} exits 0`, proc.status, 0);
  check(`…and prints that platform's launcher`, said.includes(PLATFORM_STEPS[p].launcher), true);
  check(`…and its first prerequisite`, said.includes(PLATFORM_STEPS[p].prerequisites[0].how.slice(0, 30)), true);
  check(`…and never a stack trace`, /SyntaxError|ERR_MODULE_NOT_FOUND|at ModuleJob/.test(said), false);
}
check('an unknown platform falls back to this machine rather than crashing',
  spawnSync(process.execPath, [join(ROOT, 'scripts/portable-setup.mjs'), '--check', '--platform', 'sunos'], { encoding: 'utf8', timeout: 60000 }).status, 0);

console.log('\n10. the closing summary and the plan agree');
check('the summary no longer sends the user to `cd server && npm start`',
  /cd server && npm start/.test(setup), false);
check('…it names the launcher for this platform', /launcherFor\(process\.platform\)/.test(setup), true);
// Lookbehind, so the function's own DEFINITION is not counted as a call — the same class of mistake
// as an assertion matching its own comment, which this suite has made five times today.
check('…and both print the same platform table', (setup.match(/(?<!function )sayPlatformSteps\(\)/g) || []).length, 2);
check('…and the steps are printed from the module, not retyped in the script',
  /platformSteps\(REPORT_PLATFORM\)/.test(setup), true);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log('\n✗ the install would work on the machine it was written on, and not on someone else\'s\n');
  process.exit(1);
}
console.log('the same one command installs on macOS, Linux and Windows, and each is told what it needs first\n');
