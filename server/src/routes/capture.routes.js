// The capture pre-flight, from the app: "will this recording train, and what will the trainer make of it?"
//
// WHY THIS ROUTE EXISTS. Capturing an amp is the part of the audio pathway a user does themselves — they play
// NAM's re-amp signal through their amp and record the output — and it is the part where the failure is
// expensive and silent. A pair that is misaligned, clipped, or recorded from an amp whose knob moved halfway
// through trains into a model that sounds wrong, and nothing in the trainer's output says which of those it
// was. By then an hour of GPU time is gone.
//
// THE WORK IS IN lib/audio/captureCheck.js, not here — everything decidable about a capture is decidable
// without a server, and the guards job has no `npm install`, so it cannot import express. That module is
// tested on every pull request; this file is multipart and a status code.
//
// THE UPLOADED FILES ARE NOT STORED. A capture is ~27 MB a side and belongs to the user's machine, not to a
// row in our database. It is also a route rather than a `functions/` handler because the input is multipart,
// which express.json() does not parse — the same reason cabinet.routes.js is one.
import { Router } from 'express';
import multer from 'multer';
import { requireAuth, blockWidget } from '../auth.js';
import { runCaptureCheck } from '../lib/audio/captureCheck.js';
import {
  INPUT_FILENAME, INPUT_MD5, INPUT_URL, MAX_CAPTURE_BYTES,
} from '../lib/audio/namCapture.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_CAPTURE_BYTES } });
const router = Router();

router.use(requireAuth, blockWidget);

/**
 * The constants the panel needs, so it does not keep its own copy of them.
 *
 * `inputMd5` is here on purpose: a capture fails most often because the input is not the file the trainer
 * recognises, and telling a user "download it from this link" without telling them how to know they got the
 * right one is how they end up checking a signal they cannot train on.
 */
router.get('/about', (req, res) => {
  res.json({ inputUrl: INPUT_URL, inputFilename: INPUT_FILENAME, inputMd5: INPUT_MD5, maxBytes: MAX_CAPTURE_BYTES });
});

router.post('/check', upload.fields([{ name: 'input', maxCount: 1 }, { name: 'recorded', maxCount: 1 }]), (req, res) => {
  const pick = (field) => {
    const f = req.files?.[field]?.[0];
    return f ? { filename: f.originalname, buffer: f.buffer } : null;
  };
  const { status, body } = runCaptureCheck({ input: pick('input'), recorded: pick('recorded') });
  res.status(status).json(body);
});

// A multer limit is reported as an error rather than as a 500: "that file is over 40 MB" is the user's file,
// and the panel should say so instead of showing a stack trace.
router.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (!err) return;
  const tooBig = err.code === 'LIMIT_FILE_SIZE';
  res.status(400).json({ error: tooBig ? `A capture file is larger than ${MAX_CAPTURE_BYTES / 1048576} MB.` : err.message });
});

export default router;
