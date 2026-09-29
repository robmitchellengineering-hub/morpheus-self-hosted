// Does remote access work the way it says, without doing anything it has no business doing?
//
// WHY THIS EXISTS. This is the one part of Portable Morpheus that asks a stranger to expose a machine,
// so two failure modes are worse than "it did not work":
//
//   1. A script that INSTALLS a VPN for you. System-level, needs admin rights and an account sign-in —
//      a setup script that does that silently is not one anybody should trust.
//   2. A script that GUESSES `tailscale serve`'s syntax. It has changed across versions, and guessing
//      means doing something other than what it says. The front page taught this repo the same lesson
//      in miniature: a button's label changes, and the copy that named it becomes a lie.
//
// So this asserts the rule (URL parsing, readiness, the commands), the refusals (no install, no funnel,
// no mutation before the checks), and that the honest caveats are stated rather than implied.
//
// Dependency-free, so it runs in CI's no-install guards job.
//
// Run:  node scripts/verify-portable-remote.mjs
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  tailscaleInstallHint, remoteUrlFromStatus, tailscaleReady, serveCommands, backendPublicUrlLine,
  REMOTE_STEPS, REMOTE_CAVEATS,
} from '../server/src/lib/portableRemote.js';
import { NOT_INSTALLED_YET } from '../server/src/lib/portableSetup.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

let failures = 0;
let checks = 0;
function check(name, actual, expected) {
  checks++;
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name}\n          expected ${e}\n          got      ${a}`); failures++; }
}

console.log('\n1. the tailnet URL comes from the CLI, not from us');
check('a normal status yields an https URL with the trailing FQDN dot removed',
  remoteUrlFromStatus({ Self: { DNSName: 'studio-mac.tail1234.ts.net.' } }), 'https://studio-mac.tail1234.ts.net');
check('no trailing dot is fine too', remoteUrlFromStatus({ Self: { DNSName: 'mac.ts.net' } }), 'https://mac.ts.net');
check('a missing name is null, not a guessed URL',
  [remoteUrlFromStatus({}), remoteUrlFromStatus({ Self: {} }), remoteUrlFromStatus(null)].map(String).join(','), 'null,null,null');
check('a name that is not a hostname is refused rather than interpolated',
  remoteUrlFromStatus({ Self: { DNSName: 'not a host/path' } }), null);

console.log('\n2. it refuses before it changes anything');
check('a signed-out tailnet is refused, with the fix named',
  tailscaleReady({ BackendState: 'NeedsLogin', Self: { DNSName: 'm.ts.net.' } }).reason.includes('tailscale up'), true);
check('a stopped tailnet is refused', tailscaleReady({ BackendState: 'Stopped', Self: { DNSName: 'm.ts.net.' } }).ok, false);
check('a running tailnet with a name is ready',
  tailscaleReady({ BackendState: 'Running', Self: { DNSName: 'm.ts.net.' } }).ok, true);
check('no status at all is refused', tailscaleReady(undefined).ok, false);

console.log('\n3. the verb is serve, never funnel');
const cmds = serveCommands(4500);
check('it exposes through `tailscale serve`, scoped to the tailnet', cmds.enable.join(' '), 'tailscale serve --bg 4500');
check('funnel appears in no command', Object.values(cmds).flat().includes('funnel'), false);
check('it can read back what is being served', cmds.serveStatus.join(' '), 'tailscale serve status');
check('it can undo itself', cmds.disable.join(' '), 'tailscale serve reset');
check('it points at the CLI\'s own help when a version disagrees', cmds.help.join(' '), 'tailscale serve --help');

console.log('\n4. the operator installs Tailscale, not us');
check('macOS is told the cask, and to sign in', /brew install --cask tailscale/.test(tailscaleInstallHint('darwin').command), true);
check('Linux gets the official installer', /tailscale\.com\/install\.sh/.test(tailscaleInstallHint('linux').command), true);
check('Windows gets winget', /winget install/.test(tailscaleInstallHint('win32').command), true);
check('an unknown platform says so instead of inventing one', tailscaleInstallHint('sunos'), null);
const script = read('scripts/portable-remote.mjs');
check('the script never runs an installer itself',
  /spawnSync\([^)]*(brew|apt|dnf|winget|install\.sh)/.test(script), false);
// Every call site's first argument is `bin`, or the one platform lookup — never an installer path.
check('…every command it runs is the tailscale binary (plus which/where to locate it)',
  [...script.matchAll(/(?<!function )tryRun\(([^,)]+),/g)].map((m) => m[1].trim()).every((v) => v === 'bin' || v.startsWith('process.platform')), true);

console.log('\n5. it surfaces the CLI\'s error instead of guessing another syntax');
check('a failed enable prints what tailscale said', /tailscale said: \$\{r\.err \|\| r\.out/.test(script), true);
check('…and points at that version\'s own help', /cmds\.help\.join/.test(script), true);
check('…and says nothing else was changed', /Nothing else was changed/.test(script), true);

console.log('\n6. reading is safe; writing happens only after the checks');
const readOnly = script.indexOf('if (!ENABLE && !DISABLE) {');
const mutate = script.indexOf('tryRun(bin, cmds.enable.slice(1))');
check('the state check exits before any mutation', readOnly > 0 && readOnly < mutate, true);
check('with Tailscale absent and --enable, it exits non-zero rather than pretending', /process\.exit\(ENABLE \? 2 : 0\)/.test(script), true);

console.log('\n7. .env is edited in place, and only that one line');
check('the line is well formed for both states',
  [backendPublicUrlLine('https://m.ts.net'), backendPublicUrlLine('')].join('|'),
  'BACKEND_PUBLIC_URL=https://m.ts.net|BACKEND_PUBLIC_URL=');
check('only the named key is replaced — everything else in .env survives',
  /filter\(\(l\) => !l\.startsWith\(`\$\{key\}=`\)\)/.test(script), true);
check('it refuses to touch a missing .env and names the setup command', /run the setup first: npm run portable:setup/.test(script), true);

console.log('\n8. the honest caveats are stated');
check('the tailnet limit is stated', REMOTE_CAVEATS.some((c) => /only devices signed in to YOUR tailnet/i.test(c)), true);
check('…that we do not install it', REMOTE_CAVEATS.some((c) => /does not install Tailscale/.test(c)), true);
check('…and why OAuth stays off', REMOTE_CAVEATS.some((c) => /redirect URIs registered/.test(c)), true);
check('the steps are a real sequence', REMOTE_STEPS.length >= 4 && REMOTE_STEPS.every((s) => s.id && s.title), true);

console.log('\n9. the script actually runs (a source check cannot see a wrong import)');
// Measured, not hypothetical: the first version of portable-remote.mjs imported REMOTE_CAVEATS from
// portableSetup.js, where it does not exist, so the script died at link time — and every assertion
// above still passed, because they read text. Running the read-only path is the only thing that
// catches that, and it is safe: nothing mutates without --enable/--disable.
const proc = spawnSync(process.execPath, [join(ROOT, 'scripts/portable-remote.mjs')], { encoding: 'utf8' });
const said = `${proc.stdout}${proc.stderr}`;
check('the read-only path exits 0', proc.status, 0);
check('…and prints one of the two honest states', /Tailscale is not installed|tailnet URL:/.test(said), true);
check('…and never prints a stack trace', /SyntaxError|ERR_MODULE_NOT_FOUND|at ModuleJob/.test(said), false);

console.log('\n10. the lists that say what is missing have moved with it');
// Remote access now EXISTS as a script; what remains is the manual install. If either list still says
// it is absent, the installer is lying in a document a user reads before they trust it.
check('the installer\'s "not included yet" now names Tailscale as a manual step, not as absent',
  NOT_INSTALLED_YET.some((n) => /Tailscale/.test(n) && /install/i.test(n)), true);
check('…and no longer claims remote access is simply not wired', NOT_INSTALLED_YET.some((n) => /^Remote access from outside your own network\. Tailscale is the decided approach; it is not wired in\.$/.test(n)), false);
check('the bundle README says the same', /Tailscale/.test(read('server/src/lib/portableBundle.js')), true);
check('reality.mjs reports it', /portable-remote/i.test(read('scripts/reality.mjs')), true);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log('\n✗ remote access would either install something unasked or claim more than it did\n');
  process.exit(1);
}
console.log('remote access is the operator\'s tailnet, done by their own CLI, and says so honestly\n');
