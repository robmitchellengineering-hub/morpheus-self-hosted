// A cabinet impulse response as a project FILE: uploading one, validating it, and getting its bytes back
// to the scaffolder.
//
// WHY A ROUTE AND A LIB RATHER THAN "just let the Media panel take .wav". The Media panel's upload commits a
// file into the project's GITHUB REPO (`source: 'repo'`, see lib/projectAssets.js) and keeps no bytes — and
// the scaffolder runs on THIS server, from `project_files` rows, before anything is pushed. So a .wav in the
// repo cannot reach the code that bakes it, and adding ".wav" to that accept list would have changed nothing.
// The other half is that a `.nam` model does not have this problem at all, because it is JSON TEXT and a text
// project file is enough — which is exactly why this looked like it should already work.
//
// THE TRUST BOUNDARY IS OURS, NOT THE USER'S. Hydration fetches a stored URL at compile time, so it fetches
// ONLY from this server's own storage prefixes — the shapes lib/storage.js itself produces. A row whose
// file_url points anywhere else is refused with a warning rather than fetched: a compile that will dial an
// address out of a database row is an SSRF primitive, and "it is only our own rows" stops being true the
// moment a row can be written by a user.

/** Where a cabinet lives. The same convention the model uses. */
export const CABINET_DIR = 'models';

/**
 * The largest impulse response this accepts, and it is generous on purpose: a stereo 96 kHz IR is large, and
 * MAX_CAB_TAPS truncates it at bake time anyway. This cap is about not storing a film.
 */
export const MAX_CABINET_BYTES = 16 * 1024 * 1024;

/** `models/cab.wav`, or anything else ending in `.wav`. */
export const isCabinetPath = (p) => typeof p === 'string' && /\.wav$/i.test(p);

/**
 * Check the BYTES, not the name.
 *
 * A `file_url` pointing at something that is not a WAV produces a plugin that either fails to build or, worse,
 * convolves rubbish — and the user's only clue would be that the cabinet "sounds wrong". So the first twelve
 * bytes are read here: `RIFF` at 0 and `WAVE` at 8 is what every WAV has, whatever the extension says.
 */
export function validateCabinet({ filename, bytes }) {
  if (!isCabinetPath(filename)) {
    return { ok: false, reason: `${filename || 'that file'} is not a .wav — a cabinet impulse response is a WAV file` };
  }
  const size = bytes?.length ?? 0;
  if (!size) return { ok: false, reason: 'the upload arrived empty' };
  if (size > MAX_CABINET_BYTES) {
    return { ok: false, reason: `that file is ${(size / 1024 / 1024).toFixed(1)} MB; the limit is ${MAX_CABINET_BYTES / 1024 / 1024} MB` };
  }
  if (size < 44) return { ok: false, reason: 'that file is too short to be a WAV (a WAV header alone is 44 bytes)' };
  const magic = bytes.subarray(0, 4).toString('ascii');
  const form = bytes.subarray(8, 12).toString('ascii');
  if (magic !== 'RIFF' || form !== 'WAVE') {
    return { ok: false, reason: `that file is not a WAV — it starts "${magic}" and says "${form}" where RIFF and WAVE belong` };
  }
  return { ok: true, size };
}

/**
 * The URL prefixes this server's own storage produces — the ONLY places hydration will fetch from.
 *
 * Derived from the same environment lib/storage.js reads, so the two cannot disagree about where storage is:
 * an S3 bucket's public base, or this backend's own `/uploads/` path.
 */
export function storagePrefixes(env = process.env) {
  const out = [];
  const s3 = env.S3_PUBLIC_BASE_URL || (env.S3_ENDPOINT && env.S3_BUCKET ? `${env.S3_ENDPOINT}/${env.S3_BUCKET}` : '');
  if (s3) out.push(s3.replace(/\/+$/, ''));
  // A RELATIVE prefix is legitimate and common (frontend and backend behind one origin), so it is matched as
  // "starts with /uploads/" rather than being resolved against a host.
  const backend = env.BACKEND_PUBLIC_URL ? env.BACKEND_PUBLIC_URL.replace(/\/+$/, '') : '';
  out.push(`${backend}/uploads`);
  return out;
}

/** Whether a stored URL is one this server wrote. */
export function isOwnStorageUrl(url, env = process.env) {
  const u = String(url || '');
  if (!u) return false;
  return storagePrefixes(env).some((prefix) => u.startsWith(`${prefix}/`) || (prefix.startsWith('http') && u.startsWith(prefix)));
}

/**
 * Turn stored cabinets into content the scaffolder can read.
 *
 * THE SCAFFOLDER IS PURE AND SYNCHRONOUS, and that is worth keeping: it is called from guards, from the
 * runner scripts and from the app, and a scaffolder that does I/O is a scaffolder nobody can test. So the
 * bytes are fetched HERE, once, before it runs — and a file whose bytes cannot be fetched is left alone with
 * a warning, which makes the build a gain plugin rather than a failed compile.
 */
export async function hydrateCabinets(files, { fetchBytes, env = process.env } = {}) {
  const warnings = [];
  if (!Array.isArray(files)) return { files, warnings };
  const out = [];
  for (const file of files) {
    if (!file || !isCabinetPath(file.path) || !file.file_url) {
      out.push(file);
      continue;
    }
    // Already hydrated, or a text row that happens to end in .wav — either way there is nothing to fetch.
    if (file.encoding === 'base64' && file.content) { out.push(file); continue; }
    if (!isOwnStorageUrl(file.file_url, env)) {
      warnings.push(`${file.path} points at ${file.file_url}, which is not this server's storage — refusing to fetch it. The cabinet is NOT in the build.`);
      out.push(file);
      continue;
    }
    try {
      const bytes = await fetchBytes(file.file_url);
      const check = validateCabinet({ filename: file.path, bytes });
      if (!check.ok) {
        warnings.push(`${file.path}: ${check.reason}. The cabinet is NOT in the build.`);
        out.push(file);
        continue;
      }
      out.push({ ...file, content: Buffer.from(bytes).toString('base64'), encoding: 'base64', file_url: undefined });
    } catch (err) {
      warnings.push(`${file.path} could not be downloaded (${String(err.message).split('\n')[0].slice(0, 120)}) — the cabinet is NOT in the build.`);
      out.push(file);
    }
  }
  return { files: out, warnings };
}
