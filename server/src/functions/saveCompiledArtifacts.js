// Ported from base44/functions/saveCompiledArtifacts/entry.ts.
// Downloads compiled release artifacts from the GitHub build repo (which is
// private) and re-uploads them to Morpheus storage so they appear as
// downloadable files in the project's file tree alongside the source code.
// Called by the CompilePanel when a build succeeds.
//
// Binary handling: the original used base44's asServiceRole UploadFile
// integration (object storage, not an inline DB column) — per
// PORTING_GUIDE.md's call-mapping table that's `uploadFile({ buffer,
// filename, contentType })` from storage.js. We keep that here: binaries
// are streamed straight to disk/S3 via storage.js and only the returned
// file_url is stored on the ProjectFile row; `content` stays a small text
// note (matching the original's placeholder comment), never the binary
// itself or a base64 blob in the DB.
import { prisma } from '../db.js';
import { ghHeaders, ghJson, getGithubToken } from '../lib/github.js';
import { getCompileTarget } from '../lib/compile-targets/index.js';
import { summarizeArtifactSave } from '../lib/artifactSaveOutcome.js';
import { USER_MANUAL_FILE } from '../lib/appUserManual.js';
import { uploadFileStream } from '../storage.js';
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

async function processAsset(asset, { userId, projectId, repoFullName, headers, artifactName, isPrimary, releaseTag, bodyAssetsMode }) {
  const displayName = isPrimary && artifactName ? artifactName : asset.name;
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
  await prisma.projectFile.create({
    data: {
      created_by_id: userId,
      project_id: projectId,
      path: `_compiled/${displayName}`,
      content: `// COMPILED ARTIFACT\n// Build: ${releaseTag || 'latest'}\n// Size: ${sizeMb} MB\n// Saved: ${new Date().toISOString()}\n// Download from the file viewer.`,
      file_url,
      language: 'binary',
    },
  });
  return { path: `_compiled/${displayName}`, url: file_url, name: displayName, size: asset.size };
}

export default async function handler({ user, body, res }) {
  const { projectId, repoFullName, target, assets: bodyAssets } = body;
  if (!projectId || !repoFullName) {
    throw Object.assign(new Error('projectId and repoFullName required'), { status: 400 });
  }
  const useBodyAssets = Array.isArray(bodyAssets) && bodyAssets.length > 0;

  // Look up the adapter to get the normalized artifact name (e.g. "app.apk"
  // instead of the raw GitHub release asset name). Falls back to the original
  // asset name if no adapter or no artifactName is declared (glob targets).
  const adapter = target ? getCompileTarget(target) : null;
  const artifactName = adapter?.artifact?.artifactName;

  const accessToken = await getGithubToken(user.id);
  const h = ghHeaders(accessToken);

  let release = null;
  let assetsToSave = [];
  if (useBodyAssets) {
    // Caller (CompilePanel) already fetched the release via getCompileStatus
    // and included its asset list — use those download URLs directly, which
    // avoids a duplicate GitHub release fetch and works even when the release
    // endpoint is flaky.
    assetsToSave = bodyAssets.map((a) => ({
      name: a.name,
      size: a.size,
      downloadUrl: a.downloadUrl || a.url,
    }));
  } else {
    // Fetch latest release
    let releaseRes;
    try {
      releaseRes = await fetch(`${GH_API}/repos/${repoFullName}/releases/latest`, { headers: h });
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
    release = await ghJson(releaseRes);
    if (!release.assets || release.assets.length === 0) {
      throw Object.assign(new Error('Release has no downloadable assets'), { status: 404 });
    }
    assetsToSave = release.assets;
  }

  const releaseTag = release?.tag_name || 'latest';

  // Compiled artifacts already saved for this project — but only short-circuit
  // when they're from THIS SAME release. The tag is embedded in the saved
  // row's content note (`// Build: <tag>`) precisely so this comparison is
  // possible. Before 2026-09-03 this checked existence only, so recompiling
  // a project (RECOMPILE, "try again", an auto-fix loop's retry, ...) always
  // silently kept serving the very first build ever saved — every later
  // compile "succeeded" in the UI but never actually updated the downloadable
  // app. A same-release re-entry (component remount, a duplicate poll tick
  // hitting the completed state twice) still short-circuits, avoiding
  // duplicate rows/re-downloads for no reason.
  const existing = await prisma.projectFile.findMany({ where: { project_id: projectId, created_by_id: user.id } });
  const alreadySaved = existing.filter((f) => f.path.startsWith('_compiled/'));
  const savedTag = alreadySaved[0]?.content?.match(/\/\/ Build: (\S+)/)?.[1];
  if (!useBodyAssets && alreadySaved.length > 0 && savedTag && release?.tag_name && savedTag === release.tag_name) {
    return {
      saved: alreadySaved.length,
      alreadyExists: true,
      files: alreadySaved.map((f) => f.path),
      // The frontend's "done" panel needs a working download link right
      // away, not just the path — without this it fell back to GitHub's raw
      // browser_download_url, which 404s for anyone whose browser isn't
      // authenticated into the (private) build repo. See the matching
      // `artifacts` field built below for a fresh save.
      artifacts: alreadySaved.map((f) => ({ path: f.path, url: f.file_url, name: f.path.split('/').pop() })),
    };
  }
  // A new release supersedes whatever was saved before — clear the stale
  // rows so the file tree doesn't end up with two _compiled/app.apk entries
  // (Prisma has no upsert-by-path here; path isn't unique) and so the
  // FileViewer's download always points at the build that was just made.
  // For body-assets mode we always clear and re-save: the caller is only
  // invoking this once per success, and without a release tag we cannot
  // safely short-circuit.
  if (alreadySaved.length > 0) {
    await prisma.projectFile.deleteMany({ where: { id: { in: alreadySaved.map((f) => f.id) } } });
  }

  const saved = [];
  const artifacts = [];
  const errors = [];
  // Names of the assets that did not land, kept separately from the detail
  // strings above so the caller can name them without parsing. A glob target
  // (rpi-distro/linux-distro) releases several assets, and one failure there
  // used to leave the response identical to a complete save — see
  // lib/artifactSaveOutcome.js.
  const failed = [];
  for (let i = 0; i < assetsToSave.length; i++) {
    const asset = assetsToSave[i];
    try {
      const result = await processAsset(asset, {
        userId: user.id,
        projectId,
        repoFullName,
        headers: h,
        artifactName,
        // Never the manual: the primary asset is RENAMED to artifactName, so if the manual ever
        // landed first the download named app.apk would be a text file. See lib/appUserManual.js.
        isPrimary: i === 0 && !!artifactName && asset.name !== USER_MANUAL_FILE,
        releaseTag,
        bodyAssetsMode: useBodyAssets,
      });
      saved.push(result.path);
      artifacts.push(result);
    } catch (assetErr) {
      const name = asset.name || 'asset';
      failed.push(name);
      errors.push(`${name}: ${assetErr?.message || String(assetErr)}`);
    }
  }

  if (saved.length === 0) {
    const errorDetails = errors.slice(0, 3).map(e => e.replace(/\s+/g, ' ').trim()).join('; ');
    res.status(500).json({ error: `Failed to download any artifacts. ${errorDetails}`, details: errors });
    return;
  }

  // `artifacts` carries our own re-uploaded (public, working) URLs — the
  // frontend's "done" panel uses these instead of GitHub's raw
  // browser_download_url, which 404s for anyone not authenticated into the
  // private build repo (see the alreadySaved branch above for why).
  // summarizeArtifactSave keeps the all-saved shape unchanged and adds
  // `partial`/`failed`/`errors` when some assets did not land, so a partial save
  // cannot be read as "Build complete".
  return summarizeArtifactSave({ savedPaths: saved, artifacts, failed, errors });
}
