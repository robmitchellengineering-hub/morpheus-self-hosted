// Mirrors Base44's `integrations.Core.UploadFile` — the frontend shim's
// `base44.integrations.Core.UploadFile({ file })` posts here.
//
// SCOPED TOKENS: `allowStoreUpload` rather than `blockWidget`, because the dock renders
// the SHOP tab and picking a product photo is part of adding a product there. See that
// middleware for why the store scope is enough and why the other scopes are not.
import { Router } from 'express';
import multer from 'multer';
import { requireAuth, allowStoreUpload } from '../auth.js';
import { uploadFile } from '../storage.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });
const router = Router();

router.post('/', requireAuth, allowStoreUpload, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });
    const { file_url } = await uploadFile({
      buffer: req.file.buffer,
      filename: req.file.originalname,
      contentType: req.file.mimetype,
    });
    res.json({ file_url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
