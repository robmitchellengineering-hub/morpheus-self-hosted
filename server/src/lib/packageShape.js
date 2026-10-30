// packageShape.js — what our package registry accepts and publishes, with no database and no crypto near it.
//
// Rob, 2026-11-02: "if its not there anywhere build it". There is no npm service on this deployment, so this is ours: publish a
// tarball, list what exists, fetch one by name and version. It is deliberately tiny — a package registry's only jobs are naming,
// versioning, integrity and retrieval — and the validation lives here so the guard that proves it needs no install.
import { createHash } from 'node:crypto';

export const NAME = /^[a-z0-9][a-z0-9._-]{0,213}$/;
export const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
export const MAX_BYTES = 8 * 1024 * 1024;

const isSha = (s) => typeof s === 'string' && /^[0-9a-f]{64}$/i.test(s);

/** @returns {{ok: boolean, why?: string, pkg?: object}} */
export function normalizePublish(body) {
  const name = String(body?.name ?? '').trim();
  const version = String(body?.version ?? '').trim();
  if (!NAME.test(name)) return { ok: false, why: 'name must be lowercase, may contain . _ - and start with a letter or digit' };
  // TYPED ALIASES: `valiant-verification-sdk` and `@valiant/cli` both resolve to one directory-safe key.
  if (!VERSION.test(version)) return { ok: false, why: 'version must be semver, e.g. 0.3.0' };
  const b64 = typeof body?.tarball === 'string' ? body.tarball : '';
  if (!b64) return { ok: false, why: 'no tarball supplied (base64 in the "tarball" field)' };
  let bytes;
  try { bytes = Buffer.from(b64, 'base64'); } catch { return { ok: false, why: 'tarball is not valid base64' }; }
  if (!bytes.length) return { ok: false, why: 'tarball is empty' };
  if (bytes.length > MAX_BYTES) return { ok: false, why: `tarball is ${bytes.length} bytes; the limit is ${MAX_BYTES}` };
  // GZIP MAGIC: a tarball is gzip-compressed, and refusing anything else stops this endpoint being general file storage.
  if (!(bytes[0] === 0x1f && bytes[1] === 0x8b)) return { ok: false, why: 'tarball is not gzip-compressed — that is not a package' };
  const sha = String(body?.sha256 ?? '').trim().toLowerCase();
  if (sha && !isSha(sha)) return { ok: false, why: 'sha256 must be 64 hex characters' };
  return {
    ok: true,
    pkg: {
      name, version, bytes,
      sha256: sha || createHash('sha256').update(bytes).digest('hex'),
      size: bytes.length,
      notes: body?.notes ? String(body.notes).slice(0, 500) : null,
    },
  };
}

/** The public index entry — never the bytes. */
export function indexEntry(row) {
  return { name: row.name, version: row.version, sha256: row.sha256, size: row.size, notes: row.notes ?? null, date: row.published_at instanceof Date ? row.published_at.toISOString().slice(0, 10) : String(row.published_at ?? '').slice(0, 10) };
}

/** Group rows into { latest, packages: { name: [versions…] } }, newest first. */
export function buildIndex(rows) {
  const byName = new Map();
  for (const r of rows) {
    const e = indexEntry(r);
    if (!byName.has(e.name)) byName.set(e.name, []);
    byName.get(e.name).push(e);
  }
  const packages = {};
  const latest = {};
  for (const [name, list] of byName) {
    const sorted = list.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.version < b.version ? 1 : -1));
    packages[name] = sorted;
    latest[name] = sorted[0].version;
  }
  return { updated: new Date().toISOString().slice(0, 10), latest, packages };
}
