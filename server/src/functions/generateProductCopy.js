// Draft product copy for the SHOP tab — the seller gives a name (and
// optionally a photo, category, brand, rough notes) and Morpheus writes a
// short blurb + a full description they can edit before publishing. Same
// idea as the product-copy helper in Rob's Valiant command deck; the
// WEBSITE panel replaces that.
import { prisma } from '../db.js';
import { invokeAI } from '../ai.js';

export default async function handler({ user, body }) {
  const { projectId, name, category, brand, notes, imageUrl } = body || {};
  if (!projectId) throw Object.assign(new Error('projectId required'), { status: 400 });
  if (!name || !String(name).trim()) throw Object.assign(new Error('Give the product a name first.'), { status: 400 });

  const project = await prisma.project.findFirst({
    where: { id: projectId, created_by_id: user.id },
    select: { name: true, description: true },
  });
  if (!project) throw Object.assign(new Error('Project not found'), { status: 404 });

  const lines = [
    `Store: ${project.name}${project.description ? ` — ${project.description}` : ''}`,
    `Product name: ${String(name).trim()}`,
    category ? `Category: ${category}` : null,
    brand ? `Brand: ${brand}` : null,
    notes && String(notes).trim() ? `Seller's notes (rough — polish these, don't just repeat them): ${String(notes).trim()}` : null,
    imageUrl ? `A photo of the item is attached — use what you can actually see, but do not guess at condition, year, or specs that aren't given.` : null,
  ].filter(Boolean);

  const prompt = `You write product copy for this store's online shop. Keep it honest and specific — no hype clichés ("perfect for any musician!"), no invented specifications, model years, or condition claims. If a detail isn't given or clearly visible, leave it out.

${lines.join('\n')}

Write two things:
- short_description: ONE sentence, ~12-20 words, the blurb shown next to the price.
- description: 2-4 short paragraphs of plain text (no markdown, no headings, no bullet lists). What it is, what stands out, who it suits. Australian English.

Return JSON: { "short_description": "...", "description": "..." }`;

  const { result } = await invokeAI({
    userId: user.id,
    prompt,
    schema: {
      type: 'object',
      properties: {
        short_description: { type: 'string', description: 'One sentence, ~12-20 words.' },
        description: { type: 'string', description: '2-4 short plain-text paragraphs.' },
      },
      required: ['short_description', 'description'],
    },
    fileUrls: imageUrl ? [imageUrl] : undefined,
    role: 'diagnosis',
    maxTokens: 1200,
  });

  return {
    short_description: (result.short_description || '').trim(),
    description: (result.description || '').trim(),
  };
}
