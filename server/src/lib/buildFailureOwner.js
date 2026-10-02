// WHO OWNS A BUILD FAILURE — Morpheus, or the app?
//
// WHY THIS EXISTS (measured 2026-10-01). A compile of a real app failed on both macOS
// jobs, and the failure was Morpheus's OWN generated workflow, not the app. The renderer
// (`lib/compile-targets/workflow-renderer.js`) emits the "Write the user manual" step
// BEFORE the adapter's `actions/checkout@v4`; the checkout cleans the workspace and
// deletes USER-MANUAL.txt, and the Release step (`fail_on_unmatched_files: true`) then
// fails with:
//
//   ##[error]⚠️  Pattern 'USER-MANUAL.txt' does not match any files.
//
// The product's diagnosis loop was pointed at that failure and could not fix it and
// should not have tried: it only writes to the CONSTRUCT's files, while Morpheus
// regenerates the workflow from scratch on every compile — so the next compile would
// fail identically. It ran anyway: role=diagnosis, deepseek-flash, 40,365 input →
// 32,000 output tokens (exactly the cap), 2 m 20 s, recorded `status: ok`, then threw
// OUTPUT_TRUNCATED and discarded the whole diagnosis. (The auto-fix schema asks for
// WHOLE FILE CONTENTS for every fix — see lib/diagnosis.js's fixResponseSchema — which
// cannot fit a 50-file app in any cap.) The loop classified the ERROR. This module
// classifies OWNERSHIP.
//
// THE RULE THAT MATTERS MOST — DO NOT NARROW MORPHEUS. Only a confident, evidence-backed
// 'morpheus' result may skip the AI fix path (see ownerIsMorpheus / shouldRunAiFix).
// 'app' and 'unknown' keep the caller's existing behaviour EXACTLY. The build pipeline
// must stay as free as possible; the point is to stop one specific waste and one specific
// lie, not to make the loop more cautious in general.
//
// WHAT IT CANNOT DO — and the limit is deliberate. It reads TEXT SIGNATURES. A
// Morpheus-owned failure with a novel signature falls through to 'unknown' and today's
// behaviour. A MISS IS ACCEPTABLE; a false "this is Morpheus's fault" that stops a real
// fix is not. So every Morpheus-owned signature must carry the evidence it matched (the
// step name and the named file), and ownerIsMorpheus() refuses a verdict with no
// evidence.
//
// IMPORT-FREE ON PURPOSE. This runs inside CI's no-install guards job
// (`scripts/verify-build-failure-owner.mjs`), so it may not reach a package import.
// MANUAL_FILE mirrors USER_MANUAL_FILE in lib/appUserManual.js; the guard drives this
// module with the canonical constant, so a rename on either side goes red rather than
// silently decoupling.
//
// CREDENTIALS ARE THE CALLER'S CLASSIFICATION, DELIBERATELY NOT THIS MODULE'S OPINION.
// A missing or expired credential is answered by diagnoseIssue.js's own canonical
// isCredentialError() / isAuthError() branches, which this change leaves untouched and
// which the ownership check does not replace. This module therefore carries no credential
// vocabulary at all: a credential-shaped message with no Morpheus signature falls through
// to 'unknown', and the caller keeps that class exactly as it was.
//
// PRECEDENCE, in the order it actually executes: the caller's own credential branch (run
// before this module is consulted) → app → morpheus → unknown. Only the last three are
// decided here, and an app-owned signature outranks a Morpheus one.

// Mirrors USER_MANUAL_FILE in lib/appUserManual.js. Import-free, so it is a literal.
const MANUAL_FILE = 'USER-MANUAL.txt';
// The step names the renderer itself writes (see workflow-renderer.js).
const MANUAL_STEP = 'Write the user manual';
const VERIFY_STEP = 'Verify artifact';
const RELEASE_STEP = 'Release';
// compileProject.js renders the workflow to this path.
const GENERATED_WORKFLOW = '.github/workflows/build.yml';

// ── Text assembly ────────────────────────────────────────────────────────────
// `logs` is whatever the caller has: a string, or getCompileStatus()'s
// [{ job, log }] array. `error` may be the step's own text or the caller's generic
// "Build failed on GitHub Actions" — the real signature is usually in the logs.
function failureText(error, logs) {
  const parts = [];
  const push = (v) => {
    if (typeof v === 'string') { if (v) parts.push(v); return; }
    if (v == null) return;
    if (typeof v === 'object') {
      if (typeof v.log === 'string') parts.push(v.log);
      else if (v.message) parts.push(String(v.message));
    } else parts.push(String(v));
  };
  push(error);
  if (Array.isArray(logs)) logs.forEach(push);
  else push(logs);
  return parts.join('\n');
}

// The step a failure line belongs to, when the log names one. Best-effort: GitHub's
// raw job log does not always carry the `name:` of a step, which is exactly why the
// distinctive failure MESSAGES below matter as much as the step names do.
function stepFromText(text) {
  for (const step of [MANUAL_STEP, VERIFY_STEP, RELEASE_STEP]) {
    if (text.includes(step)) return step;
  }
  const group = /##\[group\]\s*([^\n]{1,80})/.exec(text);
  return group ? group[1].trim() : null;
}

function normalizeArtifacts(artifactGlob, artifactGlobs) {
  const list = [];
  if (typeof artifactGlob === 'string' && artifactGlob) list.push(artifactGlob);
  if (Array.isArray(artifactGlob)) list.push(...artifactGlob);
  if (Array.isArray(artifactGlobs)) list.push(...artifactGlobs);
  else if (typeof artifactGlobs === 'string' && artifactGlobs) list.push(artifactGlobs);
  return [...new Set(list.filter((g) => typeof g === 'string' && g))];
}

// ── The app's own failures ───────────────────────────────────────────────────
// Checked BEFORE the Morpheus-owned list on purpose: if the app's own build failed,
// the honest answer is 'app' even when a Morpheus-owned signature also appears in the
// same logs. That is the safe direction — a miss costs an AI call; a false 'morpheus'
// stops a fix the app needed.
export const APP_OWNED_SIGNATURES = [
  {
    id: 'missing-module',
    why: "A missing import is the app's own dependency declaration failing — the app named a module its build cannot resolve.",
    match(ctx) {
      const m = /(?:ModuleNotFoundError|ImportError)\b:?\s*(?:No module named\s*)?['"]?([\w.@/-]+)['"]?/i.exec(ctx.text);
      if (!m) return null;
      return { step: ctx.step, file: m[1] || null };
    },
  },
  {
    id: 'compile-or-syntax-error',
    why: "A compiler or interpreter rejecting the app's source is a defect in the app's own code.",
    match(ctx) {
      // Case-SENSITIVE on purpose. The caller's own generic error string is
      // "Build failed on GitHub Actions", so a case-insensitive /build failed/ would
      // classify every failure — including the real Morpheus-owned one — as the app's.
      const m = /(SyntaxError|IndentationError|error TS\d+|error\[E\d+\]|error: could not compile|BUILD FAILED|make: \*\*\*|linker command failed|Cannot find module|ERR_MODULE_NOT_FOUND|Compiling failed)/.exec(ctx.text);
      if (!m) return null;
      return { step: ctx.step, file: null };
    },
  },
  {
    id: 'dependency-install-failed',
    why: "The app's declared dependencies failing to install is the app's manifest, not the workflow that installs them.",
    match(ctx) {
      if (!/npm ERR!|Could not find a version that satisfies the requirement|No matching distribution found/i.test(ctx.text)) return null;
      return { step: ctx.step, file: null };
    },
  },
  {
    id: 'app-runtime-traceback',
    why: "A traceback from the app's own code during the build is an error in the app.",
    match(ctx) {
      if (!/Traceback \(most recent call last\)/.test(ctx.text)) return null;
      return { step: ctx.step, file: null };
    },
  },
];

// ── The Morpheus-owned failures ──────────────────────────────────────────────
// Each carries `why` (the reason it is Morpheus's) and an `explain(evidence)` that
// produces the user-facing sentence. NO RAW LOG TEXT reaches `explain()` — the log is
// evidence for `match()`, never copy for the user.
export const MORPHEUS_OWNED_SIGNATURES = [
  {
    id: 'release-pattern-unmatched',
    why: 'Morpheus renders the Release step and chooses the files it publishes. `Pattern ... does not match any files` from softprops/action-gh-release means a file Morpheus named in its own workflow was missing when its own step ran — the app cannot influence that.',
    match(ctx) {
      const m = /Pattern ['"]([^'"]+)['"] does not match any files/i.exec(ctx.text);
      if (!m) return null;
      const file = m[1];
      // Only a file Morpheus generates or declares: the manual it writes, or the
      // artifact glob it puts in the same `files:` list.
      if (file !== MANUAL_FILE && !ctx.artifacts.includes(file)) return null;
      return { step: RELEASE_STEP, file };
    },
    explain(e) {
      const named = e.file === MANUAL_FILE
        ? 'which Morpheus writes into the workflow'
        : 'which Morpheus declares in the workflow';
      return `The build stopped in the ${e.step} step: it publishes ${e.file}, ${named}, and the file was missing by then. Nothing in your app can fix this and no credits were spent diagnosing it — this is being fixed in Morpheus, and your next compile will carry the fix.`;
    },
  },
  {
    id: 'generated-step-failed',
    why: '`Write the user manual` and `Verify artifact` are steps Morpheus writes into every generated workflow. A failure inside one of them is the generated workflow failing, not the app code.',
    match(ctx) {
      // The manual step's own refusal is a Morpheus message, and it is the one the
      // log always carries even when the step name itself does not appear.
      if (new RegExp(`${MANUAL_FILE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} is empty`, 'i').test(ctx.text)) {
        return { step: MANUAL_STEP, file: MANUAL_FILE };
      }
      const failed = /##\[error\]|Process completed with exit code|(?:^|\n)\s*Error:/i.test(ctx.text);
      if (!failed) return null;
      if (ctx.text.includes(MANUAL_STEP)) return { step: MANUAL_STEP, file: MANUAL_FILE };
      if (ctx.text.includes(VERIFY_STEP)) return { step: VERIFY_STEP, file: ctx.artifacts[0] || null };
      return null;
    },
    explain(e) {
      const file = e.file ? ` (it produces ${e.file})` : '';
      return `The build stopped in the "${e.step}" step — a step Morpheus writes into the generated workflow${file}. Nothing in your app can fix this and no credits were spent diagnosing it — this is being fixed in Morpheus, and your next compile will carry the fix.`;
    },
  },
  {
    id: 'generated-workflow-invalid',
    why: 'The workflow file is rendered by Morpheus from the adapters. A YAML or expression error in it means the file Morpheus generated was not a valid workflow.',
    match(ctx) {
      if (!ctx.text.includes(GENERATED_WORKFLOW)) return null;
      const invalid = /Invalid workflow file|is not valid|Unexpected value|Invalid expression|Unrecognized named-value|mapping values are not allowed|did not find expected|could not parse|yaml:|\(Line: \d+/i.test(ctx.text);
      if (!invalid) return null;
      return { step: null, file: GENERATED_WORKFLOW };
    },
    explain(e) {
      return `The generated workflow file ${e.file} is not valid, and Morpheus renders that file from the compile target. Nothing in your app can fix this and no credits were spent diagnosing it — this is being fixed in Morpheus, and your next compile will carry the fix.`;
    },
  },
  {
    id: 'declared-artifact-missing',
    why: "Morpheus declares the artifact glob and uploads it in a step it wrote. If the app's own build is not the thing that failed and the declared artifact is absent, the gap is in Morpheus's own packaging/release.",
    match(ctx) {
      // The app's own build having failed is checked before this list, so reaching
      // here without an app signature is the evidence that the build step succeeded.
      const m = /(?:Artifact not found|No files were found with the provided path|Unable to find any artifacts|No artifacts found)/i.exec(ctx.text);
      if (!m) return null;
      const step = ctx.text.includes(VERIFY_STEP) ? VERIFY_STEP : RELEASE_STEP;
      return { step, file: ctx.artifacts[0] || null };
    },
    explain(e) {
      const file = e.file ? ` (${e.file})` : '';
      return `The build finished but the artifact Morpheus declared${file} was never produced, and the failure is in Morpheus's release step rather than your app's build. Nothing in your app can fix this and no credits were spent diagnosing it — this is being fixed in Morpheus, and your next compile will carry the fix.`;
    },
  },
];

// ── The user-facing voice ────────────────────────────────────────────────────
// Short lead + the plain sentence. Deliberately carries no raw log line and no
// stack trace: the evidence stays in `evidence`, and the user reads a reason.
const HEADLINES = {
  morpheus: "Morpheus's own build pipeline failed, not your app.",
  app: "This build failure is in your app's own code.",
  unknown: 'The build failed for a reason Morpheus does not recognise yet.',
};

// Only ever attached to a Morpheus-owned verdict.
const MORPHEUS_STEPS = [
  'Nothing in your app needs changing — this failure belongs to Morpheus.',
  'This is a known Morpheus pipeline fault; your next compile will carry the fix.',
];

// Informational only: the caller keeps its existing behaviour for these owners.
const EXISTING_PATH = {
  app: "The failing step is the app's own build, so the normal diagnosis and auto-fix path applies.",
  unknown: 'No Morpheus-owned signature matched, so the normal diagnosis and auto-fix path applies.',
};

function buildResult(owner, reason, evidence) {
  const signature = owner === 'morpheus'
    ? MORPHEUS_OWNED_SIGNATURES.find((s) => s.id === reason)
    : null;
  return {
    owner,
    reason,
    evidence: evidence || { step: null, file: null },
    headline: HEADLINES[owner],
    detail: owner === 'morpheus' && signature
      ? signature.explain(evidence || {})
      : (EXISTING_PATH[owner] || EXISTING_PATH.unknown),
    steps: owner === 'morpheus' ? [...MORPHEUS_STEPS] : [],
  };
}

/**
 * Classify who owns a failed build.
 *
 * @param {{ error?: any, logs?: any, target?: string|null, artifactGlob?: string|string[]|null, artifactGlobs?: string[]|null }} [context]
 * @returns {{ owner: 'morpheus'|'app'|'unknown', reason: string|null,
 *            evidence: { step: string|null, file: string|null }, headline: string,
 *            detail: string, steps: string[] }}
 */
export function classifyBuildFailure({ error, logs, target, artifactGlob, artifactGlobs } = {}) {
  const text = failureText(error, logs);
  const artifacts = normalizeArtifacts(artifactGlob, artifactGlobs);
  const ctx = { text, target: target || null, artifacts, step: stepFromText(text) };

  // Then the app's own failures — the safe direction (see the note on the list).
  for (const signature of APP_OWNED_SIGNATURES) {
    const evidence = signature.match(ctx);
    if (evidence) return buildResult('app', signature.id, evidence);
  }

  // Only then Morpheus, and only on a signature that named its evidence.
  for (const signature of MORPHEUS_OWNED_SIGNATURES) {
    const evidence = signature.match(ctx);
    if (evidence) return buildResult('morpheus', signature.id, evidence);
  }

  // A miss is acceptable: no signature matched, so today's behaviour stands.
  return buildResult('unknown', null, { step: ctx.step, file: null });
}

/**
 * The single decision the caller makes on a classification: does this failure belong
 * to Morpheus, and did the classifier actually match evidence for it?
 *
 * A verdict with no evidence is NOT trusted — an unproven "Morpheus's fault" that
 * stopped a real fix is the one outcome this module must never produce.
 */
export function ownerIsMorpheus(result) {
  if (!result || result.owner !== 'morpheus') return false;
  const evidence = result.evidence || {};
  return !!result.reason && (!!evidence.step || !!evidence.file);
}

/**
 * True when the classifier does NOT suppress the caller's existing path — i.e. every
 * owner except a confident, evidence-backed 'morpheus'. The caller proceeds exactly as it
 * did before this module existed, which is where the credential, github and deploy
 * branches it already owns are decided.
 */
export function shouldRunAiFix(result) {
  return !ownerIsMorpheus(result);
}
