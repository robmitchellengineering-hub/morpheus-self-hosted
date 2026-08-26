// Operator-facing "is Morpheus itself current" report. See
// server/src/freshness.js for what this checks and — importantly — what it
// deliberately does NOT do (auto-edit code or auto-upgrade dependencies).
import express from 'express';
import { requireAuth, requireAdmin } from '../auth.js';
import { runFreshnessCheck, runFreshnessCheckAndNotify } from '../freshness.js';

const router = express.Router();

router.use(requireAuth, requireAdmin);

// Cheap read: last computed report, refreshing in the background if stale.
// Kept simple (module-level, resets on restart) since this is advisory
// data, not something anything else depends on being perfectly fresh.
let lastReport = null;
let lastCheckedAt = 0;
const REPORT_TTL_MS = 60 * 60 * 1000; // 1h

router.get('/freshness', async (_req, res) => {
  try {
    if (!lastReport || Date.now() - lastCheckedAt > REPORT_TTL_MS) {
      lastReport = await runFreshnessCheck();
      lastCheckedAt = Date.now();
    }
    res.json(lastReport);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Force a fresh run (bypasses the 1h cache above) — e.g. a "Check now"
// button in the admin UI. Also triggers the same notify-on-change email
// logic as the scheduled job, so this doubles as "test my SMTP config".
router.post('/freshness/refresh', async (req, res) => {
  try {
    const wantsEmail = req.body?.notify && process.env.SMTP_HOST;
    const notifyEmail = wantsEmail ? req.user.email : null;
    const { report, summary, changedSinceLastRun } = await runFreshnessCheckAndNotify(notifyEmail);
    lastReport = report;
    lastCheckedAt = Date.now();
    res.json({ ...report, summary, changedSinceLastRun });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
