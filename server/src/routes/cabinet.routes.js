// Upload a cabinet impulse response into a project, and list or remove the one it has.
//
// WHY ITS OWN ROUTE. The upload is multipart, which express.json() does not parse (the same reason
// mediaAssets.routes.js is a route), and the validation has to happen where it cannot be skipped — checking a
// magic number on the CLIENT is a courtesy, not a check. See lib/cabinetFile.js for why the Media panel's
// existing upload cannot serve this: it commits into the project's GitHub repo and keeps no bytes, while the
// scaffolder that bakes the cabinet runs here, from `project_files`, before anything is pushed.
//
// IT STORES THE BYTES AND LETS THE SCAFFOLDER FETCH THEM. `content` holds a short human line — the schema
// says `file_url` is for the bytes and `content` is a preview — and lib/cabinetFile.js's hydration turns the
// stored URL back into content immediately before the scaffold runs, which is the only moment it is needed.
import { Router } from 'express';
import multer from 'multer';
import { prisma } from '../db.js';
import { requireAuth, blockWidget } from '../auth.js';
import { uploadFile } from '../storage.js';
import { CABINET_DIR, MAX_CABINET_BYTES, isCabinetPath, validateCabinet } from '../lib/cabinetFile.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_CABINET_BYTES } });
const router = Router();

router.use(requireAuth, blockWidget);

async function ownedProject(userId, projectId) {
  const project = await prisma.project.findFirst({ where: { id: projectId, created_by_id: userId } });
  if (!project) throw Object.assign(new Error('Project not found'), { status: 404 });
  return project;
}

/** The project's cabinet rows, newest first. A project can hold more than one; the scaffold uses the first. */
async function cabinets(projectId) {
  const rows = await prisma.projectFile.findMany({ where: { project_id: projectId } });
  return rows.filter((r) => isCabinetPath(r.path));
}

const view = (row) => ({
  id: row.id,
  path: row.path,
  content: row.content,
  file_url: row.file_url || null,
  language: row.language,
  // WHETHER THE BYTES ARE REACHABLE IS THE USEFUL FACT, not the row's existence: a row whose upload failed is
  // a cabinet the build does not get, and the panel should be able to say so before a compile is spent.
  stored: Boolean(row.file_url),
  size: (() => {
    const m = /(\d+) bytes/.exec(row.content || '');
    return m ? Number(m[1]) : null;
  })(),
});

// ── List ─────────────────────────────────────────────────────────────────────────────────────────────────
router.get('/:projectId', async (req, res) => {
  try {
    await ownedProject(req.user.id, req.params.projectId);
    const rows = await cabinets(req.params.projectId);
    res.json({ cabinets: rows.map(view) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ── Upload ───────────────────────────────────────────────────────────────────────────────────────────────
router.post('/:projectId', upload.single('file'), async (req, res) => {
  try {
    const project = await ownedProject(req.user.id, req.params.projectId);
    if (!req.file) return res.status(400).json({ error: 'No file provided' });

    const check = validateCabinet({ filename: req.file.originalname, bytes: req.file.buffer });
    if (!check.ok) return res.status(400).json({ error: check.reason });

    // The name is taken from the uploaded file, so the project reads like the user's own folder — with the
    // extension lowercased because two files differing only in case is a support ticket.
    const base = String(req.file.originalname).replace(/\.[^.]*$/, '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 60) || 'cabinet';
    const path = `${CABINET_DIR}/${base}.wav`;

    const { file_url } = await uploadFile({
      buffer: req.file.buffer,
      filename: `${base}.wav`,
      contentType: 'audio/wav',
    });

    const content = `Cabinet impulse response: ${base}.wav, ${check.size} bytes. The audio is in storage, not here — see file_url.\n`;
    const existing = await prisma.projectFile.findFirst({ where: { project_id: project.id, path } });
    const row = existing
      ? await prisma.projectFile.update({ where: { id: existing.id }, data: { content, file_url, language: 'binary' } })
      : await prisma.projectFile.create({
        data: {
          project_id: project.id, created_by_id: req.user.id, path, content, file_url, language: 'binary',
        },
      });

    res.json({ cabinet: view(row) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ── Remove ───────────────────────────────────────────────────────────────────────────────────────────────
router.delete('/:projectId/:fileId', async (req, res) => {
  try {
    await ownedProject(req.user.id, req.params.projectId);
    // Scoped to the project AND the path check, so this cannot be pointed at a source file by editing an id.
    const row = await prisma.projectFile.findFirst({
      where: { id: req.params.fileId, project_id: req.params.projectId },
    });
    if (!row || !isCabinetPath(row.path)) return res.status(404).json({ error: 'No such cabinet' });
    await prisma.projectFile.delete({ where: { id: row.id } });
    res.json({ ok: true });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

export default router;
