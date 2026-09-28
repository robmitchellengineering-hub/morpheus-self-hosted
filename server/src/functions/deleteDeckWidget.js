// Deletes a Jarvis-built Command Deck widget — the mechanical counterpart
// to buildDeckWidget.js. Unlike a build, deletion needs no AI: remove one
// file, remove one line from the shared registry. So this never drives
// chatWithMorpheus.js's planner/coder/reviewer loop at all — it computes
// the edit itself and ships it through the same push/merge/deploy/verify
// pipeline a build uses, reusing those functions directly.
//
// Ownership: only the widget's own creator (its DECK_WIDGETS entry's
// createdBy, set by buildDeckWidget.js's authoring contract) may delete
// it. The original hardcoded widgets have no createdBy at all, so they
// can never match — permanently undeletable by construction. PROTECTED_
// BASE_KEYS below is a second, belt-and-braces check on top of that, not
// the primary guard.
//
// Two-phase, like chatWithJarvis.js's build trigger: a fast synchronous
// phase (validate, uninstall, create the progress row) the frontend
// actually waits on, then the slow phase (sync, edit, push, merge, deploy,
// verify — a few minutes) runs in the background. Unlike buildDeckWidget.js,
// this file's own handler is the direct frontend entry point (no
// classifier ahead of it), so the split has to live here.
import { prisma } from '../db.js';
import { logUsage } from '../lib/projectUtils.js';
import { resolveSelfDevActor } from './buildDeckWidget.js';
import importSelfDevRepoHandler from './importSelfDevRepo.js';
import pushSelfDevToGithubHandler from './pushSelfDevToGithub.js';
import { runMergeSelfDevPr } from './mergeSelfDevPr.js';
import { runSmokeCheckSelfDev } from './smokeCheckSelfDev.js';
import { removeWidgetEntry } from '../lib/selfDevRepo.js';

const WIDGETS_DIR = 'src/pages/CommandDeck/widgets/';
const DECK_WIDGETS_REGISTRY_PATH = 'src/pages/CommandDeck/deckWidgets.js';

// The widget keys DECK_WIDGETS shipped with before any Jarvis build ever
// existed — never deletable, even if a createdBy field somehow ended up
// on one of these (it never should; this is the hard backstop).
const PROTECTED_BASE_KEYS = new Set([
  'jarvis_suggestions', 'brain_dump', 'today_charge', 'today_one_thing',
  'inbox', 'calendar', 'signal_chain', 'life_streams', 'strategy',
  'knowledge', 'tasks', 'week_rhythm', 'backup',
]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Reuses the DeckWidgetBuild table (action: 'delete') so Settings' existing
// progress-bar polling shows this for free — see buildDeckWidget.js's own
// comment on why that table exists and how it's rendered.
async function updateJob(jobId, data) {
  try {
    await prisma.deckWidgetBuild.update({ where: { id: jobId }, data });
  } catch (err) {
    console.error('[deleteDeckWidget] progress update failed (delete continues):', err.message);
  }
}

// Pulls the one-line DECK_WIDGETS entry's createdBy out of the registry's
// current content — same controlled, simple parse removeWidgetEntry()
// itself relies on: every entry is coder-generated from buildDeckWidget's
// one-line authoring contract, never free-form text.
function findCreatedBy(registryContent, widgetKey) {
  const line = String(registryContent || '').split('\n').find((l) => l.includes(`key: '${widgetKey}'`));
  if (!line) return null;
  const m = line.match(/createdBy:\s*'([^']*)'/);
  return m ? m[1] : null;
}

async function assertOwnedByRequester(projectId, key, requestingUser) {
  const registryFile = await prisma.projectFile.findFirst({ where: { project_id: projectId, path: DECK_WIDGETS_REGISTRY_PATH } });
  const createdBy = registryFile ? findCreatedBy(registryFile.content, key) : null;
  if (!createdBy) {
    throw Object.assign(new Error("That's one of Command Deck's built-in widgets — it can't be deleted."), { status: 403 });
  }
  if (createdBy !== requestingUser.id) {
    throw Object.assign(new Error("That widget wasn't created by you, so only its creator can delete it."), { status: 403 });
  }
}

// The slow part — sync, re-verify ownership against fresh content, edit,
// push, poll merge, wait for deploy, smoke-check. Not awaited by the
// caller; every exit path updates the job row so the poll always lands on
// a terminal state with a real message.
async function deleteWidgetInBackground({ selfDevActor, project, requestingUser, key, widgetPath, job }) {
  const finish = (result) => updateJob(job.id, { status: result.ok ? 'done' : 'failed', message: result.message });
  const projectId = project.id;

  // KNOWN-HAZARDS.md H9: same reasoning as buildDeckWidget.js — sync
  // before touching anything, don't trust whatever the workspace last
  // happened to have cached.
  await updateJob(job.id, { message: 'Syncing the workspace from GitHub…' });
  try {
    await importSelfDevRepoHandler({ user: selfDevActor, body: {} });
  } catch (err) {
    return finish({ ok: false, message: `Couldn't sync the self-dev workspace from GitHub before deleting: ${err.message}` });
  }

  // Re-check ownership against the just-synced, authoritative content —
  // the earlier check (before this function was even backgrounded) was
  // only ever a fast reject on possibly-stale data.
  try {
    await assertOwnedByRequester(projectId, key, requestingUser);
  } catch (err) {
    return finish({ ok: false, message: err.message });
  }

  const [widgetFile, registryFile] = await Promise.all([
    prisma.projectFile.findFirst({ where: { project_id: projectId, path: widgetPath } }),
    prisma.projectFile.findFirst({ where: { project_id: projectId, path: DECK_WIDGETS_REGISTRY_PATH } }),
  ]);
  if (!widgetFile) {
    return finish({ ok: false, message: `No widget file found for "${key}" — it may already be deleted.` });
  }
  if (!registryFile) {
    return finish({ ok: false, message: `Couldn't find ${DECK_WIDGETS_REGISTRY_PATH} in the workspace.` });
  }

  let newRegistryContent;
  try {
    newRegistryContent = removeWidgetEntry(registryFile.content, key);
  } catch (err) {
    return finish({ ok: false, message: err.message });
  }

  await updateJob(job.id, { status: 'building', message: 'Removing the widget from the registry…' });
  await prisma.$transaction([
    prisma.projectFile.update({ where: { id: registryFile.id }, data: { content: newRegistryContent } }),
    prisma.projectFile.delete({ where: { id: widgetFile.id } }),
  ]);

  // Ad-hoc, per-call policy object (not a registered id) — enginePolicy.js's
  // resolvePolicy() already accepts either. Scoped to exactly these two
  // paths for THIS delete only, so nothing else in the repo is even
  // diffable or deletable no matter what else is going on in the shared
  // workspace.
  const scopePolicy = {
    id: 'widget_delete',
    widgetKey: key,
    allowPathPrefixes: [
      new RegExp(`^${escapeRegex(widgetPath)}$`),
      new RegExp(`^${escapeRegex(DECK_WIDGETS_REGISTRY_PATH)}$`),
    ],
  };

  let pushResult;
  try {
    pushResult = await pushSelfDevToGithubHandler({ user: selfDevActor, body: { projectId, scopePolicy } });
  } catch (err) {
    return finish({ ok: false, message: `Couldn't push the deletion: ${err.message}` });
  }
  if (pushResult.blocked) {
    return finish({ ok: false, message: pushResult.message });
  }
  if (pushResult.fileCount === 0) {
    return finish({ ok: false, message: 'Nothing to remove — that widget may already be gone from production.' });
  }
  await updateJob(job.id, {
    status: 'pushing',
    message: pushResult.mode === 'pr'
      ? `Pushed — PR #${pushResult.prNumber} is open, waiting for checks to go green before it auto-merges.`
      : 'Pushed straight to production.',
  });

  // Same poll cadence and deploy-wait shape as buildDeckWidget.js — not
  // reimplemented differently, just applied to a deletion instead.
  let mergeResult = null;
  if (pushResult.mode === 'pr') {
    await updateJob(job.id, { status: 'merging', message: `PR #${pushResult.prNumber} opened — waiting for checks.` });
    await sleep(12000);
    for (let attempt = 0; attempt < 40; attempt++) {
      mergeResult = await runMergeSelfDevPr(selfDevActor, pushResult.prNumber, {
        projectId, touchedManualSource: pushResult.touchedManualSource, hasMigration: pushResult.hasMigration,
      }).catch((err) => ({ merged: false, state: 'error', message: err.message }));
      if (mergeResult.merged) break;
      if (['failed', 'conflict', 'merge_failed', 'error'].includes(mergeResult.state)) {
        return finish({
          ok: false,
          message: `The PR didn't merge cleanly (${mergeResult.state}): ${mergeResult.message || (mergeResult.failing || []).join(', ') || 'see the PR'}.`,
        });
      }
      const pendingCount = (mergeResult.checks || []).filter((c) => c.status !== 'completed').length;
      await updateJob(job.id, { message: pendingCount > 0 ? `Waiting on ${pendingCount} check${pendingCount === 1 ? '' : 's'}…` : 'Waiting for checks to register…' });
      await sleep(20000);
    }
    if (!mergeResult?.merged) {
      return finish({ ok: false, message: 'The PR checks took too long to go green — check it manually.' });
    }
    await updateJob(job.id, { status: 'deploying', message: 'Merged — Northflank and Netlify are redeploying production now.' });
  }

  // ── DURABLE COMPLETION — above the wait, for the same reason buildDeckWidget.js does it ────────
  // The merge above triggers the deploy, and that deploy replaces the process running this deletion.
  // Anything below the wait usually never runs, with no exception to catch. The user's Deck already
  // stopped showing the widget (its instance row is deleted before the build starts), so all that is
  // left to do durably is log it and reach a terminal status.
  await logUsage(selfDevActor.id, 'deck_widget_delete', projectId, project.name, { widgetKey: key, requestingUserId: requestingUser.id });
  const finished = await finish({
    ok: true,
    message: `Removed — "${key}" is off your Deck now, and its code finishes leaving production when the deploy lands (about two minutes).`,
  });

  // ── BEST EFFORT from here down ─────────────────────────────────────────────
  // Enriches the message when this process happens to survive the deploy. Never changes the status:
  // a failed check here would read as "the removal failed" when the widget is already gone.
  try {
    await sleep(75000);
    const smoke = await runSmokeCheckSelfDev(selfDevActor).catch((err) => ({ ok: false, error: err.message }));
    await updateJob(job.id, {
      message: smoke.ok
        ? `Removed, and the check after the deploy passed — "${key}" is gone from production.`
        : `Removed from your Deck. The check after the deploy found a problem with the site: ${(smoke.failing || []).join(', ') || smoke.error || 'unknown'}.`,
    });
  } catch {
    // Expected on most deletions: this process was replaced by the deploy it triggered.
  }

  return finished;
}

export async function runDeleteDeckWidget(requestingUser, widgetKey) {
  const key = String(widgetKey || '').trim();
  if (!key) throw Object.assign(new Error('widgetKey required'), { status: 400 });
  if (PROTECTED_BASE_KEYS.has(key)) {
    throw Object.assign(new Error("That's one of Command Deck's built-in widgets — it can't be deleted."), { status: 403 });
  }

  const { actor: selfDevActor, project } = await resolveSelfDevActor();
  const widgetPath = `${WIDGETS_DIR}${key}.jsx`;

  // Fast reject against whatever the workspace currently has — good
  // enough for immediate user feedback. The authoritative check (against
  // freshly-synced content) happens again in the background phase, right
  // before anything is actually edited or pushed.
  await assertOwnedByRequester(project.id, key, requestingUser);

  // Uninstall from the requester's own Deck immediately, before anything
  // else — their Deck should stop showing it right away regardless of how
  // the background code deletion goes.
  await prisma.deckWidgetInstance.deleteMany({ where: { created_by_id: requestingUser.id, widget_key: key } });

  const job = await prisma.deckWidgetBuild.create({
    // Kept short and un-prefixed with "Delete" — Settings' progress card
    // already prefixes it with a delete-specific stage label per status
    // (e.g. "Removing: ..."), so this is just the widget's own name.
    data: { created_by_id: requestingUser.id, description: `"${key}"`, widget_key: key, action: 'delete', status: 'planning', message: 'Resolving the workspace…' },
  });

  deleteWidgetInBackground({ selfDevActor, project, requestingUser, key, widgetPath, job }).catch((err) => {
    console.error('[deleteDeckWidget] background delete crashed:', err.message);
    updateJob(job.id, { status: 'failed', message: err.message });
  });

  return { ok: true, jobId: job.id, message: `Deleting "${key}"…` };
}

export default async function handler({ user, body }) {
  const widgetKey = String(body?.widgetKey || '').trim();
  if (!widgetKey) throw Object.assign(new Error('widgetKey required'), { status: 400 });
  return runDeleteDeckWidget(user, widgetKey);
}
