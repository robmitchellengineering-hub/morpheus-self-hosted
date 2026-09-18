// Phase 2 of Jarvis-built Command Deck widgets (Phase 0: #172, Phase 1:
// #174) — the headless driver that actually plans, builds, ships, and
// installs a new widget for a requesting user, with no human clicking
// through /self-dev.
//
// Identity model (confirmed with Rob): every internal self-dev call below
// runs as the shared self-dev actor — the one admin account that owns the
// singleton project_type: 'self_dev' Project (the real repo/deployment) —
// never as `requestingUser`. `requestingUser` is only used to pick a
// collision-free widget_key and to install the finished widget onto THEIR
// own Deck at the end. This mirrors exactly what a human clicking through
// /self-dev already does, just scripted: plan a scoped feature → drive
// chatWithMorpheus.js one build turn per step → push (PR mode) → poll the
// merge → give the deploy a head start → smoke-check → install.
//
// scope_policy: 'widget_build' (see enginePolicy.js's WIDGET_BUILD) is what
// keeps this safe to run unattended — every build turn's file writes are
// hard-restricted to widget files by applyFileOperations' own policy check,
// independent of anything this driver does or forgets to check.
import { prisma } from '../db.js';
import { logUsage } from '../lib/projectUtils.js';
import { getActiveFeature } from '../lib/selfDevFeature.js';
import { runPlanSelfDevFeature } from './planSelfDevFeature.js';
import { runUpdateSelfDevFeature } from './updateSelfDevFeature.js';
import chatWithMorpheusHandler from './chatWithMorpheus.js';
import importSelfDevRepoHandler from './importSelfDevRepo.js';
import pushSelfDevToGithubHandler from './pushSelfDevToGithub.js';
import { runMergeSelfDevPr } from './mergeSelfDevPr.js';
import { runSmokeCheckSelfDev } from './smokeCheckSelfDev.js';

const WIDGETS_DIR = 'src/pages/CommandDeck/widgets/';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function slugify(text) {
  const slug = String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
  return slug || 'widget';
}

// Exported so deleteDeckWidget.js can resolve the same shared actor/project
// without duplicating this lookup.
export async function resolveSelfDevActor() {
  const project = await prisma.project.findFirst({ where: { project_type: 'self_dev' } });
  if (!project) throw Object.assign(new Error('No self-dev workspace exists yet.'), { status: 503 });
  const actor = await prisma.user.findUnique({ where: { id: project.created_by_id } });
  if (!actor || actor.role !== 'admin') throw Object.assign(new Error('The self-dev workspace owner is not an admin.'), { status: 500 });
  return { actor, project };
}

// The real collision that matters is a file this build would overwrite —
// checking the self-dev Project's own mirrored ProjectFile rows (the exact
// thing applyFileOperations checks) is more precise than trying to reach
// into deckWidgets.js's DECK_WIDGETS array from server code, which lives in
// the frontend's module graph.
async function pickWidgetKey(projectId, description) {
  const base = slugify(description.split(/[.!?\n]/)[0]);
  let key = base;
  for (let n = 2; await prisma.projectFile.findFirst({ where: { project_id: projectId, path: `${WIDGETS_DIR}${key}.jsx` } }); n++) {
    key = `${base}_${n}`;
  }
  return key;
}

// Collects chatWithMorpheus.js's NDJSON progress stream into parsed events
// without a real HTTP response — that file streams via res.writeHead/write/
// end and is otherwise unmodified (see the widget-file plan's Phase 2 note:
// "drive chatWithMorpheus.js's existing turn loop without touching that
// file").
function createNdjsonCollector() {
  const events = [];
  let buffer = '';
  return {
    events,
    res: {
      writeHead() {},
      write(chunk) {
        buffer += String(chunk);
        let idx;
        while ((idx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (line) { try { events.push(JSON.parse(line)); } catch { /* ignore a malformed progress line */ } }
        }
      },
      end() {},
    },
  };
}

function widgetAuthoringContext(widgetKey, createdById) {
  return `
WIDGET BUILD CONTRACT — this is a Jarvis-triggered Command Deck widget build, not a normal self-dev change:
- Create exactly ONE new widget file: ${WIDGETS_DIR}${widgetKey}.jsx, default-exporting a React component that calls useCommandDeck() (from '@/contexts/CommandDeckContext') for whatever data/handlers it needs. Look at existing files in that directory for the pattern — today_one_thing.jsx for a minimal one, tasks.jsx for a fuller one.
- Reuse the shared presentational primitives already in src/pages/CommandDeck/DeckUI.jsx (Card, MicField, MicTextarea, IconButton, EmptyNote, StreamList, inputStyle, miniInput, rowBox, ghostBtn, pillBtn, checkBtn, chipBtn) and the color/constant tokens in src/pages/CommandDeck/deckConstants.js — don't invent a new visual style.
- If the widget needs its own backend endpoint, create it at server/src/functions/widget<PascalCase>.js (must start with "widget" + a capital letter). It's free to import and call any existing server/src/lib/deck*.js connection helper (deckGoogle.js, deckBusinessProfile.js, deckMemory.js, deckSnapshot.js) to read or synthesize the installing user's own connected data at runtime — this restriction only governs which files THIS BUILD may create, never what the widget's own code may call once it's running.
- Add exactly ONE new entry to the DECK_WIDGETS array in src/pages/CommandDeck/deckWidgets.js, written EXACTLY on one line (nothing else on that line): { key: '${widgetKey}', label: '<short label>', defaultEnabled: false, createdBy: '${createdById}' }. The createdBy field is load-bearing — it's how Settings knows this widget can later be deleted by the person who asked for it, unlike the built-in widgets. Do not reorder, reformat, or edit any other line in that file — it's shared by every account's widget list.
- No other file may be touched. No database migration, no infra/config changes, no editing any other widget's file — attempting to will be rejected before anything is written.
`;
}

// Progress visibility (Rob, 2026-09-17, after first being told this posted
// to Jarvis chat: "wait not in the chat it should be a progress bar with
// details running in the widgets card") — a build takes ~15 minutes
// unattended, so DeckWidgetBuild is a plain polled status row (status,
// step_index/step_count, step_title, message), one per attempt, that the
// Settings widget manager polls and renders as a progress bar — see
// deckSettings's WidgetManager(). Not chat-shaped on purpose.
async function updateBuild(buildId, data) {
  try {
    await prisma.deckWidgetBuild.update({ where: { id: buildId }, data });
  } catch (err) {
    console.error('[buildDeckWidget] progress update failed (build continues):', err.message);
  }
}

export async function runBuildDeckWidget(requestingUser, description) {
  const desc = String(description || '').trim();
  if (desc.length < 10) {
    throw Object.assign(new Error('Describe the widget in a sentence or two — what should it show or do?'), { status: 400 });
  }

  const build = await prisma.deckWidgetBuild.create({
    data: { created_by_id: requestingUser.id, description: desc, status: 'planning', message: 'Resolving the build workspace…' },
  });
  // Every return path funnels through here so the polled row always ends up
  // in a terminal state (done/failed) with a real message — never stuck on
  // an in-progress status forever.
  const finish = async (result) => {
    await updateBuild(build.id, { status: result.ok ? 'done' : 'failed', message: result.message });
    return result;
  };

  let selfDevActor;
  let project;
  try {
    ({ actor: selfDevActor, project } = await resolveSelfDevActor());
  } catch (err) {
    return finish({ ok: false, stage: 'setup', message: err.message });
  }
  const projectId = project.id;
  const workspaceLink = `/workspace?projectId=${projectId}`;

  const existingFeature = await getActiveFeature(projectId).catch(() => null);
  if (existingFeature) {
    return finish({
      ok: false, stage: 'busy',
      message: `Self-dev already has a build in progress ("${existingFeature.title}") — it needs to finish before another one can start. Try again shortly.`,
      workspaceLink,
    });
  }

  // KNOWN-HAZARDS.md H9: a stale self-dev workspace snapshot makes PUSH TO
  // PRODUCTION diff against old content instead of live main, and can revert
  // unrelated files. The documented mitigation is "click SYNC FROM GITHUB
  // before every BUILD -> PUSH turn" — a rule only a human at /self-dev can
  // remember. This driver has no human in the loop, so it enforces the same
  // rule itself, every run, instead of trusting whatever the workspace last
  // happened to have cached.
  await updateBuild(build.id, { message: 'Syncing the workspace from GitHub…' });
  try {
    await importSelfDevRepoHandler({ user: selfDevActor, body: {} });
  } catch (err) {
    return finish({ ok: false, stage: 'sync', message: `Couldn't sync the self-dev workspace from GitHub before building: ${err.message}`, workspaceLink });
  }

  const widgetKey = await pickWidgetKey(projectId, desc);
  await updateBuild(build.id, { widget_key: widgetKey, message: 'Planning the build…' });
  const goal = `Build a new Command Deck widget. What the user asked for: "${desc}"\n${widgetAuthoringContext(widgetKey, requestingUser.id)}`;

  let feature;
  try {
    ({ feature } = await runPlanSelfDevFeature(selfDevActor, projectId, goal));
  } catch (err) {
    return finish({ ok: false, stage: 'plan', message: `Couldn't plan that widget: ${err.message}`, workspaceLink });
  }
  // scope_policy is what restricts every build turn below to widget files —
  // set directly (runPlanSelfDevFeature has no param for it; Phase 1 only
  // added the plumbing that reads it, nothing creates one until now).
  await prisma.selfDevFeature.update({ where: { id: feature.id }, data: { scope_policy: 'widget_build' } });
  await updateBuild(build.id, {
    status: 'building', step_count: feature.steps.length, step_index: 0,
    step_title: feature.steps[0]?.title || null, message: `Plan ready — ${feature.steps.length} step${feature.steps.length === 1 ? '' : 's'}.`,
  });

  const abandon = () => runUpdateSelfDevFeature(selfDevActor, feature.id, 'abandon', { silent: true }).catch(() => {});

  for (const step of feature.steps) {
    const { res, events } = createNdjsonCollector();
    try {
      await chatWithMorpheusHandler({
        user: selfDevActor,
        body: { projectId, message: `Build step ${step.n}: ${step.title}`, mode: 'build' },
        res,
      });
    } catch (err) {
      await abandon();
      return finish({ ok: false, stage: 'build', message: `Build crashed on step ${step.n} ("${step.title}"): ${err.message}`, workspaceLink });
    }

    const terminal = events.find((e) => e.type === 'result' || e.type === 'error');
    if (!terminal || terminal.type === 'error') {
      await abandon();
      return finish({ ok: false, stage: 'build', message: `Build failed on step ${step.n} ("${step.title}"): ${terminal?.message || 'no response from the build pipeline'}`, workspaceLink });
    }
    if (terminal.data?.needsClarification) {
      await abandon();
      return finish({ ok: false, stage: 'build', message: `Need more detail to build this: ${terminal.data.reply}`, workspaceLink });
    }
    const fileOps = terminal.data?.fileOperations || [];
    const denied = fileOps.filter((op) => op.action === 'policy_denied');
    if (denied.length > 0) {
      await abandon();
      return finish({
        ok: false, stage: 'scope',
        message: `That build tried to touch files outside a widget's scope (${denied.map((d) => d.path).join(', ')}) — blocked before anything was written.`,
        workspaceLink,
      });
    }
    if (fileOps.length === 0) {
      await abandon();
      return finish({ ok: false, stage: 'build', message: `Step ${step.n} ("${step.title}") didn't produce any file changes.`, workspaceLink });
    }

    await runUpdateSelfDevFeature(selfDevActor, feature.id, 'completeStep', { stepN: step.n, silent: true });
    const nextStep = feature.steps.find((s) => s.n === step.n + 1);
    await updateBuild(build.id, {
      step_index: step.n, step_title: nextStep?.title || step.title,
      message: `Step ${step.n}/${feature.steps.length} done — ${step.title}.`,
    });
  }

  let pushResult;
  try {
    pushResult = await pushSelfDevToGithubHandler({ user: selfDevActor, body: { projectId, scopePolicy: 'widget_build' } });
  } catch (err) {
    return finish({ ok: false, stage: 'push', message: `Couldn't push the build: ${err.message}`, workspaceLink });
  }
  if (pushResult.blocked) {
    return finish({ ok: false, stage: 'push', message: pushResult.message, workspaceLink });
  }
  if (pushResult.fileCount === 0) {
    return finish({ ok: false, stage: 'push', message: 'Nothing to ship — the build produced no real changes.', workspaceLink });
  }
  await updateBuild(build.id, {
    status: 'pushing',
    message: pushResult.mode === 'pr'
      ? `Pushed — PR #${pushResult.prNumber} is open, waiting for checks to go green before it auto-merges.`
      : 'Pushed straight to production.',
  });

  // WIDGET_BUILD.allowDirectToMain is false, and this driver never passes
  // force/directToMain, so pushResult.mode is always 'pr' in practice — this
  // branch is defensive, not a real fork.
  let mergeResult = null;
  if (pushResult.mode === 'pr') {
    await updateBuild(build.id, { status: 'merging', message: `PR #${pushResult.prNumber} opened — waiting for checks.` });
    // Mirrors SelfDev.jsx's own poll cadence (12s, then every 20s, ~40
    // attempts ≈ 13 minutes) so an unattended build waits exactly as long as
    // a human watching the page would.
    await sleep(12000);
    for (let attempt = 0; attempt < 40; attempt++) {
      mergeResult = await runMergeSelfDevPr(selfDevActor, pushResult.prNumber, {
        projectId, touchedManualSource: pushResult.touchedManualSource, hasMigration: pushResult.hasMigration,
      }).catch((err) => ({ merged: false, state: 'error', message: err.message }));
      if (mergeResult.merged) break;
      if (['failed', 'conflict', 'merge_failed', 'error'].includes(mergeResult.state)) {
        return finish({
          ok: false, stage: 'merge',
          message: `The PR didn't merge cleanly (${mergeResult.state}): ${mergeResult.message || (mergeResult.failing || []).join(', ') || 'see the PR'}.`,
          prUrl: pushResult.prUrl, workspaceLink,
        });
      }
      const pendingCount = (mergeResult.checks || []).filter((c) => c.status !== 'completed').length;
      await updateBuild(build.id, { message: pendingCount > 0 ? `Waiting on ${pendingCount} check${pendingCount === 1 ? '' : 's'}…` : 'Waiting for checks to register…' });
      await sleep(20000);
    }
    if (!mergeResult?.merged) {
      return finish({ ok: false, stage: 'merge', message: 'The PR checks took too long to go green — check it manually.', prUrl: pushResult.prUrl, workspaceLink });
    }
    await updateBuild(build.id, { status: 'deploying', message: 'Merged — Northflank and Netlify are redeploying production now.' });
  }

  // No reusable server-side Northflank deploy-status poller exists yet — a
  // fixed delay matching tonight's own observed deploy timing is the
  // simplest first cut (see the plan's "open questions" for a real poller).
  await sleep(75000);

  await updateBuild(build.id, { status: 'verifying', message: 'Deploy should be live — running the post-deploy check.' });
  let smoke;
  try {
    smoke = await runSmokeCheckSelfDev(selfDevActor);
  } catch (err) {
    smoke = { ok: false, error: err.message };
  }
  if (!smoke.ok) {
    return finish({
      ok: false, stage: 'smoke',
      message: `Shipped, but the post-deploy check found a problem: ${(smoke.failing || []).join(', ') || smoke.error || 'unknown'}.`,
      workspaceLink,
    });
  }

  const maxSort = await prisma.deckWidgetInstance.aggregate({
    where: { created_by_id: requestingUser.id },
    _max: { sort_order: true },
  });
  const instance = await prisma.deckWidgetInstance.create({
    data: {
      created_by_id: requestingUser.id,
      widget_key: widgetKey,
      enabled: true,
      sort_order: (maxSort._max.sort_order ?? -1) + 1,
    },
  });

  await logUsage(selfDevActor.id, 'deck_widget_build', projectId, project.name, { widgetKey, requestingUserId: requestingUser.id });

  return finish({ ok: true, widgetKey, instanceId: instance.id, message: `Built and shipped — "${widgetKey}" is live on your Deck now. Refresh to see it.` });
}

// Not yet wired to any frontend call site or to chatWithJarvis.js (that's
// Phase 3, along with the deckWidgets.js append-only push guard) — admin-
// gated in functions.routes.js's ADMIN_FUNCTIONS as a defensive default
// until then, since this file existing makes it reachable over HTTP the
// moment it ships.
export default async function handler({ user, body }) {
  const description = String(body?.description || '').trim();
  if (!description) throw Object.assign(new Error('description required'), { status: 400 });
  return runBuildDeckWidget(user, description);
}
