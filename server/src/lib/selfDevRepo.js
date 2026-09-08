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

export const SELF_DEV_OWNER = 'robmitchellengineering-hub';
export const SELF_DEV_REPO = 'morpheus-self-hosted';
export const SELF_DEV_BRANCH = 'main';
export const SELF_DEV_REPO_FULL_NAME = `${SELF_DEV_OWNER}/${SELF_DEV_REPO}`;

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
