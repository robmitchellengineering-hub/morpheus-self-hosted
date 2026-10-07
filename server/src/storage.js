// Object storage abstraction. Mirrors Base44's `integrations.Core.UploadFile`
// + the offload-large-string pattern from base44/shared/projectUtils.ts.
//
// STORAGE_DRIVER=local  → writes under server/data/storage, served via
//   GET /uploads/:key by index.js. Fine for a single-instance self-host.
// STORAGE_DRIVER=s3     → any S3-compatible bucket (AWS S3, Cloudflare R2,
//   Backblaze B2, MinIO). Required once you run more than one API instance
//   (see SCALING.md) so every instance sees the same files.
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, unlink } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCAL_ROOT = path.join(__dirname, '..', 'data', 'storage');

const driver = process.env.STORAGE_DRIVER || 'local';

let s3Client = null;
async function getS3() {
  if (s3Client) return s3Client;
  const { S3Client } = await import('@aws-sdk/client-s3');
  s3Client = new S3Client({
    region: process.env.S3_REGION || 'auto',
    endpoint: process.env.S3_ENDPOINT || undefined,
    credentials: process.env.S3_ACCESS_KEY_ID
      ? { accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY }
      : undefined,
    forcePathStyle: !!process.env.S3_ENDPOINT, // needed for MinIO/R2-style endpoints
  });
  return s3Client;
}

function keyFor(filename) {
  const safe = String(filename || 'file').replace(/[^a-zA-Z0-9._-]/g, '_');
  return `${Date.now()}-${randomUUID()}-${safe}`;
}

// Uploads a Buffer/string. Returns { file_url, key }.
export async function uploadFile({ buffer, filename, contentType = 'application/octet-stream' }) {
  const key = keyFor(filename);
  const data = typeof buffer === 'string' ? Buffer.from(buffer, 'utf8') : buffer;

  if (driver === 's3') {
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
    const client = await getS3();
    await client.send(new PutObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: key,
      Body: data,
      ContentType: contentType,
    }));
    const base = process.env.S3_PUBLIC_BASE_URL || `${process.env.S3_ENDPOINT}/${process.env.S3_BUCKET}`;
    return { file_url: `${base.replace(/\/+$/, '')}/${key}`, key };
  }

  await mkdir(LOCAL_ROOT, { recursive: true });
  await writeFile(path.join(LOCAL_ROOT, key), data);
  // Relative by default (fine when frontend+backend share an origin via
  // nginx, as in docker-compose.yml). When the frontend is hosted
  // separately (e.g. a standalone static host pointed at this backend),
  // set BACKEND_PUBLIC_URL so these links resolve against this backend
  // instead of the frontend's own origin.
  const base = process.env.BACKEND_PUBLIC_URL ? process.env.BACKEND_PUBLIC_URL.replace(/\/+$/, '') : '';
  return { file_url: `${base}/uploads/${key}`, key };
}

// Streams a Readable straight to storage without ever holding the whole
// file in memory. uploadFile() above stays buffer-only for its existing
// callers (avatars, offloaded text fields, generated docs) — those are all
// small and buffering them is harmless. This exists specifically for
// saveCompiledArtifacts.js, which downloads-then-reuploads compiled
// binaries that can be 100-200MB+ (a real PyQt6/pandas exe) — buffering
// both the download and the upload was crashing the backend process
// outright (repeated OOM-kill "Process terminated" restarts observed in
// production, with no application log line since the kill leaves no time
// to log anything).
export async function uploadFileStream({ stream, filename, contentType = 'application/octet-stream' }) {
  const key = keyFor(filename);

  if (driver === 's3') {
    const { Upload } = await import('@aws-sdk/lib-storage');
    const client = await getS3();
    const upload = new Upload({
      client,
      params: {
        Bucket: process.env.S3_BUCKET,
        Key: key,
        Body: stream,
        ContentType: contentType,
      },
    });
    await upload.done();
    const base = process.env.S3_PUBLIC_BASE_URL || `${process.env.S3_ENDPOINT}/${process.env.S3_BUCKET}`;
    return { file_url: `${base.replace(/\/+$/, '')}/${key}`, key };
  }

  await mkdir(LOCAL_ROOT, { recursive: true });
  const destPath = path.join(LOCAL_ROOT, key);
  try {
    await pipeline(stream, createWriteStream(destPath));
  } catch (err) {
    await unlink(destPath).catch(() => {}); // best-effort cleanup of a partial file
    throw err;
  }
  const base = process.env.BACKEND_PUBLIC_URL ? process.env.BACKEND_PUBLIC_URL.replace(/\/+$/, '') : '';
  return { file_url: `${base}/uploads/${key}`, key };
}

export async function downloadFile(fileUrl) {
  if (!fileUrl) return null;
  if (driver === 's3' && !fileUrl.startsWith('/uploads/')) {
    const res = await fetch(fileUrl);
    if (!res.ok) throw new Error(`Failed to fetch stored file: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
  const key = fileUrl.replace(/^\/uploads\//, '');
  return readFile(path.join(LOCAL_ROOT, key));
}

/**
 * Bytes from this server's OWN storage, with a timeout — the fetcher for a URL `isOwnStorageUrl` admitted.
 *
 * ⚠️ WHY BOTH BRANCHES EXIST, AND WHY IT IS SHARED. A relative `/uploads/…` is the LOCAL driver writing under
 * this server's own data directory, and `fetch('/uploads/x')` cannot parse a relative URL at all — so a
 * local install that hydrated a cabinet with the compile's own `fetch` got "Failed to parse URL" as a
 * WARNING and baked in nothing. An absolute URL is either the S3/R2 bucket or this server's public origin,
 * and both are reachable over HTTP. `downloadFile` alone is not enough either: with the local driver it
 * resolves an absolute URL as a filesystem key.
 *
 * It lives here rather than beside a caller because two callers already need it — `compileProject` and the
 * rig/board views, which decode a cabinet to say whether it will convolve — and a second copy of "how to get
 * a stored file back" is how the app and the build come to disagree about the same cabinet.
 */
export async function fetchStoredBytes(fileUrl, { timeoutMs = 20_000 } = {}) {
  const url = String(fileUrl || '');
  if (!url) return null;
  if (url.startsWith('/uploads/')) return downloadFile(url);
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

export { LOCAL_ROOT };

// ── Large-string offload pattern (ported from base44/shared/projectUtils.ts) ──
// Entity text columns are cheap up to a point; beyond FIELD_SIZE_LIMIT the
// full value is pushed to storage and only a preview + file_url are kept
// inline, so large snapshots/rebuild docs/compiled logs never bloat the DB.
const FIELD_SIZE_LIMIT = 8000;
const PREVIEW_LENGTH = 2000;

export async function offloadLargeString(value, filename, contentType = 'application/json') {
  if (!value || value.length <= FIELD_SIZE_LIMIT) return { value };
  const { file_url } = await uploadFile({ buffer: value, filename, contentType });
  return { value: value.substring(0, PREVIEW_LENGTH), file_url };
}

export async function readOffloadedString(record) {
  if (record?.file_url) {
    const buf = await downloadFile(record.file_url);
    return buf ? buf.toString('utf8') : '';
  }
  return record?.value ?? record?.content ?? '';
}
