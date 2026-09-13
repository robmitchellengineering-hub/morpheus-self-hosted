// Ported from base44/functions/saveCompiledArtifacts/entry.ts.
// Stores the GitHub Release asset URL of each compiled binary directly on the
// ProjectFile row — no download, no re-upload to Morpheus storage, no binary
// in memory. The browser downloads directly from GitHub, which is what
// GitHub Releases are for. Called by the CompilePanel when a build succeeds.
import { prisma } from '../db.js';
import { ghHeaders, ghJson, getGithubToken } from '../lib/github.js';
import { getCompileTarget } from '../lib/compile-targets/index.js';

const GH_API = 'https://api.github.com';

export default async function handler({ user, body }) {
  const { projectId, repoFullName, target, assets: bodyAssets } = body;
  if (!projectId || !repoFullName) {
    throw Object.assign(new Error('projectId and repoFullName required'), { status: 400 });
  }

  // OWNERSHIP CHECK — a user may only save compiled artifacts into a project
  // they own. Without this, a malicious user could pass another user's
  // projectId and delete that project's existing `_compiled/` rows or create
  // rows in a project they don't control. (Review #113 fixed missing check.)
  const projectOwned = await prisma.project.findFirst({
    where: { id: projectId, created_by_id: user.id },
    select: { id: true },
  });
  if (!projectOwned) {
    throw Object.assign(new Error('Project not found or does not belong to you'), { status: 404 });
  }

  const useBodyAssets = Array.isArray(bodyAssets) && bodyAssets.length > 0;

  // Look up the adapter to get the normalized artifact name (e.g. "app.apk"
  // instead of the raw GitHub release asset name). Falls back to the original
  // asset name if no adapter or no artifactName is declared (glob targets).
  const adapter = target ? getCompileTarget(target) : null;
  const artifactName = adapter?.artifact?.artifactName;

  const accessToken = await getGithubToken(user.id, { projectId });
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
      url: a.downloadUrl || a.url || a.browser_download_url,
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
    assetsToSave = release.assets.map((a) => ({
      name: a.name,
      size: a.size,
      url: a.browser_download_url,
    }));
  }

  const releaseTag = release?.tag_name || 'latest';

  // Compiled artifacts already saved for this project — but only short-circuit
  // when they're from THIS SAME release. The tag is embedded in the saved
  // row's content note (`[Build <tag>]`) precisely so this comparison is
  // possible. Before 2026-09-03 this checked existence only, so recompiling
  // a project always silently kept serving the very first build ever saved.
  const existing = await prisma.projectFile.findMany({ where: { project_id: projectId, created_by_id: user.id } });
  const alreadySaved = existing.filter((f) => f.path.startsWith('_compiled/'));
  const savedTag = alreadySaved[0]?.content?.match(/\[Build (\S+)\]/)?.[1];
  if (!useBodyAssets && alreadySaved.length > 0 && savedTag && release?.tag_name && savedTag === release.tag_name) {
    return {
      saved: alreadySaved.length,
      alreadyExists: true,
      files: alreadySaved.map((f) => f.path),
      artifacts: alreadySaved.map((f) => ({
        path: f.path,
        url: f.file_url,
        name: f.path.split('/').pop(),
      })),
    };
  }

  // Use a Prisma transaction so either all new _compiled rows are created
  // and the old rows are deleted atomically, or nothing happens. This
  // prevents a partial save from wiping out the previous artifact links.
  let savedRecords;
  try {
    savedRecords = await prisma.$transaction(async (tx) => {
      // Delete previous _compiled rows first so stable artifact names can be
      // recreated without colliding with the (project_id, path) unique
      // constraint. The transaction rolls back the delete if a create fails.
      await tx.projectFile.deleteMany({
        where: { project_id: projectId, path: { startsWith: '_compiled/' } },
      });

      const created = [];
      const artifactsCreated = [];
      for (let i = 0; i < assetsToSave.length; i++) {
        const asset = assetsToSave[i];
        if (!asset.url) {
          throw new Error(`${asset.name || 'asset'}: no download URL available`);
        }
        const displayName = i === 0 && artifactName ? artifactName : asset.name;
        const path = `_compiled/${displayName}`;
        const sizeMb = asset.size ? (asset.size / 1024 / 1024).toFixed(1) : '?';
        const createdRow = await tx.projectFile.create({
          data: {
            created_by_id: user.id,
            project_id: projectId,
            path,
            content: `[Build ${releaseTag}] Compiled binary hosted on GitHub Releases (${sizeMb} MB)`,
            file_url: asset.url,
            language: 'binary',
          },
        });
        created.push(createdRow);
        artifactsCreated.push({ path, url: asset.url, name: displayName, size: asset.size });
      }
      return {
        saved: created.length,
        files: created.map((f) => f.path),
        artifacts: artifactsCreated,
      };
    });
  } catch (err) {
    // If any create fails, the transaction rolls back and old links remain.
    const message = err?.message || String(err);
    throw Object.assign(new Error(`Failed to save compiled artifacts: ${message}`), { status: 500 });
  }

  return savedRecords;
}
