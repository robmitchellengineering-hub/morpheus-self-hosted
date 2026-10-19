// Media Library helpers (2026-09-09). A project's content assets — Morpheus
// stores only the url + caption, never the bytes (see schema.prisma's
// ProjectAsset). `source:'url'` = a public link the operator hosts
// themselves; `source:'repo'` = uploaded from device and committed straight
// into the project's own GitHub repo.
import { prisma } from '../db.js';

// project_assets ships ahead of its migration
// (server/prisma/add-project-assets-table.sql). Detect the missing table /
// column so the MEDIA panel degrades to "migration pending" instead of
// crashing — same pattern as lib/selfDevFeature.js.
export function isMissingAssetTable(err) {
  const m = err && typeof err.message === 'string' ? err.message : '';
  return err?.code === 'P2021'
    || err?.code === 'P2022' // column does not exist (projects.github_repo)
    || /relation\s+"?project_assets"?\s+does not exist/i.test(m)
    || /column\s+.*github_repo.*does not exist/i.test(m)
    || /Cannot read properties of undefined \(reading '(find|create|delete|update)/i.test(m);
}

const KINDS = new Set(['image', 'video', 'audio', 'pdf', 'font', 'other']);

export function kindFromType(contentType = '', filename = '') {
  const ct = String(contentType).toLowerCase();
  if (ct.startsWith('image/')) return 'image';
  if (ct.startsWith('video/')) return 'video';
  if (ct.startsWith('audio/')) return 'audio';
  if (ct === 'application/pdf') return 'pdf';
  if (/font|woff|ttf|otf/.test(ct)) return 'font';
  const ext = (filename.match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase();
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'ico'].includes(ext)) return 'image';
  if (['mp4', 'webm', 'mov', 'm4v'].includes(ext)) return 'video';
  if (['mp3', 'wav', 'ogg', 'm4a'].includes(ext)) return 'audio';
  if (ext === 'pdf') return 'pdf';
  if (['woff', 'woff2', 'ttf', 'otf'].includes(ext)) return 'font';
  return 'other';
}

export function normalizeKind(k) {
  return KINDS.has(k) ? k : 'other';
}

// "Spring Event Poster!" -> "spring-event-poster"
export function slugify(s) {
  return String(s || 'asset')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'asset';
}

export function extFromNameOrType(filename = '', contentType = '') {
  const fromName = (filename.match(/\.([a-z0-9]+)$/i) || [])[1];
  if (fromName) return fromName.toLowerCase();
  const map = {
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp',
    'image/svg+xml': 'svg', 'image/avif': 'avif', 'application/pdf': 'pdf',
    'video/mp4': 'mp4', 'video/webm': 'webm', 'audio/mpeg': 'mp3', 'audio/wav': 'wav',
    'font/woff2': 'woff2', 'font/woff': 'woff',
  };
  return map[String(contentType).toLowerCase()] || 'bin';
}

// The block handed to the planner + coder on a build turn so it writes real
// <img src>/<video>/CSS url() with the exact strings instead of inventing
// paths or reaching for a placeholder service.
export function mediaAssetsBlock(assets) {
  if (!assets || assets.length === 0) return '';
  const lines = assets.slice(0, 40).map((a) => {
    const dims = a.width && a.height ? ` (${a.kind}, ${a.width}×${a.height})` : ` (${a.kind})`;
    const alt = a.alt ? ` — alt: "${a.alt}"` : '';
    return `  - "${a.name}"  ${a.url}${dims}${alt}`;
  });
  return `
MEDIA ASSETS available in this project — use these EXACT urls in <img>/<video>/<audio>/<a>/CSS:
${lines.join('\n')}
Do NOT invent image paths and do NOT use placeholder-image services. If the operator asks for
an image that is not listed above, say it needs to be added in the MEDIA panel first.
`;
}

// Best-effort read for the pipeline context — never throws.
export async function getProjectAssets(projectId) {
  try {
    return await prisma.projectAsset.findMany({
      where: { project_id: projectId },
      orderBy: { created_date: 'desc' },
      take: 40,
    });
  } catch (err) {
    if (isMissingAssetTable(err)) return [];
    console.error('[projectAssets] read failed:', err.message);
    return [];
  }
}
