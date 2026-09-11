// Mirrors Base44's `integrations.Core.UploadFile` — the frontend shim's
// `base44.integrations.Core.UploadFile({ file })` posts here.
import { Router } from 'express';
import multer from 'multer';
import { requireAuth } from '../auth.js';
import { uploadFile } from '../storage.js';
import { sendError } from '../lib/errorLogger.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });
const router = Router();

router.post('/', requireAuth, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });
    const { file_url } = await uploadFile({
      buffer: req.file.buffer,
      filename: req.file.originalname,
      contentType: req.file.mimetype,
    });
    res.json({ file_url });
  } catch (err) {
    return sendError(res, 500, 'uploads:upload', err);
  }
});

export default router;
