// Photo → draft product. The seller snaps the item; Gemini looks at it and
// fills every field (name, category, brand, price, stock, short + full
// description). Everything comes back editable — same idea as the Valiant
// command deck's auto-fill, which the WEBSITE panel replaces.
//
// Vision goes to the connected Gemini key (resolveSearchKey — the caller's
// own AI connection if it points at Gemini, else the deployment's Gemini
// fallback). Falls back to invokeAI (whatever chat model is configured) if
// no Gemini key is around.
import { prisma } from '../db.js';
import { invokeAI } from '../ai.js';
import { resolveSearchKey, geminiVisionJson } from '../lib/webResearch.js';
import { getWpConnection, wpStore } from '../lib/wpPlugin.js';

const FIELDS = `{
  "name": "concise product title, no marketing fluff",
  "category": "EXACTLY one of the category names given, or \\"\\" if unsure",
  "brand": "EXACTLY one of the brand names given, or \\"\\" if not visible/known",
  "suggested_price": "a number only (no currency symbol), your best estimate of a fair retail price, or \\"\\" if you can't tell",
  "stock": "1 unless there is clear evidence of multiple identical units",
  "short_description": "ONE sentence, ~12-20 words, shown next to the price",
  "description": "2-4 short plain-text paragraphs (no markdown). What it is, what stands out, who it suits.",
  "notes_for_seller": "anything you couldn't determine from the photo and the seller should check/fill (condition, year, exact model, included accessories). One or two lines."
}`;

async function loadContext(projectId, userId) {
  const conn = await getWpConnection(projectId, userId);
  if (!conn) return { currency: 'AUD', currency_symbol: '$', categories: [], brands: [] };
  try {
    const r = await wpStore(conn, 'context');
    if (r.ok && r.data?.ok) return r.data;
  } catch { /* fall through */ }
  return { currency: 'AUD', currency_symbol: '$', categories: [], brands: [] };
}

async function fetchImageBase64(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw Object.assign(new Error(`Could not read the photo (HTTP ${res.status}).`), { status: 400 });
  const mimeType = res.headers.get('content-type') || 'image/jpeg';
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > 8 * 1024 * 1024) throw Object.assign(new Error('Photo is too large — keep it under 8 MB.'), { status: 400 });
  return { data: buf.toString('base64'), mimeType };
}

export default async function handler({ user, body }) {
  const { projectId, imageUrl, hint } = body || {};
  if (!projectId) throw Object.assign(new Error('projectId required'), { status: 400 });
  if (!imageUrl) throw Object.assign(new Error('A photo is required — take or choose one first.'), { status: 400 });

  const project = await prisma.project.findFirst({
    where: { id: projectId, created_by_id: user.id },
    select: { name: true, description: true },
  });
  if (!project) throw Object.assign(new Error('Project not found'), { status: 404 });

  const ctx = await loadContext(projectId, user.id);
  const catNames = (ctx.categories || []).map((c) => c.name);
  const brandNames = (ctx.brands || []).map((b) => b.name);

  const prompt = `You are cataloguing an item for this store's online shop from a photo. Be accurate and conservative — describe only what you can actually see or reliably identify. Never invent a model year, condition, serial, or spec. Australian English.

Store: ${project.name}${project.description ? ` — ${project.description}` : ''}
Currency: ${ctx.currency || 'AUD'}
Available categories (pick one, exact spelling): ${catNames.length ? catNames.join(' | ') : '(none — leave category "")'}
Available brands (pick one if it applies, exact spelling): ${brandNames.length ? brandNames.join(' | ') : '(none — leave brand "")'}
${hint && String(hint).trim() ? `Seller's note: ${String(hint).trim()}` : ''}

Return ONLY this JSON object, no other text:
${FIELDS}`;

  let raw;
  const searchKey = await resolveSearchKey(user.id);
  if (searchKey?.key) {
    const image = await fetchImageBase64(imageUrl);
    raw = await geminiVisionJson(searchKey, prompt, image);
  } else {
    // No Gemini key — use whatever chat model is configured (invokeAI sends
    // the image as a vision part; quality depends on that model).
    const { result } = await invokeAI({
      userId: user.id,
      prompt,
      schema: {
        type: 'object',
        properties: {
          name: { type: 'string' }, category: { type: 'string' }, brand: { type: 'string' },
          suggested_price: { type: 'string' }, stock: { type: 'string' },
          short_description: { type: 'string' }, description: { type: 'string' },
          notes_for_seller: { type: 'string' },
        },
        required: ['name', 'short_description', 'description'],
      },
      fileUrls: [imageUrl],
      role: 'diagnosis',
      maxTokens: 1400,
    });
    raw = result;
  }

  // Match category / brand back to the real taxonomy (case-insensitive), so
  // the dropdowns land on a valid option.
  const match = (val, names) => {
    const v = String(val || '').trim().toLowerCase();
    return names.find((n) => n.toLowerCase() === v) || '';
  };
  const priceNum = String(raw.suggested_price ?? '').replace(/[^\d.]/g, '');

  return {
    name: (raw.name || '').trim(),
    category: match(raw.category, catNames),
    brand: match(raw.brand, brandNames),
    suggested_price: priceNum || '',
    stock: /^\d+$/.test(String(raw.stock || '').trim()) ? String(raw.stock).trim() : '',
    short_description: (raw.short_description || '').trim(),
    description: (raw.description || '').trim(),
    notes_for_seller: (raw.notes_for_seller || '').trim(),
    model: searchKey?.key ? `gemini:${searchKey.model}` : 'chat-model',
  };
}
