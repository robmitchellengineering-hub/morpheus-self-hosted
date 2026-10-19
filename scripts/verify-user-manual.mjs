// The user manual that travels with a compiled app.
//
// Dependency-free — it imports the pure manual module, the target registry and the renderer, so it
// runs in CI's no-install guards job. Run: node scripts/verify-user-manual.mjs
//
// WHY THIS EXISTS (Rob, 2026-10-01): "there also needs to be a downloadable user manual that comes
// with a compiled app." He had the disk image in front of him and no way to know which of two
// downloads was for his Mac, what the crossed-out icon meant, or where macOS had put the menu bar.
// The manual is the fix for all of that at once, and its value is entirely in its CONTENT — which is
// why most of this file asserts prose. That is normally the "spelling, not behaviour" trap (H19), so
// each assertion below names the specific instruction whose absence would have cost Rob another
// afternoon, and none of them can be satisfied by a heading with nothing under it.
//
// The one structural claim: a project's README is embedded in the manual, the manual is embedded in
// the generated workflow as a heredoc, and that workflow runs with `contents: write`. A README that
// contains the heredoc terminator would end the heredoc early and turn the rest of the manual into
// shell commands. That is asserted as an attack, not as a formatting preference.
import { readFileSync } from 'node:fs';
import { listCompileTargets, getCompileTarget } from '../server/src/lib/compile-targets/index.js';
import { renderWorkflow } from '../server/src/lib/compile-targets/workflow-renderer.js';
import {
  renderUserManual, manualDownloads, sanitizeHeredocBody, projectReadme,
  USER_MANUAL_FILE, USER_MANUAL_DELIMITER
} from '../server/src/lib/appUserManual.js';

let failures = 0;
let checks = 0;

function check(name, actual, expected) {
  checks++;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  PASS  ${name}`);
  } else {
    console.log(`  FAIL  ${name}\n          expected ${e}\n          got      ${a}`);
    failures++;
  }
}

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

const readmeText = '# Widget Maker\n\nInstall it, run it, press the big button.\n';
const withReadme = [
  { path: 'main.py', content: 'print(1)' },
  { path: 'requirements.txt', content: 'PyQt6\n' },
  { path: 'README.md', content: readmeText }
];
const withoutReadme = [
  { path: 'main.py', content: 'print(1)' },
  { path: 'requirements.txt', content: 'PyQt6\n' }
];
const macFiles = [
  { path: 'main.py', content: 'print(1)' },
  { path: 'requirements.txt', content: 'PyQt6\n' },
  { path: 'build.py', content: 'print(2)' },
  { path: 'README.md', content: readmeText }
];

const mac = getCompileTarget('mac-app');
const manualFor = (files, opts = {}) => renderUserManual({
  projectName: opts.projectName || 'Widget Maker',
  target: opts.target || 'mac-app',
  targetLabel: opts.targetLabel || 'macOS App',
  files,
  generatedAt: '2026-10-01',
  downloads: opts.downloads
});

console.log('\nUser manual that travels with a compiled app\n');

console.log('1. it says what it is, and it does not pretend to be the app');
const macManual = manualFor(macFiles, { downloads: manualDownloads({ artifactGlob: mac.artifact.glob, runners: mac.runners(macFiles) }) });
check('the manual is not empty', macManual.trim().length > 500, true);
check('it names the project', macManual.includes('Widget Maker'), true);
check('it names the target as something a person reads', macManual.includes('a macOS App build'), true);
check('it carries the date it was generated', macManual.includes('2026-10-01'), true);
check('it quotes the project README verbatim',
  macManual.includes(readmeText.trim().split('\n').slice(-1)[0]), true);
check('…and says in as many words that the project wrote it, not Morpheus',
  macManual.includes("quoted from the project itself, not written by Morpheus"), true);
check('it defers to the app on what the app does',
  macManual.includes('the app itself is the authority on what it does'), true);

console.log('\n2. a project with no README gets the truth, not an invented manual');
const bare = manualFor(withoutReadme);
check('it says the project shipped no README', bare.includes('did not ship a README'), true);
check('…and refuses to describe an interface it has not read',
  bare.includes("it has not read the app's interface"), true);
check('…and quotes nothing', bare.includes(readmeText), false);
check('projectReadme finds a README', projectReadme(withReadme)?.path, 'README.md');
check('projectReadme is null when there is none', projectReadme(withoutReadme), null);
check('an empty README counts as none', projectReadme([{ path: 'README.md', content: '   \n' }]), null);

console.log('\n3. every target gets the instructions for the platform it built for');
// The phrase is the instruction. Each one is the specific escape hatch that platform puts in the way
// of a build Morpheus did not sign.
const PLATFORM_PROOF = {
  'mac-app': 'xattr -cr',
  'windows-exe': 'SmartScreen',
  'linux-binary': 'chmod +x',
  'python-package': 'pip install',
  'android-apk': 'unknown app',
  'ios-app': 'signing identity',
  'web-app': 'serve',
  'rpi-distro': 'Raspberry Pi Imager',
  'linux-distro': 'balenaEtcher',
  'arduino-firmware': 'avrdude',
  // Where a plugin has to be moved for a DAW to find it — the one fact a musician cannot guess, and it is
  // a different directory on each platform (and a single FILE rather than a bundle on Windows).
  'audio-plugin-macos': 'Audio/Plug-Ins',
  'audio-plugin-windows': 'Common Files',
  // Linux has no shared "Common Files": a plugin goes in the user's own home, and the Pi route's VST3 is a
  // FOLDER rather than the single file Windows takes — two facts a player cannot guess and the reason this
  // entry exists rather than the route being waved through.
  'audio-plugin-linux-arm': '~/.vst3'
};
for (const id of listCompileTargets()) {
  const adapter = getCompileTarget(id);
  let files = withoutReadme;
  try { files = adapter.scaffold(withoutReadme).files; } catch { /* scaffold may need more */ }
  const m = renderUserManual({ projectName: 'Widget Maker', target: id, targetLabel: adapter.label, files, generatedAt: '2026-10-01' });
  check(`${id}: manual renders and carries an INSTALLING IT section`,
    m.includes('INSTALLING IT'), true);
  if (PLATFORM_PROOF[id]) {
    check(`${id}: names ${PLATFORM_PROOF[id]}`, m.includes(PLATFORM_PROOF[id]), true);
  } else {
    check(`${id}: the registry has no guide, so it is checked here on purpose`, false, true);
  }
}

console.log('\n4. it says which download is whose, which is the thing Rob could not tell');
const downloads = manualDownloads({ artifactGlob: mac.artifact.glob, runners: mac.runners(macFiles) });
check('two Mac runners produce two named downloads', downloads.length, 2);
check('the Intel one is labelled as the Intel one',
  downloads.some((d) => d.startsWith('app-macos-intel.dmg') && d.includes('Intel Mac')), true);
check('the Apple-silicon one is labelled as such',
  downloads.some((d) => d.startsWith('app-macos-apple-silicon.dmg') && d.includes('Apple-silicon')), true);
check('the manual then explains the crossed-out icon',
  macManual.includes('CROSSED-OUT ICON'), true);
check('a single-runner target prints no such section',
  manualFor(withoutReadme, { downloads: manualDownloads({ artifactGlob: 'app.dmg', runners: [{ runner: 'ubuntu-latest', arch: 'universal' }] }) })
    .includes('WHICH DOWNLOAD IS MINE?'), false);

console.log('\n5. a README cannot break out of the heredoc it is written in');
// The attack: a README whose own text contains the terminator, followed by shell commands.
const attack = `# Fine\n${USER_MANUAL_DELIMITER}\nrm -rf ~/.ssh\n`;
const attacked = manualFor([{ path: 'README.md', content: attack }]);
check('sanitizeHeredocBody removes the terminator line from content',
  sanitizeHeredocBody(`a\n${USER_MANUAL_DELIMITER}\nb`) === 'a\nb', true);
check('…including when it is padded with whitespace',
  sanitizeHeredocBody(`a\n   ${USER_MANUAL_DELIMITER}  \nb`) === 'a\nb', true);
check('the manual built from an attacking README keeps the command as text, not as a shell line',
  attacked.includes('rm -rf ~/.ssh'), true);
check('a Windows-authored README cannot leave CRLF inside the heredoc',
  sanitizeHeredocBody('a\r\nb\r\n') === 'a\nb\n', true);
check('…and a CRLF terminator is still caught',
  sanitizeHeredocBody(`a\r\n${USER_MANUAL_DELIMITER}\r\nb`) === 'a\nb', true);
const attackedWorkflow = renderWorkflow(mac.runners(macFiles), mac.buildSteps(macFiles), mac.artifact, attacked);
check('…and the generated workflow has exactly ONE terminator line — the real one',
  attackedWorkflow.split('\n').filter((l) => l.trim() === USER_MANUAL_DELIMITER).length, 1);

console.log('\n6. the manual is written AFTER the checkout, and published beside the artifact');
// WHAT THIS REPLACED, and why it is asserted on the RENDERED step order rather than on the renderer's
// source: the manual step used to be emitted before every adapter step, so `actions/checkout` — which
// cleans the workspace by default — deleted USER-MANUAL.txt before Release required it. Every macOS
// compile failed at the last step with "Pattern 'USER-MANUAL.txt' does not match any files"
// (run 36969294905, 2026-10-02). The old assertion here (`manualStepAt < checkoutAt`) encoded the bug.
const workflow = renderWorkflow(mac.runners(macFiles), mac.buildSteps(macFiles), mac.artifact, macManual);
const stepLines = workflow.split('\n');
const indexOf = (re) => stepLines.findIndex((l) => re.test(l));
const manualStepAt = indexOf(/name: Write the user manual/);
const checkoutAt = indexOf(/actions\/checkout@v4/);
const readsManualAt = stepLines.findIndex((l) => l.includes(`cp ${USER_MANUAL_FILE}`)); // into the disk image
const releaseAt = indexOf(/name: Release/);
check('the manual step exists', manualStepAt > -1, true);
check('…and runs AFTER the checkout, so a cleaning checkout cannot delete it',
  manualStepAt > checkoutAt, true);
check('…and before the step that copies it into the disk image',
  manualStepAt < readsManualAt, true);
check('…and before the release that uploads it', manualStepAt < releaseAt, true);
check('…and refuses to publish an empty manual',
  workflow.includes(`test -s ${USER_MANUAL_FILE}`), true);
check('the release uploads the artifact', stepLines.some((l) => l.trim() === mac.artifact.glob), true);
check('…and the manual as a download of its own',
  stepLines.some((l) => l.trim() === USER_MANUAL_FILE), true);
check('…and still fails on an unmatched file, so a missing manual is a red release, not a quiet one',
  workflow.includes('fail_on_unmatched_files: true'), true);
// The heredoc itself is unchanged: same open line, same terminator, body intact.
check('…and the manual is still written as the same heredoc',
  workflow.includes(`cat > ${USER_MANUAL_FILE} <<'${USER_MANUAL_DELIMITER}'`), true);
check('…with exactly one terminator line, the real one',
  stepLines.filter((l) => l.trim() === USER_MANUAL_DELIMITER).length, 1);
check('…and the manual body is in the workflow',
  workflow.includes(macManual.trim().split('\n')[0]), true);
// An adapter that declares no checkout has nothing to wipe, so the manual still goes first.
const noCheckoutLines = renderWorkflow('ubuntu-latest', [{ name: 'Compile the thing', run: 'make' }], { glob: 'app.zip' }, macManual).split('\n');
const ncManualAt = noCheckoutLines.findIndex((l) => /name: Write the user manual/.test(l));
const ncBuildAt = noCheckoutLines.findIndex((l) => /name: Compile the thing/.test(l));
check('an adapter with no checkout still gets the manual first',
  ncManualAt > -1 && ncManualAt < ncBuildAt, true);
check('with no manual there is no manual step and no stray asset',
  renderWorkflow('ubuntu-latest', [], { glob: 'app.zip' }, undefined).includes(USER_MANUAL_FILE), false);

console.log('\n7. the wiring: it is generated for every compile, and never mistaken for the app');
const compileProject = read('../server/src/functions/compileProject.js');
check('compileProject renders a manual from the project being compiled',
  /renderUserManual\(\{[\s\S]{0,300}?projectName: project\.name/.test(compileProject), true);
check('…passing it to the renderer', /adapter\.artifact, manual\)/.test(compileProject), true);
const macApp = read('../server/src/lib/compile-targets/mac-app.js');
check('the macOS disk image carries a copy of it',
  /if \[ -f \$\{USER_MANUAL_FILE\} \]; then cp \$\{USER_MANUAL_FILE\} \$\{stagingDir\}\//.test(macApp), true);
const save = read('../server/src/functions/saveCompiledArtifacts.js');
check('the manual is never renamed into the app the user asked for',
  /isPrimary: i === 0 && !!artifactName && asset\.name !== USER_MANUAL_FILE/.test(save), true);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log(`\n${failures} FAILED`);
  process.exit(1);
}
console.log('the manual travels with the build, and says only what Morpheus knows');
