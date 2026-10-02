// The state machine for saving a compile's release artifacts — the part of the
// save that used to run inside one long HTTP request.
//
// WHY THIS EXISTS (2026-10-02, the WikiData Batch Uploader's macOS build)
//
// The build SUCCEEDED. Release v36970869714 published app-macos-apple-silicon.dmg
// (103,456,328 bytes), app-macos-intel.dmg (113,581,692 bytes) and
// USER-MANUAL.txt. The save then downloaded ~217 MB from GitHub and re-uploaded
// every byte into Morpheus storage, sequentially, inside ONE request. The
// browser's own timeout is 210s (src/api/base44Client.js API_FETCH_TIMEOUT_MS)
// but Cloudflare's proxy read timeout is ~100s, so the edge cut the connection
// first. useWorkspace caught it, CompilePanel put the panel into its BUILD
// FAILED phase and told the operator to tap RECOMPILE — to spend credits
// rebuilding an app that already existed and was already downloadable.
//
// So the save is now a background job: the start call returns immediately with
// this record, the work continues server-side, and the client polls a status
// endpoint. Nothing about the save is allowed to read as a build failure.
//
// WHY IT IS DURABLE (and not a Map)
//
// SCALING.md's whole premise is that server/src is stateless — no in-memory
// session state, because more than one API replica desyncs. An in-memory job
// registry would be exactly that mistake: a poll could land on a different
// replica than the one running the save. The record lives in Postgres
// (lib/artifactSaveJobStore.js), and the durable per-asset evidence is the
// `_compiled/<name>` ProjectFile rows processAsset already writes as each asset
// lands. A poll reconstructs from those rows every time, so a page reload, a
// backend restart, or a different replica still sees the truth.
//
// Dependency-light on purpose: the only import is the pure
// lib/artifactSaveOutcome.js, so scripts/verify-artifact-save-background.mjs can
// exercise the phases in CI's no-install guards job (see that file for the same
// convention).
import { summarizeArtifactSave } from './artifactSaveOutcome.js';

/** The platform_settings key namespace for one project's in-flight save. */
export const ARTIFACT_SAVE_RECORD_PREFIX = 'artifact_save_job:';

// How long a record may go without an update before a poller calls a "saving"
// job gone. The record is touched when each asset STARTS and when it lands, so
// this bounds the longest a single asset download may take silently. A 113 MB
// disk image on a 1 MB/s link is ~2 minutes; 15 minutes leaves a wide margin
// without letting a dead process report "saving" indefinitely.
export const ARTIFACT_SAVE_STALE_MS = 15 * 60 * 1000;

/** All the phases a save can be observed in. */
export const ARTIFACT_SAVE_PHASES = Object.freeze(['idle', 'saving', 'done', 'partial', 'failed', 'interrupted']);

function normalizeAssets(assets) {
  return (Array.isArray(assets) ? assets : []).map((a) => ({
    name: String(a.name || 'asset'),
    // The `_compiled/` path this asset will occupy — computed by the caller with
    // the adapter's artifactName rule, so a poller can match it against the rows
    // that actually landed without re-deriving the naming rule.
    path: String(a.path || `_compiled/${a.name || 'asset'}`),
  }));
}

/**
 * A fresh record for a save that is about to start.
 * `assets` is the WHOLE expected set for the release — including any already
 * saved from a previous attempt — so `total` is always the release's real size.
 */
export function createArtifactSaveRecord({
  projectId, userId, repoFullName, target, releaseTag, assets, now = Date.now(),
} = {}) {
  const normalized = normalizeAssets(assets);
  return {
    version: 1,
    projectId,
    userId,
    repoFullName: repoFullName || null,
    target: target || null,
    releaseTag: releaseTag || 'latest',
    assets: normalized,
    phase: 'saving',
    currentAsset: normalized[0]?.name || null,
    artifacts: [],
    failed: [],
    errors: [],
    error: null,
    startedAt: now,
    updatedAt: now,
    finishedAt: null,
  };
}

export function markArtifactSaving(record, name, now = Date.now()) {
  record.currentAsset = name || null;
  record.updatedAt = now;
  return record;
}

/** An asset that landed (or was already saved from a previous attempt). */
export function markArtifactSaved(record, artifact, now = Date.now()) {
  if (!record.artifacts.some((a) => a.path === artifact.path)) {
    record.artifacts = [...record.artifacts, artifact];
  }
  record.updatedAt = now;
  return record;
}

export function markArtifactFailed(record, name, message, now = Date.now()) {
  record.failed = [...record.failed, name];
  record.errors = [...record.errors, `${name}: ${message}`];
  record.updatedAt = now;
  return record;
}

/**
 * The save is over. `fatalError` means nothing landed and the attempt itself
 * broke; a partial save keeps `phase: 'partial'` so no caller can read it as
 * complete (the rule lib/artifactSaveOutcome.js exists to encode).
 */
export function finishArtifactSaveRecord(record, { fatalError = null, now = Date.now() } = {}) {
  record.error = fatalError || null;
  record.currentAsset = null;
  record.finishedAt = now;
  record.updatedAt = now;
  if (fatalError) record.phase = 'failed';
  else if (record.failed.length > 0) record.phase = 'partial';
  else record.phase = 'done';
  return record;
}

/** The display size a fresh save records, or null when the row cannot say. */
function sizeFromContent(content) {
  const m = /\/\/ Size: ([\d.]+) MB/.exec(content || '');
  return m ? Math.round(Number(m[1]) * 1024 * 1024) : null;
}

/** A `_compiled/` ProjectFile row as the panel's download link needs it. */
export function artifactFromRow(row) {
  return {
    path: row.path,
    url: row.file_url || null,
    name: String(row.path || '').split('/').pop(),
    size: sizeFromContent(row.content),
  };
}

/** The release tag a saved row records (`// Build: v123`), or null. */
export function releaseTagFromRow(row) {
  return /\/\/ Build: (\S+)/.exec(row?.content || '')?.[1] || null;
}

/**
 * What a poller should be told, derived from the durable record (if any) AND the
 * `_compiled/` rows on disk — never from in-memory progress. Returns the phase,
 * the per-asset counts, and the artifacts that actually exist.
 *
 * The one lie this must never tell: calling a save "saving" when its process is
 * gone, or "done" when only some of the release landed.
 */
export function artifactSaveStatusView({ record = null, savedRows = [], now = Date.now() } = {}) {
  const rows = Array.isArray(savedRows) ? savedRows : [];

  if (!record) {
    // No job record at all. Every `_compiled/` row the project has is all we
    // know; we cannot name a total because nothing recorded the release's asset
    // list, so the honest answer is what landed rather than a fraction of an
    // unknown.
    if (rows.length === 0) {
      return {
        phase: 'idle', active: false, total: 0, saved: 0, currentAsset: null,
        artifacts: [], failed: [], errors: [], error: null, releaseTag: null,
        message: 'No compiled app has been saved for this project yet.',
      };
    }
    const artifacts = rows.map(artifactFromRow);
    return {
      phase: 'done', active: false, total: artifacts.length, saved: artifacts.length,
      currentAsset: null, artifacts, failed: [], errors: [], error: null,
      releaseTag: releaseTagFromRow(rows[0]),
      message: `${artifacts.length} compiled file${artifacts.length === 1 ? '' : 's'} saved.`,
    };
  }

  const rowByPath = new Map(rows.map((r) => [r.path, r]));
  const expected = record.assets || [];
  const landed = [];
  for (const asset of expected) {
    const row = rowByPath.get(asset.path);
    // A row only counts for THIS save when it was written for THIS release tag.
    // Without that check a recompile of the same filename would report the OLD
    // build as "already saved" the moment the new save started.
    const rowIsThisRelease = row && (!record.releaseTag || releaseTagFromRow(row) === record.releaseTag);
    if (rowIsThisRelease) landed.push(artifactFromRow(row));
    else {
      // The row write and the record write are two steps; the record may briefly
      // be ahead. Keep the record's own copy so a landed asset is never hidden.
      const fromRecord = (record.artifacts || []).find((a) => a.path === asset.path);
      if (fromRecord) landed.push(fromRecord);
    }
  }
  const total = expected.length || (record.artifacts || []).length;
  const saved = landed.length;

  // A record that says "saving" but has not been touched for a long time is a
  // process that died mid-save — report it interrupted, never as still saving.
  const lastTouched = record.updatedAt || record.startedAt || 0;
  const stale = record.phase === 'saving' && now - lastTouched > ARTIFACT_SAVE_STALE_MS;
  const phase = stale ? 'interrupted' : record.phase;

  const messages = {
    saving: total > 0 ? `Saving compiled app to your files… (${saved} of ${total})` : 'Saving compiled app to your files…',
    done: `${saved} compiled file${saved === 1 ? '' : 's'} saved.`,
    partial: `${(record.failed || []).length} compiled file${(record.failed || []).length === 1 ? '' : 's'} could not be saved.`,
    failed: 'The compiled app could not be saved to your files.',
    interrupted: `The save stopped before it finished — ${saved} of ${total} file${total === 1 ? '' : 's'} saved.`,
  };

  return {
    phase,
    active: phase === 'saving',
    total,
    saved,
    currentAsset: phase === 'saving' ? (record.currentAsset || null) : null,
    artifacts: landed,
    failed: record.failed || [],
    errors: record.errors || [],
    error: record.error || null,
    releaseTag: record.releaseTag || null,
    message: messages[phase] || '',
  };
}

/**
 * The wire shape both endpoints return, so the panel sees one object whether it
 * is the start call's immediate answer or a later poll. Built on
 * summarizeArtifactSave so a partial save keeps the exact `partial`/`failed`
 * honesty it has always had (lib/artifactSaveOutcome.js) — the failure detail is
 * carried at the top level for every phase, including `failed`, where there is
 * nothing to be "partial" about.
 */
export function artifactSaveResponse({ record = null, savedRows = [], now = Date.now(), extra = {} } = {}) {
  const view = artifactSaveStatusView({ record, savedRows, now });
  const outcome = summarizeArtifactSave({
    savedPaths: view.artifacts.map((a) => a.path),
    artifacts: view.artifacts,
    failed: view.phase === 'partial' ? view.failed : [],
    errors: view.phase === 'partial' ? view.errors : [],
  });
  return {
    ...outcome,
    phase: view.phase,
    active: view.active,
    total: view.total,
    currentAsset: view.currentAsset,
    releaseTag: view.releaseTag,
    message: view.message,
    failed: view.failed,
    errors: view.errors,
    error: view.error,
    ...extra,
  };
}
