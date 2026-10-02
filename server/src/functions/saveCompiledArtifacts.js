// Ported from base44/functions/saveCompiledArtifacts/entry.ts.
// Downloads compiled release artifacts from the GitHub build repo (which is
// private) and re-uploads them to Morpheus storage so they appear as
// downloadable files in the project's file tree alongside the source code.
// Called by the CompilePanel when a build succeeds.
//
// 2026-10-02 — THE SAVE NO LONGER RUNS INSIDE THE REQUEST.
//
// A macOS build published a 103 MB and a 113 MB disk image. Downloading both
// from GitHub and re-uploading them to storage, sequentially, inside one HTTP
// request took longer than Cloudflare's ~100s proxy read timeout — so the edge
// cut the connection before the browser's own 210s timeout could fire, the
// client saw "NetworkError when attempting to fetch resource", and CompilePanel
// put a SUCCESSFUL build into its BUILD FAILED phase with "tap RECOMPILE".
//
// This handler now resolves what has to be saved (one fast GitHub call), writes
// a durable job record, and returns immediately. The download→upload loop runs
// detached, writing a `_compiled/<name>` ProjectFile row as each asset lands and
// updating the record after each transition. getArtifactSaveStatus.js is what
// the client polls. Resuming is safe: an asset already saved for this release
// tag is skipped rather than re-downloaded, and every write is an upsert by
// (project_id, path) — the unique that has existed all along (`project_files_project_id_path_key`).
//
// Binary handling is unchanged and must stay that way: binaries are streamed
// straight to disk/S3 via uploadFileStream, never buffered (buffering a 100MB+
// compiled app crashed the backend with a hard OOM kill — see storage.js).
import { prisma } from '../db.js';
import { ghHeaders, ghJson, getGithubToken } from '../lib/github.js';
import { getCompileTarget } from '../lib/compile-targets/index.js';
import { USER_MANUAL_FILE } from '../lib/appUserManual.js';
import { uploadFileStream } from '../storage.js';
import {
  createArtifactSaveRecord, markArtifactSaving, markArtifactSaved, markArtifactFailed,
  finishArtifactSaveRecord, artifactSaveResponse, releaseTagFromRow,
} from '../lib/artifactSaveJob.js';
import { writeArtifactSaveRecord, readArtifactSaveRecord } from '../lib/artifactSaveJobStore.js';
import https from 'node:https';

const GH_API = 'https://api.github.com';

// Real content-types for the compile-target binaries we produce, keyed by
// extension. Matters most for the S3 storage driver (stored as object
// metadata, and some CDNs/browsers use it over the extension); the local
// driver's express.static already infers Content-Type from the extension
// itself, so this is a belt-and-suspenders match for both drivers.
const CONTENT_TYPES = {
  '.apk': 'application/vnd.android.package-archive',
  '.exe': 'application/x-msdownload',
  '.dmg': 'application/x-apple-diskimage',
  '.zip': 'application/zip',
  '.deb': 'application/vnd.debian.binary-package',
  '.img': 'application/octet-stream',
  '.iso': 'application/x-iso9660-image',
  '.ipa': 'application/octet-stream',
  // Added 2026-09-15 (compile-pipeline packaging fix) — these were falling
  // through to the generic default below for linux-binary/mac-app's own
  // .tar.gz archives, python-package's wheel, and arduino-firmware's raw
  // firmware images, none of which had an entry.
  '.gz': 'application/gzip', // covers .tar.gz too — contentTypeFor() below only matches the last extension
  '.whl': 'application/zip', // a wheel is a zip archive under a different extension
  '.hex': 'text/plain',
  '.bin': 'application/octet-stream',
  '.elf': 'application/octet-stream',
};

function contentTypeFor(filename) {
  const match = /\.[^.]+$/.exec(filename || '');
  return (match && CONTENT_TYPES[match[0].toLowerCase()]) || 'application/octet-stream';
}

// Manual HTTPS download with redirect following. Node's fetch strips the
// Authorization header on cross-origin redirects (the GitHub asset endpoint
// redirects to a signed CDN URL), so we use the lower-level https client to
// keep the header attached across redirects, just as the GitHub API requires.
// Returns a Promise resolving with the readable response stream itself (not
// a buffered body) — the caller pipes it straight into uploadFileStream, so
// a compiled binary is never fully materialized in memory. See storage.js's
// uploadFileStream for why: buffering both the download and the re-upload
// of a 100-200MB+ compiled app (PyQt6/pandas etc.) was crashing the backend
// process outright.
function downloadStreamWithRedirects(url, headers, redirectsRemaining = 5) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers }, (response) => {
      const { statusCode, headers: resHeaders } = response;
      if (statusCode >= 300 && statusCode < 400 && resHeaders.location && redirectsRemaining > 0) {
        response.resume(); // discard any body on redirect
        const redirectUrl = new URL(resHeaders.location, url).toString();
        resolve(downloadStreamWithRedirects(redirectUrl, headers, redirectsRemaining - 1));
      } else if (statusCode >= 200 && statusCode < 300) {
        resolve(response);
      } else {
        response.resume(); // discard error body
        reject(new Error(`HTTP ${statusCode} ${response.statusMessage || ''}`));
      }
    });
    request.on('error', reject);
    request.end();
  });
}

/**
 * The `_compiled/` path an asset will occupy. The primary asset is RENAMED to
 * the adapter's artifactName, EXCEPT the user manual — if the manual were ever
 * the first asset it would land as app.apk and be a text file (see
 * lib/appUserManual.js).
 */
function displayNameFor(asset, { artifactName, isPrimary }) {
  return isPrimary && artifactName ? artifactName : asset.name;
}

async function processAsset(asset, { userId, projectId, repoFullName, headers, displayName, path, releaseTag, bodyAssetsMode }) {
  let stream = null;
  let downloadError = null;
  let directDownloadError = null;

  if (bodyAssetsMode) {
    const url = asset.downloadUrl || asset.browser_download_url;
    if (!url) throw new Error('No download URL provided for asset');
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        stream = await downloadStreamWithRedirects(url, { ...headers, Accept: 'application/octet-stream' });
        break;
      } catch (err) {
        downloadError = err;
        if (attempt < 3) await new Promise(r => setTimeout(r, attempt * 1000));
      }
    }
    if (!stream) {
      throw new Error(`${asset.name}: download failed after 3 attempts: ${downloadError?.message || 'unknown error'}`);
    }
  } else {
    const apiUrl = `${GH_API}/repos/${repoFullName}/releases/assets/${asset.id}`;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        stream = await downloadStreamWithRedirects(apiUrl, { ...headers, Accept: 'application/octet-stream' });
        break;
      } catch (err) {
        downloadError = err;
        if (attempt < 3) await new Promise(r => setTimeout(r, attempt * 1000));
      }
    }
    if (!stream && asset.browser_download_url) {
      try {
        stream = await downloadStreamWithRedirects(asset.browser_download_url, { ...headers, Accept: 'application/octet-stream' });
      } catch (err) {
        directDownloadError = err;
      }
    }
    if (!stream) {
      const apiErrMsg = downloadError?.message || 'unknown error';
      const directErrMsg = directDownloadError ? `; direct download failed: ${directDownloadError.message}` : '';
      throw new Error(`${asset.name}: API download failed after 3 attempts: ${apiErrMsg}${directErrMsg}`);
    }
  }

  const { file_url } = await uploadFileStream({ stream, filename: displayName, contentType: contentTypeFor(displayName) });
  const sizeMb = (asset.size / 1024 / 1024).toFixed(1);
  const content = `// COMPILED ARTIFACT\n// Build: ${releaseTag || 'latest'}\n// Size: ${sizeMb} MB\n// Saved: ${new Date().toISOString()}\n// Download from the file viewer.`;
  // upsert, not create: (project_id, path) is unique, so a re-save or a resumed
  // save overwrites the row in place instead of failing P2002 or duplicating it.
  await prisma.projectFile.upsert({
    where: { project_id_path: { project_id: projectId, path } },
    update: { content, file_url, language: 'binary' },
    create: { created_by_id: userId, project_id: projectId, path, content, file_url, language: 'binary' },
  });
  return { path, url: file_url, name: displayName, size: asset.size };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The release for the run that just finished. The workflow names it for its own
 * run (`tag_name: v<run_id>`), so by tag is unambiguous when two compiles are in
 * flight; `releases/latest` is only the fallback for a caller that supplied no
 * tag at all.
 */
async function fetchRelease({ repoFullName, headers, releaseTag }) {
  if (releaseTag) {
    let lastBody = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch(`${GH_API}/repos/${repoFullName}/releases/tags/${releaseTag}`, { headers });
      if (res.ok) {
        lastBody = await ghJson(res);
        if (lastBody?.assets?.length > 0) return lastBody;
      } else if (res.status !== 404) {
        throw Object.assign(new Error(`GitHub release lookup failed (HTTP ${res.status})`), { status: 502 });
      }
      if (attempt < 2) await sleep(2000);
    }
    if (lastBody) return lastBody;
    // The tag this run named does not exist. Falling back to "latest" here would
    // save a DIFFERENT compile's build under this release's tag — the defect
    // getCompileStatus.js fixed — so say so instead.
    throw Object.assign(new Error(`No release found for ${releaseTag}`), { status: 404 });
  }

  let releaseRes;
  try {
    releaseRes = await fetch(`${GH_API}/repos/${repoFullName}/releases/latest`, { headers });
  } catch (e) {
    console.error('saveCompiledArtifacts: release fetch failed:', e);
    throw Object.assign(new Error(`Failed to reach GitHub releases: ${e.message || e}`), { status: 502 });
  }
  if (!releaseRes.ok) {
    let bodyText = '';
    try { bodyText = await releaseRes.text(); } catch { /* ignore */ }
    const detail = bodyText ? ` (HTTP ${releaseRes.status}: ${bodyText.slice(0, 200)})` : ` (HTTP ${releaseRes.status})`;
    throw Object.assign(new Error(`No release found for this repo${detail}`), { status: 404 });
  }
  return ghJson(releaseRes);
}

/**
 * Decide what to save, and which assets this attempt can skip because an
 * identical release tag already saved them. This is the resume path: it must
 * work whether or not the caller supplied the asset list, so it compares the
 * SAVED rows' `// Build: <tag>` note against the release tag being saved.
 */
function planAssets({ assetsToSave, artifactName, releaseTag, existingCompiled }) {
  // Resume is decided per ROW by the release tag each row recorded, not by "the
  // first row's tag" — a partial save leaves rows only from this release, but a
  // recompile leaves the previous release's rows too, and the first row read is
  // not ordered. Any row carrying this tag marks its path as already saved.
  const sameRelease = Boolean(releaseTag) && existingCompiled.some((f) => releaseTagFromRow(f) === releaseTag);
  const rowPaths = new Set(
    existingCompiled.filter((f) => releaseTagFromRow(f) === releaseTag).map((f) => f.path),
  );

  return assetsToSave.map((asset, i) => {
    const displayName = displayNameFor(asset, {
      artifactName,
      isPrimary: i === 0 && !!artifactName && asset.name !== USER_MANUAL_FILE,
    });
    const path = `_compiled/${displayName}`;
    return {
      asset,
      displayName,
      path,
      // Already saved for THIS release — skip the download, keep the row.
      alreadySaved: sameRelease && rowPaths.has(path),
    };
  });
}

/** Run the save loop detached. Never throws — every failure is a record state. */
async function runArtifactSave(record, plan, { userId, projectId, repoFullName, headers, releaseTag, bodyAssetsMode }) {
  try {
    for (const item of plan) {
      if (item.alreadySaved) {
        markArtifactSaved(record, {
          path: item.path, url: null, name: item.displayName, size: item.asset.size, alreadySaved: true,
        });
        await writeArtifactSaveRecord(record);
        continue;
      }
      markArtifactSaving(record, item.asset.name);
      await writeArtifactSaveRecord(record);
      try {
        const result = await processAsset(item.asset, {
          userId, projectId, repoFullName, headers,
          displayName: item.displayName, path: item.path, releaseTag, bodyAssetsMode,
        });
        markArtifactSaved(record, result);
      } catch (assetErr) {
        markArtifactFailed(record, item.asset.name || 'asset', assetErr?.message || String(assetErr));
      }
      await writeArtifactSaveRecord(record);
    }

    // Only once something landed: clear `_compiled/` rows that this release does
    // not carry (a renamed artifact from an older build), so the file tree and
    // the network-flash picker cannot offer a stale app. A total failure keeps
    // the previous build exactly where it was.
    if (record.artifacts.length > 0) {
      const keep = new Set(plan.map((p) => p.path));
      const stale = (await prisma.projectFile.findMany({
        where: { project_id: projectId, created_by_id: userId },
        select: { id: true, path: true },
      })).filter((f) => f.path.startsWith('_compiled/') && !keep.has(f.path));
      if (stale.length > 0) {
        await prisma.projectFile.deleteMany({ where: { id: { in: stale.map((f) => f.id) } } });
      }
    }

    if (record.artifacts.length === 0) {
      const detail = (record.errors || []).slice(0, 3).map((e) => String(e).replace(/\s+/g, ' ').trim()).join('; ');
      finishArtifactSaveRecord(record, {
        fatalError: `Failed to download any artifacts. ${detail}`,
      });
    } else {
      finishArtifactSaveRecord(record);
    }
    await writeArtifactSaveRecord(record);
  } catch (err) {
    // The detached runner must never produce an unhandled rejection.
    console.error('[saveCompiledArtifacts] save job crashed:', err?.message || err);
    finishArtifactSaveRecord(record, { fatalError: err?.message || String(err) });
    await writeArtifactSaveRecord(record);
  }
}

export default async function handler({ user, body }) {
  const { projectId, repoFullName: bodyRepoFullName, target, assets: bodyAssets, releaseTag: bodyReleaseTag } = body;
  if (!projectId) throw Object.assign(new Error('projectId required'), { status: 400 });

  const project = await prisma.project.findFirst({
    where: { id: projectId, created_by_id: user.id },
    select: { id: true, github_repo: true, compile_target: true },
  });
  if (!project) throw Object.assign(new Error('Project not found'), { status: 404 });

  const repoFullName = bodyRepoFullName || project.github_repo;
  if (!repoFullName) throw Object.assign(new Error('repoFullName required'), { status: 400 });

  // Reload-safe and double-press-safe: if this project's save is already
  // running, answer with its current state instead of starting a second one.
  const existingRecord = await readArtifactSaveRecord(projectId);
  const existingRows = (await prisma.projectFile.findMany({
    where: { project_id: projectId, created_by_id: user.id },
    select: { path: true, content: true, file_url: true },
  })).filter((f) => f.path.startsWith('_compiled/'));
  if (existingRecord?.phase === 'saving') {
    const view = artifactSaveResponse({ record: existingRecord, savedRows: existingRows });
    const live = view.phase === 'saving';
    if (live) return { ...view, started: false, alreadyRunning: true };
  }

  const useBodyAssets = Array.isArray(bodyAssets) && bodyAssets.length > 0;
  const adapter = target ? getCompileTarget(target) : (project.compile_target ? getCompileTarget(project.compile_target) : null);
  const artifactName = adapter?.artifact?.artifactName;

  const accessToken = await getGithubToken(user.id);
  const h = ghHeaders(accessToken);

  let release = null;
  let assetsToSave = [];
  if (useBodyAssets) {
    // The caller (CompilePanel) already fetched the release via getCompileStatus
    // and included its asset list — no duplicate GitHub fetch.
    assetsToSave = bodyAssets.map((a) => ({
      name: a.name,
      size: a.size,
      downloadUrl: a.downloadUrl || a.url,
    }));
  } else {
    release = await fetchRelease({ repoFullName, headers: h, releaseTag: bodyReleaseTag });
    if (!release.assets || release.assets.length === 0) {
      throw Object.assign(new Error('Release has no downloadable assets'), { status: 404 });
    }
    assetsToSave = release.assets;
  }

  const releaseTag = bodyReleaseTag || release?.tag_name || 'latest';
  const plan = planAssets({ assetsToSave, artifactName, releaseTag, existingCompiled: existingRows });

  // The same-release short-circuit, now available in BOTH modes: if every asset
  // in this release already has a row from this same tag, there is nothing to do.
  if (plan.length > 0 && plan.every((p) => p.alreadySaved)) {
    const record = createArtifactSaveRecord({
      projectId, userId: user.id, repoFullName, target, releaseTag,
      assets: plan.map((p) => ({ name: p.displayName, path: p.path })),
    });
    for (const p of plan) {
      markArtifactSaved(record, { path: p.path, url: null, name: p.displayName, size: p.asset.size, alreadySaved: true });
    }
    finishArtifactSaveRecord(record);
    await writeArtifactSaveRecord(record);
    return artifactSaveResponse({ record, savedRows: existingRows, extra: { started: false, alreadyExists: true } });
  }

  const record = createArtifactSaveRecord({
    projectId, userId: user.id, repoFullName, target, releaseTag,
    assets: plan.map((p) => ({ name: p.displayName, path: p.path })),
  });
  await writeArtifactSaveRecord(record);

  // Detached on purpose: the request returns now, the ~217 MB of download and
  // re-upload continues on the server. `void` + an internal try/catch means the
  // handler's response is never held open and a save failure can never surface
  // as a rejected request.
  void runArtifactSave(record, plan, {
    userId: user.id, projectId, repoFullName, headers: h, releaseTag, bodyAssetsMode: useBodyAssets,
  });

  return artifactSaveResponse({ record, savedRows: existingRows, extra: { started: true } });
}
