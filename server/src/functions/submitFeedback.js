// New — not a base44 port. Backs the landing page's public "SUGGEST AN
// IMPROVEMENT" box (base44's live version has this; the self-hosted rewrite
// didn't, since prior audits only ever covered the logged-in /workspace app
// and missed the pre-login landing page entirely). PUBLIC function — no
// account needed to submit, same as base44's FEATURE/BUG feedback widget.
//
// Feeds base44's admin-only "Morpheus Updates Plan" AI synthesis tool,
// which reads all Feedback rows to build a prioritized plan. That synthesis
// tool itself isn't ported yet — this function + table is the prerequisite
// for it, so feedback starts accumulating now instead of after that's built.
import { prisma } from '../db.js';

const VALID_TYPES = new Set(['feature', 'bug']);
const MAX_MESSAGE_LENGTH = 4000;

export default async function handler({ body }) {
  const { type, message, email } = body;

  const normalizedType = VALID_TYPES.has(type) ? type : 'feature';
  const trimmedMessage = String(message || '').trim();

  if (!trimmedMessage) {
    throw Object.assign(new Error('message is required'), { status: 400 });
  }
  if (trimmedMessage.length > MAX_MESSAGE_LENGTH) {
    throw Object.assign(new Error(`message must be ${MAX_MESSAGE_LENGTH} characters or fewer`), { status: 400 });
  }

  const feedback = await prisma.feedback.create({
    data: {
      type: normalizedType,
      message: trimmedMessage,
      email: email ? String(email).trim().slice(0, 320) : null,
    },
  });

  return { id: feedback.id, ok: true };
}
