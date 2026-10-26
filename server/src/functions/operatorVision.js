// Operator-scope vision — let a non-browser client ask this deployment "what is in this image".
//
// WHY THIS EXISTS. The deployment already has a working Gemini key (the FALLBACK_LLM_* connection),
// and `analyzeProductPhoto` already proves the vision path works end to end. But that path is welded
// to a product-photo prompt and a WordPress taxonomy, so nothing outside the browser could use it:
// a design review, a screenshot diff or a chart read had no route to the one credential that can see.
// The result was a session trying to mint a second Gemini key for itself — inventing a parallel
// integration for a capability this deployment already pays for.
//
// This is that route, and only that: the caller supplies the prompt, the deployment supplies the key.
//
// WHAT IT DELIBERATELY CANNOT DO. It cannot pick a different model, reach another project, or skip
// the key resolution that decides whose credential pays: `resolveSearchKey` is called with the
// caller's own user id, so a per-account Gemini connection wins and the platform key is only the
// fallback it already is everywhere else. It returns text/JSON and never a credential.
//
// Gemini is asked for JSON (that is what geminiVisionJson sets), so the prompt must describe the
// JSON shape it wants back. The caller gets exactly the object Gemini returned, unreshaped — this
// function has no opinion about products, layouts or charts.
import { resolveSearchKey, geminiVisionJson } from '../lib/webResearch.js';

/** Bounds chosen against the same request-size reality analyzeProductPhoto lives with. */
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

async function fetchImageAsBase64(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) {
    throw Object.assign(new Error(`Could not read the image at ${new URL(url).hostname} (HTTP ${res.status}).`), { status: 400 });
  }
  const mimeType = res.headers.get('content-type') || 'image/png';
  if (!/^image\//i.test(mimeType)) {
    throw Object.assign(new Error(`That URL is not an image (content-type ${mimeType}).`), { status: 400 });
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_IMAGE_BYTES) {
    throw Object.assign(new Error('Image is too large — keep each one under 8 MB.'), { status: 400 });
  }
  return { data: buf.toString('base64'), mimeType };
}

export default async function handler({ user, body }) {
  const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
  if (!prompt) {
    throw Object.assign(new Error('prompt required — say what to look for, and name the JSON keys you want back'), { status: 400 });
  }

  const imageUrls = (Array.isArray(body?.imageUrls) ? body.imageUrls : [])
    .filter((u) => typeof u === 'string' && /^https:\/\//i.test(u))
    .slice(0, MAX_IMAGES);
  if (!imageUrls.length) {
    throw Object.assign(new Error('at least one https imageUrls entry is required'), { status: 400 });
  }

  // Whose key pays: the caller's own Gemini connection first, then the deployment's — the same
  // resolution every other AI path in this app uses, so this route adds no second way to spend.
  const searchKey = await resolveSearchKey(user?.id);
  if (!searchKey) {
    throw Object.assign(
      new Error('No Gemini key is available to this deployment or account, so nothing here can see images.'),
      { status: 503 },
    );
  }

  const images = await Promise.all(imageUrls.map(fetchImageAsBase64));
  const answer = await geminiVisionJson(searchKey, prompt, images);

  return {
    answer,
    model: searchKey.model,
    // 'platform' means the deployment's own credential answered; 'user' means the account's.
    keySource: searchKey.source,
    images: images.length,
  };
}
