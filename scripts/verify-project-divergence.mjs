// Does Morpheus know when the GitHub repo has moved on without the construct —
// and does it warn instead of spending, without ever blocking a build?
//
// WHY THIS EXISTS. compileProject.js pushes the construct's ProjectFile rows one
// way to GitHub before every build, trusting the database as truth. Anything that
// edited the repo directly — a manual push, another tool, a human, a session that
// fixed the generated app on the repo side — is silently overwritten by the next
// compile. Two real incidents this week: a session's app-repo fixes were nearly
// reverted by the next compile, and OPEN-WORK.md carries a standing warning that a
// repo-side fix only reaches Rob after he presses Share → "Sync from GitHub".
// Meanwhile the fix loop was spending on constructs in exactly that state.
//
// So: content-based detection, a warning in the fix loop, and a warning (never a
// block) at the compile boundary. This guard pins the classification, the
// exclusion of Morpheus's own generated files, the copy, and — the rule that
// matters most — that 'unknown' and 'in-sync' change NOTHING about today's
// behaviour, so an unanswerable check can never refuse a build or a fix (H17).
//
// Pure: no model, no key, no network, no database. Run:
//   node scripts/verify-project-divergence.mjs
import { readFileSync } from 'node:fs';
import {
  assessDivergence, repoAhead, unknownDivergence,
  isMorpheusGeneratedPath, shouldComparePath,
  divergenceNeedsAction, compileDivergenceWarning,
  DIVERGENCE_STATES, UNKNOWN_DIVERGENCE_REASONS, SYNC_ACTION, SYNC_ACTION_LABEL,
} from '../server/src/lib/projectDivergence.js';
import { gitBlobSha, shouldExclude } from '../server/src/lib/selfDevRepo.js';

let failures = 0;
let checks = 0;
function check(name, actual, expected) {
  checks++;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name}\n          expected ${e}\n          got      ${a}`); failures++; }
}

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
// H19: a source assertion must read code, not explanatory prose. Every wiring claim below
// strips comments first, so a comment describing the behaviour cannot satisfy it.
const codeOf = (src) => src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ');
const flat = (src) => codeOf(src).replace(/\s+/g, ' ');

const THE_WORKFLOW = '.github/workflows/build.yml';
const f = (path, content) => ({ path, content });

console.log('\n1. content decides, not timestamps\n');
{
  const same = assessDivergence({
    repoFiles: [f('src/a.js', 'export const a = 1;\n')],
    constructFiles: [f('src/a.js', 'export const a = 1;\n')],
  });
  check('content-identical files are in-sync', same.state, 'in-sync');
  check('…with nothing ahead', same.ahead, []);
  check('…and nothing behind', same.behind, []);

  // Two empty lists are a real baseline: nothing diverges.
  const bothEmpty = assessDivergence({ repoFiles: [], constructFiles: [] });
  check('two empty lists are in-sync, not unknown', bothEmpty.state, 'in-sync');

  // The comparison is the git blob sha, so a whitespace-only difference IS a
  // difference — this is the "content, not timestamps" claim.
  const ws = assessDivergence({
    repoFiles: [f('src/a.js', 'export const a = 1;\n')],
    constructFiles: [f('src/a.js', 'export const a = 1;')],
  });
  check('a one-byte content difference is divergence', ws.state, 'both');
  check('…and the hasher agrees', gitBlobSha('x') !== gitBlobSha('x\n'), true);
}

console.log('\n2. which way the divergence points\n');
{
  const repoOnly = assessDivergence({
    repoFiles: [f('src/a.js', 'new'), f('src/b.js', 'same')],
    constructFiles: [f('src/b.js', 'same')],
  });
  check('a repo file the construct lacks is repo-ahead', repoOnly.state, 'repo-ahead');
  check('…and the path is named in ahead', repoOnly.ahead, ['src/a.js']);
  check('…with nothing behind', repoOnly.behind, []);
  check('…and repoAhead() says so', repoAhead(repoOnly), true);

  const constructOnly = assessDivergence({
    repoFiles: [f('src/b.js', 'same')],
    constructFiles: [f('src/a.js', 'new'), f('src/b.js', 'same')],
  });
  check('a construct file the repo lacks is construct-ahead', constructOnly.state, 'construct-ahead');
  check('…and the path is named in behind', constructOnly.behind, ['src/a.js']);
  check('…and repoAhead() is FALSE (the construct is simply newer)', repoAhead(constructOnly), false);

  const modified = assessDivergence({
    repoFiles: [f('src/a.js', 'repo edit')],
    constructFiles: [f('src/a.js', 'construct edit')],
  });
  check('a file edited on BOTH sides is "both"', modified.state, 'both');
  check('…and appears in ahead', modified.ahead, ['src/a.js']);
  check('…and in behind — neither side is a superset', modified.behind, ['src/a.js']);
  check('…and repoAhead() is true', repoAhead(modified), true);

  check('every state is one of the declared five',
    [repoOnly, constructOnly, modified].every((r) => DIVERGENCE_STATES.includes(r.state)), true);
}

console.log('\n3. Morpheus\'s own generated files are not divergence\n');
{
  for (const path of ['_compiled/release.zip', THE_WORKFLOW]) {
    check(`${path} is Morpheus-generated`, isMorpheusGeneratedPath(path), true);
    check(`…and is excluded from the comparison`, shouldComparePath(path), false);
  }
  // The real noise this rule removes: compileProject writes the rendered workflow
  // into its own push and never stores it as a ProjectFile row, and
  // saveCompiledArtifacts writes `_compiled/*` locally — so without the exclusion
  // every healthy project would report repo-ahead forever.
  const onlyGenerated = assessDivergence({
    repoFiles: [f(THE_WORKFLOW, 'rendered workflow'), f('_compiled/app.zip', 'ZIPBYTES'), f('src/a.js', 'same')],
    constructFiles: [f('src/a.js', 'same')],
  });
  check('a repo holding only Morpheus-generated extras is in-sync', onlyGenerated.state, 'in-sync');
  check('…and reports no paths', [onlyGenerated.ahead, onlyGenerated.behind], [[], []]);

  // selfDevRepo.shouldExclude is reused, not re-implemented: everything it owns
  // must also be invisible here.
  for (const path of ['node_modules/x/y.js', 'base44/functions/x/entry.ts', 'server/package-lock.json', 'logo.png', 'src/dist/app.js']) {
    check(`${path} is excluded (shouldExclude reused)`, shouldComparePath(path), false);
    check(`…and shouldExclude agrees`, shouldExclude(path), true);
  }
  // A real source file must still be compared, or the exclusion would be a mute button.
  check('an ordinary source path is still compared', shouldComparePath('server/src/lib/x.js'), true);
  const generatedDoesNotHideReal = assessDivergence({
    repoFiles: [f(THE_WORKFLOW, 'wf'), f('src/real.js', 'repo edit')],
    constructFiles: [f('src/real.js', 'construct')],
  });
  check('generated noise does not mask a real divergence', generatedDoesNotHideReal.ahead, ['src/real.js']);
}

console.log('\n4. unusable input is unknown, and unknown claims nothing\n');
{
  for (const [label, input] of [
    ['nothing at all', {}],
    ['a missing repo list', { constructFiles: [] }],
    ['a missing construct list', { repoFiles: [] }],
    ['null repoFiles', { repoFiles: null, constructFiles: [] }],
    ['a non-array constructFiles', { repoFiles: [], constructFiles: {} }],
    ['an entry with no path', { repoFiles: [{ content: 'x' }], constructFiles: [] }],
    ['an entry with an empty path', { repoFiles: [f('', 'x')], constructFiles: [] }],
  ]) {
    const r = assessDivergence(input);
    check(`${label} → unknown`, r.state, 'unknown');
    check(`…and its reason is a known slug`, UNKNOWN_DIVERGENCE_REASONS.includes(r.reason), true);
    check(`…and it claims no paths (${label})`, [r.ahead, r.behind], [[], []]);
  }
  check('assessDivergence with no argument at all is unknown', assessDivergence().state, 'unknown');
  check('the helper builds the same shape', unknownDivergence('no-token'),
    { state: 'unknown', ahead: [], behind: [], reason: 'no-token' });
  check('a variant with no reason still gets a usable slug',
    UNKNOWN_DIVERGENCE_REASONS.includes(unknownDivergence().reason), true);
}

console.log('\n5. "unknown" never blocks and never spends\n');
{
  // THE RULE. The callers gate every behaviour change on repoAhead(). If it were
  // ever true for 'unknown' or 'in-sync', an unanswerable check would refuse a fix
  // or warn on a healthy construct — exactly what must not happen.
  for (const state of ['in-sync', 'construct-ahead', 'unknown']) {
    check(`repoAhead() is false for '${state}'`, repoAhead({ state, ahead: [], behind: [] }), false);
  }
  check('repoAhead() is false for a missing assessment', repoAhead(undefined), false);
  check('repoAhead() is false for a null assessment', repoAhead(null), false);
  for (const state of ['repo-ahead', 'both']) {
    check(`repoAhead() is true for '${state}'`, repoAhead({ state, ahead: ['a'], behind: [] }), true);
  }

  // The impure wrapper's own failure reasons are all in the declared set, so a
  // caller can never receive an 'unknown' the pure module did not define.
  const wrapperSrc = read('../server/src/lib/repoDivergence.js');
  const slugs = [...wrapperSrc.matchAll(/unknownDivergence\('([a-z-]+)'\)/g)].map((m) => m[1]);
  check('the GitHub wrapper returns at least one unknown reason', slugs.length >= 4, true);
  check('…and every one is a declared reason', slugs.filter((s) => !UNKNOWN_DIVERGENCE_REASONS.includes(s)), []);
  // A partial tree must never read as a clean bill: GitHub truncates a recursive
  // tree, and a comparison over a prefix of the repo would silently call missing
  // files absent.
  check('a truncated tree is refused rather than compared', wrapperSrc.includes('tree.truncated'), true);
  check('…and resolves to unknown', /tree\.truncated\)\s*return unknownDivergence\('tree-truncated'\)/.test(wrapperSrc), true);
  // One unreadable blob makes the whole comparison unsound.
  check('a failed blob fetch is unknown, not skipped', /blob-fetch-failed/.test(wrapperSrc), true);
}

console.log('\n6. the fix loop warns before it can spend\n');
{
  const issue = flat(read('../server/src/functions/diagnoseIssue.js'));
  const compileBody = issue.slice(issue.indexOf('async function diagnoseCompile('), issue.indexOf('async function diagnoseGithub('));
  check('the compile diagnosis assesses divergence', compileBody.includes('assessProjectDivergence('), true);
  check('…and decides with the callable', compileBody.includes('repoAhead('), true);
  check('…after the caller\'s own credential class (the auth branch keeps precedence)',
    compileBody.indexOf('isAuthError(') > -1 && compileBody.indexOf('isAuthError(') < compileBody.indexOf('assessProjectDivergence('), true);
  check('…gated on a non-credential failure',
    compileBody.includes('if (!isAuthError(error)) { const divergence = await assessProjectDivergence('), true);
  // THE SPEND ORDER: the assessment and its gate must come BEFORE autoFixCodeErrors,
  // which is the only call here that costs credits.
  check('…before autoFixCodeErrors can spend',
    compileBody.indexOf('assessProjectDivergence(') > -1
      && compileBody.indexOf('assessProjectDivergence(') < compileBody.indexOf('autoFixCodeErrors('), true);
  // The repo-ahead branch returns early, with autoFixed empty — nothing was spent.
  const gate = compileBody.slice(compileBody.indexOf('if (repoAhead('), compileBody.indexOf('const autoFixed = await autoFixCodeErrors('));
  check('the repo-ahead branch returns before the fix path', gate.includes('return {'), true);
  check('…reporting nothing auto-fixed', gate.includes('autoFixed: []'), true);
  check('…and never auto-changes the loop for other states', /if \(repoAhead\(divergence\)\) \{/.test(gate), true);
  // The evidence the operator asked to be logged: the state, the count and the paths.
  check('the classification is logged with the paths as evidence',
    /console\.warn\([\s\S]*divergence\.ahead\.slice\(0, 20\)/.test(codeOf(read('../server/src/functions/diagnoseIssue.js'))), true);
}

console.log('\n7. the compile warns, and does NOT block\n');
{
  const compile = codeOf(read('../server/src/functions/compileProject.js'));
  const divStart = compile.indexOf('let divergenceNote = null;');
  const pushAt = compile.indexOf('const allFiles = [');
  check('compileProject assesses divergence before the push', divStart > -1 && divStart < pushAt, true);
  const block = compile.slice(divStart, pushAt);
  check('…and asks the single predicate', block.includes('repoAhead('), true);
  check('…and builds a warning from it', block.includes('compileDivergenceWarning('), true);
  check('…and does NOT return or throw (pressing COMPILE is the user\'s instruction)',
    /\breturn\b|\bthrow\b/.test(block), false);
  check('…and the warning reaches the compile result',
    block.includes('validation.warnings = [...(validation.warnings || []), divergenceNote]'), true);
  check('…beside the warnings the panel already renders (append, never replace)',
    /warnings: validation\.warnings \|\| \[\]/.test(compile), true);
  // The push itself is still the one-way push — the follow-up is named in the PR,
  // not silently taken here.
  check('the push call is unchanged and unconditional', /const \{ branch \} = await pushFiles\(/.test(compile), true);
}

console.log('\n8. the user-facing sentence names the exact action\n');
{
  const action = divergenceNeedsAction(4);
  const sentence = action.issue;
  check('the loop says the repo has changes the construct does not', sentence.includes('GitHub has 4 file(s) the construct does not'), true);
  check('…that a fix here would be overwritten by the next compile', sentence.includes('Fixing files here would be overwritten by the next compile'), true);
  check('…names the exact sync action', sentence.includes(SYNC_ACTION), true);
  check('…and that the diagnosis follows the sync', sentence.includes('then run the diagnosis again'), true);
  check('…the steps carry the action too', action.steps.join(' ').includes(SYNC_ACTION_LABEL), true);
  check('…and the entry is a needsUserAction shape', [typeof action.component, typeof action.label, Array.isArray(action.steps)], ['string', 'string', true]);

  const warning = compileDivergenceWarning(4);
  check('the compile warning names the count', warning.includes('4 file(s)'), true);
  check('…names the exact sync action', warning.includes(SYNC_ACTION), true);
  check('…says it is still a push, not a refusal', /overwritten by this build's push/.test(warning), true);
  check('…and never claims the build was blocked', /block|refus|cancel/i.test(warning), false);

  // THE COPY CANNOT DRIFT FROM THE BUTTON. The label the warning tells the
  // operator to press is asserted against the real UI source, so renaming the
  // Sharing dialog's button fails this guard instead of sending them to a label
  // that no longer exists.
  check('the sync label still matches the real Share dialog button',
    read('../src/components/matrix/ShareDialog.jsx').includes(SYNC_ACTION_LABEL), true);
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log(`\n${failures} FAILED`);
  process.exit(1);
}
console.log('divergence is detected by content, warned about, and never blocks a build\n');
