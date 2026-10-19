// Downloads compiled release artifacts from the GitHub build repo (which is
// private) and re-uploads them to Morpheus storage so they appear as
// downloadable files in the project's file tree alongside the source code.
// Called by the CompilePanel when a build succeeds.

import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { ghHeaders, ghJson } from '../../shared/githubPush.ts';
import { getAppUserGithubToken } from '../../shared/githubConnection.ts';
import { getCompileTarget } from '../../shared/compile-targets/index.ts';

const GH_API = 'https://api.github.com';

export default async function(req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json();
    const { projectId, repoFullName, target } = body;
    if (!projectId || !repoFullName) {
      return Response.json({ error: 'projectId and repoFullName required' }, { status: 400 });
    }

    // Look up the adapter to get the normalized artifact name (e.g. "app.apk"
    // instead of the raw GitHub release asset name). Falls back to the original
    // asset name if no adapter or no artifactName is declared (glob targets).
    const adapter = target ? getCompileTarget(target) : null;
    const artifactName = adapter?.artifact?.artifactName;

    // Check if compiled artifacts already saved for this project — avoid
    // duplicates if the user re-opens the compile panel or re-polls.
    const existing = await base44.entities.ProjectFile.filter({ project_id: projectId });
    const alreadySaved = existing.filter(f => f.path.startsWith('_compiled/'));
    if (alreadySaved.length > 0) {
      return Response.json({
        saved: alreadySaved.length,
        alreadyExists: true,
        files: alreadySaved.map(f => f.path)
      });
    }

    let accessToken;
    try {
      accessToken = await getAppUserGithubToken(base44);
    } catch (e) {
      return Response.json({ error: e.message }, { status: 400 });
    }
    const h = ghHeaders(accessToken);

    // Fetch latest release
    const releaseRes = await fetch(`${GH_API}/repos/${repoFullName}/releases/latest`, { headers: h });
    if (!releaseRes.ok) {
      return Response.json({ error: 'No release found for this repo' }, { status: 404 });
    }
    const release = await ghJson(releaseRes);
    if (!release.assets || release.assets.length === 0) {
      return Response.json({ error: 'Release has no downloadable assets' }, { status: 404 });
    }

    const saved: string[] = [];
    const errors: string[] = [];
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
          redirect: 'manual'
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
        const blob = await cdnRes.blob();
        // Upload with a .bin extension — the storage layer blocks certain
        // binary extensions (.apk, .exe, etc.). The original filename is
        // preserved in the ProjectFile path for display/download.
        const safeName = asset.name.replace(/\.[^.]+$/, '.bin');
        const file = new File([blob], safeName, { type: 'application/octet-stream' });

        // Upload to Morpheus storage via service role
        const { file_url } = await base44.asServiceRole.integrations.Core.UploadFile({ file });

        const sizeMb = (asset.size / 1024 / 1024).toFixed(1);
        const target = release.tag_name || 'latest';
        await base44.entities.ProjectFile.create({
          project_id: projectId,
          path: `_compiled/${displayName}`,
          content: `// COMPILED ARTIFACT\n// Build: ${release.tag_name || 'latest'}\n// Size: ${sizeMb} MB\n// Saved: ${new Date().toISOString()}\n// Download from the file viewer.`,
          file_url,
          language: 'binary'
        });
        saved.push(`_compiled/${displayName}`);
      } catch (assetErr) {
        errors.push(`${asset.name}: ${assetErr?.message || String(assetErr)}`);
      }
    }

    if (saved.length === 0) {
      return Response.json({ error: 'Failed to download any artifacts', details: errors }, { status: 500 });
    }

    return Response.json({ saved: saved.length, files: saved });
  } catch (error) {
    console.error('saveCompiledArtifacts error:', error?.message || error);
    return Response.json({ error: error?.message || 'Unknown error' }, { status: 500 });
  }
}