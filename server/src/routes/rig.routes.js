// THE RIG: read, name, order and save the captures and mics a plugin project carries.
//
// ── WHY THIS IS A ROUTE AND NOT A CLIENT-SIDE EDIT OF THE FILE ───────────────────────────────────────────
// The same three reasons `board.routes.js` gives, and they are the same three reasons because this is the
// same shape of document: a list the user arranges, stored in `morpheus.plugin.json`, read by the generator.
//
//   1. The view needs the project's actual files — a `.nam` has to parse and a `.wav` has to decode before
//      either can be offered in a selector, and a client cannot see a file's contents.
//   2. Validation is not optional. A path that is not in the project, or a duplicate, is a rig the finder
//      would silently shorten, and a client-side check is a courtesy, not a check.
//   3. The manifest must be written by the SAME writer the board route and the scaffolder use. Three writers
//      for one file is how a generated manifest and an edited one drift apart.
//
// ⚠️ IT ALSO OWNS THE `.nam` UPLOAD, and that is the half that makes a rig buildable at all: a cabinet had a
// route (`cabinet.routes.js`) and a capture had none, so a project could be given a second microphone and
// never a second amplifier. A `.nam` is JSON TEXT, so unlike a WAV it needs no object storage — the row's
// own `content` is the file, which is exactly why `cabinetFile.js` says the model "does not have this
// problem at all".
//
// IT WRITES A PROJECT FILE, NOT A BUILD. Saving a rig does not compile anything; the next COMPILE reads it.
import { Router } from 'express';
import multer from 'multer';
import { prisma } from '../db.js';
import { requireAuth, blockWidget } from '../auth.js';
import { PLUGIN_MANIFEST, manifestWith, readManifest } from '../lib/audioPluginProject.js';
import { hydrateCabinets } from '../lib/cabinetFile.js';
import { MODEL_DIR, inspectModel } from '../lib/namPlugin.js';
import { isCapturePath, rigPatch, rigView } from '../lib/rigProject.js';
import { fetchStoredBytes } from '../storage.js';

/**
 * The largest capture this accepts. A `.nam` is JSON and the biggest real ones are a few megabytes; this is
 * about not storing a film, and it is generous for the same reason the cabinet's 16 MB is.
 */
const MAX_CAPTURE_BYTES = 32 * 1024 * 1024;

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_CAPTURE_BYTES } });
const router = Router();

router.use(requireAuth, blockWidget);

async function ownedProject(userId, projectId) {
  const project = await prisma.project.findFirst({ where: { id: projectId, created_by_id: userId } });
  if (!project) throw Object.assign(new Error('Project not found'), { status: 404 });
  return project;
}

const pluginFiles = (rows) => rows
  .filter((r) => !r.path.startsWith('_compiled/'))
  // ⚠️ THE ROW ID TRAVELS WITH THE FILE. The view is the only place the app can learn the id of the row its
  // Remove button is for, and the delete route scopes on both the id and the project. `encoding` travels for
  // `hydrateCabinets`'s sake — it is how an already-hydrated row says so.
  .map((r) => ({ id: r.id, path: r.path, content: r.content ?? '', encoding: r.encoding || undefined, file_url: r.file_url || undefined }));

/**
 * The project's files, with every STORED cabinet's bytes fetched.
 *
 * ⚠️ WITHOUT THIS A MIC ADDED THROUGH THIS VERY DIALOG READS AS UNUSABLE. `cabinet.routes.js` puts the audio
 * in storage and leaves a one-line preview in `content` — deliberately, because a 16 MB WAV does not belong
 * in a text column. `rigView` decodes each `.wav` to say whether it will convolve, so a preview line decodes
 * to rubbish and the row is reported "not usable" while the COMPILE, which hydrates first (see
 * `compileProject.js`), bakes it in perfectly. Two surfaces disagreeing about one file is the exact drift
 * `rigProject.js` exists to prevent, so the view hydrates through the same function the compile does.
 */
async function hydratedFiles(rows) {
  const { files, warnings } = await hydrateCabinets(pluginFiles(rows), { fetchBytes: fetchStoredBytes });
  return { files, warnings };
}

/** The view, with any hydration warning in front of its own — a cabinet the build cannot get is the first thing to say. */
const viewOf = (files, manifest, warnings = []) => {
  const view = rigView(files, manifest);
  return { ...view, warnings: [...warnings, ...view.warnings] };
};

/** The manifest as it will be AFTER the patch, so the answer to a save is the rig the build will see. */
function patched(manifest, patch) {
  const next = { ...manifest };
  for (const [key, value] of Object.entries(patch || {})) {
    if (value === null || value === undefined) delete next[key];
    else next[key] = value;
  }
  return next;
}

// ── Read ─────────────────────────────────────────────────────────────────────────────────────────────────
router.get('/:projectId', async (req, res) => {
  try {
    await ownedProject(req.user.id, req.params.projectId);
    const rows = await prisma.projectFile.findMany({ where: { project_id: req.params.projectId } });
    const { files, warnings } = await hydratedFiles(rows);
    res.json(viewOf(files, readManifest(files), warnings));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ── Save ─────────────────────────────────────────────────────────────────────────────────────────────────
router.put('/:projectId', async (req, res) => {
  try {
    const project = await ownedProject(req.user.id, req.params.projectId);
    const rows = await prisma.projectFile.findMany({ where: { project_id: project.id } });
    const { files, warnings } = await hydratedFiles(rows);
    const manifest = readManifest(files);

    const check = rigPatch(req.body || {}, { files });
    // ⚠️ A RIG THAT CANNOT BE BUILT IS REFUSED HERE RATHER THAN SAVED AND SILENTLY SHORTENED. The finder
    // drops a path it cannot find and drops a duplicate, which is right for a compile that is already
    // running — but a save is the moment the user is looking, and "saved" plus "not used" is the worst of
    // both. The board route refuses for exactly this reason.
    if (!check.ok) return res.status(400).json({ error: check.errors[0], errors: check.errors, warnings: check.warnings });

    const next = patched(manifest, check.patch);
    const existing = rows.find((r) => r.path === PLUGIN_MANIFEST);
    const content = manifestWith(existing?.content, manifest, check.patch);
    if (existing) {
      await prisma.projectFile.update({ where: { id: existing.id }, data: { content, language: 'json' } });
    } else {
      await prisma.projectFile.create({
        data: {
          project_id: project.id, created_by_id: req.user.id, path: PLUGIN_MANIFEST, content, language: 'json',
        },
      });
    }
    res.json(viewOf(files, next, warnings));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ── Add a capture ────────────────────────────────────────────────────────────────────────────────────────
router.post('/:projectId/model', upload.single('file'), async (req, res) => {
  try {
    const project = await ownedProject(req.user.id, req.params.projectId);
    if (!req.file) return res.status(400).json({ error: 'No file provided' });

    // ⚠️ THE BYTES ARE CHECKED, NOT THE NAME, and with the generator's own inspector — a `.nam` that cannot
    // be parsed is a capture the plugin would carry and never play, and the user's only clue would be that
    // the amp "sounds wrong" (or that the selector is missing a member). The same verdict the scaffold would
    // reach, said at the moment the file arrives rather than a compile later.
    if (!isCapturePath(req.file.originalname)) {
      return res.status(400).json({ error: `${req.file.originalname || 'that file'} is not a .nam — a capture is a NAM model file` });
    }
    const text = req.file.buffer.toString('utf8');
    const inspected = inspectModel(text);
    if (!inspected.ok) {
      return res.status(400).json({ error: `That .nam is not a usable NAM model — it ${inspected.reason}.` });
    }

    // The name is taken from the uploaded file, the same convention `cabinet.routes.js` uses, with the
    // extension lowercased because two files differing only in case is a support ticket.
    const base = String(req.file.originalname).replace(/\.[^.]*$/, '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 60) || 'capture';
    const path = `${MODEL_DIR}/${base}.nam`;

    const existing = await prisma.projectFile.findFirst({ where: { project_id: project.id, path } });
    if (existing) {
      await prisma.projectFile.update({ where: { id: existing.id }, data: { content: text, language: 'json' } });
    } else {
      await prisma.projectFile.create({
        data: {
          project_id: project.id, created_by_id: req.user.id, path, content: text, language: 'json',
        },
      });
    }

    const rows = await prisma.projectFile.findMany({ where: { project_id: project.id } });
    const { files, warnings } = await hydratedFiles(rows);
    res.json({ path, ...viewOf(files, readManifest(files), warnings) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ── Remove a capture ──────────────────────────────────────────────────────────────────────────────────────
router.delete('/:projectId/model/:fileId', async (req, res) => {
  try {
    await ownedProject(req.user.id, req.params.projectId);
    // Scoped to the project AND the path check, so this cannot be pointed at a source file by editing an id.
    const row = await prisma.projectFile.findFirst({
      where: { id: req.params.fileId, project_id: req.params.projectId },
    });
    if (!row || !isCapturePath(row.path)) return res.status(404).json({ error: 'No such capture' });
    await prisma.projectFile.delete({ where: { id: row.id } });

    const rows = await prisma.projectFile.findMany({ where: { project_id: req.params.projectId } });
    const { files, warnings } = await hydratedFiles(rows);
    res.json(viewOf(files, readManifest(files), warnings));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// A multer limit is reported as an error rather than as a 500: "that file is over 32 MB" is the user's file,
// and the panel should say so instead of showing a stack trace.
router.use((err, req, res, _next) => {
  if (!err) return;
  const tooBig = err.code === 'LIMIT_FILE_SIZE';
  res.status(400).json({ error: tooBig ? `That capture is larger than ${MAX_CAPTURE_BYTES / 1048576} MB.` : err.message });
});

export default router;
