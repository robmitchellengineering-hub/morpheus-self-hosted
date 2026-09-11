// Media Library (2026-09-09) — a project's content assets. ZERO CUSTODY:
// Morpheus stores only the url + caption (project_assets table), never the
// bytes. "Add from device" streams the upload straight into the user's own
// GitHub repo (public/assets/*) and keeps nothing — the multer buffer lives
// in memory only long enough to POST to GitHub's Contents API.
//
// Its own route (not the generic function dispatcher) because the upload is
// multipart, which express.json() doesn't parse. See MediaPanel.jsx.
import { Router } from 'express';
import multer from 'multer';
import { prisma } from '../db.js';
import { requireAuth } from '../auth.js';
import { getGithubToken, ghHeaders, ghJson, createOrUpdateFile, deleteFile } from '../lib/github.js';
import {
  isMissingAssetTable, kindFromType, normalizeKind, slugify, extFromNameOrType,
} from '../lib/projectAssets.js';

const GH_API = 'https://api.github.com';
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });
const router = Router();

router.use(requireAuth);

async function ownedProject(userId, projectId) {
  const project = await prisma.project.findFirst({ where: { id: projectId, created_by_id: userId } });
  if (!project) throw Object.assign(new Error('Project not found'), { status: 404 });
  return project;
}

function assetView(row) {
  return {
    id: row.id, name: row.name, kind: row.kind, source: row.source,
    url: row.url, preview_url: row.preview_url, repo_path: row.repo_path,
    alt: row.alt, width: row.width, height: row.height, size: row.size,
    created_date: row.created_date,
  };
}

// ── List ────────────────────────────────────────────────────────────────
router.get('/:projectId', async (req, res) => {
  try {
    const project = await ownedProject(req.user.id, req.params.projectId);
    let assets = [];
    let migrated = true;
    try {
      const rows = await prisma.projectAsset.findMany({
        where: { project_id: project.id }, orderBy: { created_date: 'desc' },
      });
      assets = rows.map(assetView);
    } catch (err) {
      if (!isMissingAssetTable(err)) throw err;
      migrated = false;
    }
    res.json({ migrated, assets, githubRepo: project.github_repo || null });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ── Add by URL (operator hosts it themselves) ────────────────────────────
router.post('/:projectId/url', async (req, res) => {
  try {
    const project = await ownedProject(req.user.id, req.params.projectId);
    const { url, name, alt, kind } = req.body || {};
    if (!url || !/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'A valid http(s) url is required.' });
    // A CDN url often has no file extension — default to image (the common
    // case) rather than "other" so the panel renders a thumbnail.
    const guessed = kindFromType('', url);
    const row = await prisma.projectAsset.create({
      data: {
        created_by_id: req.user.id, project_id: project.id,
        name: String(name || url.split('/').pop() || 'asset').slice(0, 120),
        kind: normalizeKind(kind || (guessed === 'other' ? 'image' : guessed)),
        source: 'url',
        url: url.trim(),
        preview_url: url.trim(),
        alt: alt ? String(alt).slice(0, 300) : null,
      },
    });
    res.json({ asset: assetView(row) });
  } catch (err) {
    if (isMissingAssetTable(err)) return res.status(400).json({ error: 'migration-pending' });
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ── Add from device → commit into the user's own repo ────────────────────
router.post('/:projectId/upload', upload.single('file'), async (req, res) => {
  try {
    const project = await ownedProject(req.user.id, req.params.projectId);
    if (!req.file) return res.status(400).json({ error: 'No file provided.' });
    if (!project.github_repo || !project.github_repo.includes('/')) {
      return res.status(400).json({ error: 'Connect this project to a GitHub repo first (Export to GitHub), then upload — the file is committed straight into your repo.' });
    }
    const [owner, repo] = project.github_repo.split('/');
    const token = await getGithubToken(req.user.id, { projectId: req.params.projectId });

    // Default branch.
    const repoInfo = await ghJson(await fetch(`${GH_API}/repos/${owner}/${repo}`, { headers: ghHeaders(token) }));
    const branch = repoInfo?.default_branch || 'main';

    const ext = extFromNameOrType(req.file.originalname, req.file.mimetype);
    const base = slugify(req.body?.name || req.file.originalname.replace(/\.[a-z0-9]+$/i, ''));
    const repoPath = `public/assets/${base}.${ext}`;

    // Existing sha (if a file at this path already exists → update it).
    let sha;
    try {
      const existing = await ghJson(await fetch(
        `${GH_API}/repos/${owner}/${repo}/contents/${repoPath.split('/').map(encodeURIComponent).join('/')}?ref=${branch}`,
        { headers: ghHeaders(token) },
      ));
      if (existing?.sha) sha = existing.sha;
    } catch { /* not there yet — a create */ }

    await createOrUpdateFile(owner, repo, repoPath, req.file.buffer, branch, token,
      `Add media asset ${repoPath}`, sha);
    // req.file.buffer is now done with — never written anywhere else.

    const w = Number(req.body?.width) || null;
    const h = Number(req.body?.height) || null;
    const row = await prisma.projectAsset.create({
      data: {
        created_by_id: req.user.id, project_id: project.id,
        name: String(req.body?.name || req.file.originalname).slice(0, 120),
        kind: normalizeKind(kindFromType(req.file.mimetype, req.file.originalname)),
        source: 'repo',
        url: `/assets/${base}.${ext}`,
        preview_url: `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${repoPath}`,
        repo_path: repoPath,
        alt: req.body?.alt ? String(req.body.alt).slice(0, 300) : null,
        width: w, height: h, size: req.file.size,
      },
    });
    res.json({ asset: assetView(row) });
  } catch (err) {
    if (isMissingAssetTable(err)) return res.status(400).json({ error: 'migration-pending' });
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ── Delete ──────────────────────────────────────────────────────────────
router.delete('/:projectId/:assetId', async (req, res) => {
  try {
    const project = await ownedProject(req.user.id, req.params.projectId);
    const row = await prisma.projectAsset.findFirst({ where: { id: req.params.assetId, project_id: project.id } });
    if (!row) return res.status(404).json({ error: 'Asset not found.' });

    if (row.source === 'repo' && row.repo_path && project.github_repo?.includes('/')) {
      // Best-effort — a missing repo file shouldn't block removing the row.
      try {
        const [owner, repo] = project.github_repo.split('/');
        const token = await getGithubToken(req.user.id, { projectId: req.params.projectId });
        const repoInfo = await ghJson(await fetch(`${GH_API}/repos/${owner}/${repo}`, { headers: ghHeaders(token) }));
        const branch = repoInfo?.default_branch || 'main';
        const existing = await ghJson(await fetch(
          `${GH_API}/repos/${owner}/${repo}/contents/${row.repo_path.split('/').map(encodeURIComponent).join('/')}?ref=${branch}`,
          { headers: ghHeaders(token) },
        ));
        if (existing?.sha) {
          await deleteFile(owner, repo, row.repo_path, branch, existing.sha, token, `Remove media asset ${row.repo_path}`);
        }
      } catch (e) {
        console.warn('[mediaAssets] repo file delete failed (row removed anyway):', e.message);
      }
    }

    await prisma.projectAsset.delete({ where: { id: row.id } });
    res.json({ ok: true });
  } catch (err) {
    if (isMissingAssetTable(err)) return res.status(400).json({ error: 'migration-pending' });
    res.status(err.status || 500).json({ error: err.message });
  }
});

export default router;
