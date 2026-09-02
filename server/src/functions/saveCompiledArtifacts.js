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
import { uploadFile } from '../storage.js';

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
};

function contentTypeFor(filename) {
  const match = /\.[^.]+$/.exec(filename || '');
  return (match && CONTENT_TYPES[match[0].toLowerCase()]) || 'application/octet-stream';
}

export default async function handler({ user, body, res }) {
  const { projectId, repoFullName, target } = body;
  if (!projectId || !repoFullName) {
    throw Object.assign(new Error('projectId and repoFullName required'), { status: 400 });
  }

  // Look up the adapter to get the normalized artifact name (e.g. "app.apk"
  // instead of the raw GitHub release asset name). Falls back to the original
  // asset name if no adapter or no artifactName is declared (glob targets).
  const adapter = target ? getCompileTarget(target) : null;
  const artifactName = adapter?.artifact?.artifactName;

  // Check if compiled artifacts already saved for this project — avoid
  // duplicates if the user re-opens the compile panel or re-polls.
  const existing = await prisma.projectFile.findMany({ where: { project_id: projectId, created_by_id: user.id } });
  const alreadySaved = existing.filter((f) => f.path.startsWith('_compiled/'));
  if (alreadySaved.length > 0) {
    return {
      saved: alreadySaved.length,
      alreadyExists: true,
      files: alreadySaved.map((f) => f.path),
    };
  }

  const accessToken = await getGithubToken(user.id);
  const h = ghHeaders(accessToken);

  // Fetch latest release
  const releaseRes = await fetch(`${GH_API}/repos/${repoFullName}/releases/latest`, { headers: h });
  if (!releaseRes.ok) {
    throw Object.assign(new Error('No release found for this repo'), { status: 404 });
  }
  const release = await ghJson(releaseRes);
  if (!release.assets || release.assets.length === 0) {
    throw Object.assign(new Error('Release has no downloadable assets'), { status: 404 });
  }

  const saved = [];
  const errors = [];
  for (let i = 0; i < release.assets.length; i++) {
    const asset = release.assets[i];
    try {
      // Use the adapter's normalized artifact name for the primary asset;
      // keep original names for additional assets (glob targets) or when no
      // artifactName is declared.
      const displayName = (i === 0 && artifactName) ? artifactName : asset.name;
      // Download the asset binary from the private repo. The API endpoint
      // returns a 302 redirect to a signed CDN URL — we use manual redirect
      // to get the Location header, then fetch the signed URL WITHOUT the
      // Authorization header (the CDN rejects authed requests).
      const downloadRes = await fetch(`${GH_API}/repos/${repoFullName}/releases/assets/${asset.id}`, {
        headers: { ...h, Accept: 'application/octet-stream' },
        redirect: 'manual',
      });
      if (downloadRes.status !== 302) {
        errors.push(`${asset.name}: download HTTP ${downloadRes.status}`);
        continue;
      }
      const cdnUrl = downloadRes.headers.get('location');
      if (!cdnUrl) {
        errors.push(`${asset.name}: no redirect Location`);
        continue;
      }
      const cdnRes = await fetch(cdnUrl, { redirect: 'follow' });
      if (!cdnRes.ok) {
        errors.push(`${asset.name}: CDN HTTP ${cdnRes.status}`);
        continue;
      }
      const buffer = Buffer.from(await cdnRes.arrayBuffer());
      // Upload keeping the real extension (app.apk, app.exe, ...) — nothing
      // in storage.js or the upload route actually blocks these, and giving
      // the *stored* file a real extension (not just the ProjectFile path
      // shown in the file tree) matters because Android's package installer,
      // and plenty of download managers, decide what to do with a file by
      // the extension on the URL/saved filename itself, not by an HTML
      // download="..." attribute a browser is free to ignore. A ".bin" here
      // meant a straight download-and-tap on Android silently produced a
      // file Android wouldn't offer to install without the user manually
      // renaming it back to .apk first.
      const { file_url } = await uploadFile({ buffer, filename: displayName, contentType: contentTypeFor(displayName) });

      const sizeMb = (asset.size / 1024 / 1024).toFixed(1);
      await prisma.projectFile.create({
        data: {
          created_by_id: user.id,
          project_id: projectId,
          path: `_compiled/${displayName}`,
          content: `// COMPILED ARTIFACT\n// Build: ${release.tag_name || 'latest'}\n// Size: ${sizeMb} MB\n// Saved: ${new Date().toISOString()}\n// Download from the file viewer.`,
          file_url,
          language: 'binary',
        },
      });
      saved.push(`_compiled/${displayName}`);
    } catch (assetErr) {
      errors.push(`${asset.name}: ${assetErr?.message || String(assetErr)}`);
    }
  }

  if (saved.length === 0) {
    res.status(500).json({ error: 'Failed to download any artifacts', details: errors });
    return;
  }

  return { saved: saved.length, files: saved };
}
