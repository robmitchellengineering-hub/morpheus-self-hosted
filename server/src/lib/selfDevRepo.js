// Shared constants + the file-exclusion rule for Morpheus's self-dev feature
// (Morpheus editing its own repo). Imported by both importSelfDevRepo.js
// (which files to PULL into the workspace) and pushSelfDevToGithub.js (which
// remote files the workspace is a mirror of, so a "missing locally" file is
// only a real deletion if it's one self-dev actually mirrors).
//
// Keeping shouldExclude() in one place is load-bearing: importSelfDevRepo
// skips these paths, so they never exist as local ProjectFile rows. If the
// push side computed deletions off the *unfiltered* remote tree, every
// excluded path (all of base44/, the lockfiles, every binary) would look
// like a file the operator deleted and get removed from the real repo.

import crypto from 'node:crypto';

export const SELF_DEV_OWNER = 'robmitchellengineering-hub';
export const SELF_DEV_REPO = 'morpheus-self-hosted';
export const SELF_DEV_BRANCH = 'main';
export const SELF_DEV_REPO_FULL_NAME = `${SELF_DEV_OWNER}/${SELF_DEV_REPO}`;

// git's own blob object id: sha1("blob <bytelen>\0" + bytes). Matches the
// `sha` on a GitHub tree entry, so importSelfDevRepo can skip re-fetching a
// blob whose content it already has, and pushSelfDevToGithub can tell an
// unchanged file from a modified one without fetching the remote blob.
export function gitBlobSha(content) {
  const buf = Buffer.from(content ?? '', 'utf8');
  return crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
}

const BINARY_EXTS = [
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.svg', '.woff', '.woff2', '.ttf',
  '.eot', '.mp3', '.mp4', '.zip', '.jar', '.class', '.so', '.dll', '.exe',
  '.bin', '.dat', '.pdf',
];

// True for paths self-dev deliberately does NOT mirror into the workspace:
// build output, dependencies, base44/ (reference-only, not used at runtime —
// see README.md), machine-generated lock files, and binaries the chat/editor
// can't meaningfully show or the AI author as real bytes.
export function shouldExclude(path) {
  const lower = String(path).toLowerCase();
  if (lower.includes('node_modules/') || lower.includes('.git/')) return true;
  if (lower.includes('/dist/') || lower.includes('/.next/') || lower.includes('/coverage/')) return true;
  if (/^base44\//.test(lower)) return true;
  if (/(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/.test(lower)) return true;
  return BINARY_EXTS.some((ext) => lower.endsWith(ext));
}

// True if every line of `oldText` still appears, unchanged, in the same
// relative order in `newText` (a line-subsequence check) — i.e. newText is
// oldText with only insertions, never a removal or edit. Used to guard a
// shared, append-only file (deckWidgets.js) against a scoped build basing
// its change on a stale local copy and silently dropping someone else's
// entry — see pushSelfDevToGithub.js's deckwidgets-not-additive check.
export function isAppendOnlyDiff(oldText, newText) {
  const oldLines = String(oldText ?? '').split('\n');
  const newLines = String(newText ?? '').split('\n');
  let i = 0;
  for (const line of newLines) {
    if (i < oldLines.length && line === oldLines[i]) i++;
  }
  return i === oldLines.length;
}
