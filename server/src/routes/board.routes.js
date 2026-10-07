// The board: read, validate and save a plugin project's arrangement of blocks.
//
// ── WHY THIS IS A ROUTE AND NOT A CLIENT-SIDE EDIT OF THE FILE ───────────────────────────────────────────
// The board lives in `morpheus.plugin.json`, inside the project's own files, and the app can already edit a
// project file. It still gets a route, for three reasons that are all the same reason:
//
//   1. `boardView` needs to read the .nam and .wav the project actually has, to say whether the Amp model
//      block will do anything — a client cannot see the file list's contents.
//   2. Validation is not optional. A board is the one input to the plugin generator that the file tree
//      cannot check, and a client-side check is a courtesy, not a check (the same sentence
//      cabinet.routes.js carries).
//   3. The board must be written by the SAME writer the scaffolder uses. Two writers for one file is how a
//      generated manifest and an edited one drift apart and the plugin renames itself on the next build.
//
// IT WRITES A PROJECT FILE, NOT A BUILD. Saving a board does not compile anything; the next COMPILE reads
// it. That is deliberate: an arrangement is edited many times and compiled once.
import { Router } from 'express';
import { prisma } from '../db.js';
import { requireAuth, blockWidget } from '../auth.js';
import { PLUGIN_MANIFEST, boardFor, manifestWith, readManifest } from '../lib/audioPluginProject.js';
import { boardJson, boardView, nextInstanceId, validateBoard } from '../lib/board.js';
import { hydrateCabinets } from '../lib/cabinetFile.js';
import { rigView } from '../lib/rigProject.js';
import { fetchStoredBytes } from '../storage.js';

const router = Router();

router.use(requireAuth, blockWidget);

async function ownedProject(userId, projectId) {
  const project = await prisma.project.findFirst({ where: { id: projectId, created_by_id: userId } });
  if (!project) throw Object.assign(new Error('Project not found'), { status: 404 });
  return project;
}

const pluginFiles = (rows) => rows
  .filter((r) => !r.path.startsWith('_compiled/'))
  .map((r) => ({ path: r.path, content: r.content ?? '', encoding: r.encoding || undefined, file_url: r.file_url || undefined }));

const audioFile = (rows, ext) => (rows.find((r) => new RegExp(`\\.${ext}$`, 'i').test(r.path))?.path || null);

/**
 * The board as the app draws it — with the rig's own two selectors attached to the blocks they choose.
 *
 * ⚠️ THE APP AND THE PANEL HAVE TO NAME THE SAME MEMBERS. The plugin's Amp model and Cabinet blocks each
 * carry a choice control (Capture, Speaker) drawn from the rig table; the board editor drew those two blocks
 * with no controls at all, so the app's picture of the plugin was missing two controls the plugin has. They
 * come from `rigView` — the same finders the emitted table comes from — so a capture the generator dropped
 * cannot be offered by the editor either.
 *
 * ⚠️ AND IT HYDRATES FIRST, exactly as the rig route and the compile do. A cabinet added through the app
 * keeps its audio in storage with a preview line in `content`, so a view that skipped `hydrateCabinets` would
 * count that mic as unusable and the Speaker row would vanish from a project that has one.
 */
async function boardForView(rows, board, manifest) {
  const { files } = await hydrateCabinets(pluginFiles(rows), { fetchBytes: fetchStoredBytes });
  const rig = rigView(files, manifest);
  return boardView(board, {
    modelFile: audioFile(rows, 'nam'),
    cabFile: audioFile(rows, 'wav'),
    manifest,
    rig: rig.selectors,
  });
}

// ── Read ─────────────────────────────────────────────────────────────────────────────────────────────────
router.get('/:projectId', async (req, res) => {
  try {
    await ownedProject(req.user.id, req.params.projectId);
    const rows = await prisma.projectFile.findMany({ where: { project_id: req.params.projectId } });
    const files = pluginFiles(rows);
    const manifest = readManifest(files);
    const board = boardFor(files);
    res.json(await boardForView(rows, board, manifest));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ── Save ─────────────────────────────────────────────────────────────────────────────────────────────────
router.put('/:projectId', async (req, res) => {
  try {
    const project = await ownedProject(req.user.id, req.params.projectId);
    const rows = await prisma.projectFile.findMany({ where: { project_id: project.id } });
    const files = pluginFiles(rows);
    const manifest = readManifest(files);

    // The items arrive from the UI, so they are normalised into the shape the board is stored in before
    // anything looks at them — an `instanceId` that arrived as a string is still the same block, and an
    // editor that refused it would be strict about the wrong thing.
    const incoming = {
      nextInstanceId: nextInstanceId(req.body || {}),
      items: (Array.isArray(req.body?.items) ? req.body.items : []).map((it) => ({
        instanceId: Number(it?.instanceId),
        kind: String(it?.kind || ''),
        enabled: it?.enabled !== false,
        values: (it?.values && typeof it.values === 'object') ? { ...it.values } : {},
      })),
    };

    const check = validateBoard(incoming, {
      modelFile: audioFile(rows, 'nam'),
      cabFile: audioFile(rows, 'wav'),
    });
    // ⚠️ A BOARD THAT CANNOT BE BUILT IS REFUSED HERE RATHER THAN SAVED AND IGNORED. The scaffolder falls
    // back to the project's chain and warns, which is right for a compile that is already running — but a
    // save is the moment the user is looking, and "saved" plus "not used" is the worst of both.
    if (!check.ok) return res.status(400).json({ error: check.errors[0], errors: check.errors, warnings: check.warnings });

    const saved = boardJson(incoming);
    const existing = rows.find((r) => r.path === PLUGIN_MANIFEST);
    // ⚠️ AN EXISTING MANIFEST IS EDITED, NOT REGENERATED — see `manifestWith`, which the rig route shares.
    // Two writers for one file is how a generated manifest and an edited one drift apart.
    const content = manifestWith(existing?.content, manifest, { board: saved });
    if (existing) {
      await prisma.projectFile.update({ where: { id: existing.id }, data: { content, language: 'json' } });
    } else {
      await prisma.projectFile.create({
        data: {
          project_id: project.id, created_by_id: req.user.id, path: PLUGIN_MANIFEST, content, language: 'json',
        },
      });
    }
    res.json(await boardForView(rows, incoming, { ...manifest, board: saved }));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

export default router;
