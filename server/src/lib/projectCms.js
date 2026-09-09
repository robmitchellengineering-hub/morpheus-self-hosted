// Light CMS (2026-09-09) — editable site content without a rebuild.
//
// The convention: everything on a site that the operator might reasonably
// want to change (headlines, body copy, lists of services / team /
// testimonials / FAQ / menu items, contact details, hours) lives in JSON
// files under content/ in their repo. The site reads them at build time.
// The CONTENT panel reads those files straight from the connected repo,
// lets the operator edit the values, and commits the change back — the
// host redeploys on the push. ZERO CUSTODY: the content lives only in the
// operator's repo; Morpheus reads and writes it through the GitHub API and
// stores none of it.

export const CONTENT_DIR = 'content/';

// A content path is safe to write iff it's a .json file directly under
// content/ or one level deeper, no traversal.
export function isContentPath(p) {
  if (typeof p !== 'string') return false;
  if (p.includes('..') || p.startsWith('/') || p.includes('\\')) return false;
  if (!p.startsWith(CONTENT_DIR)) return false;
  const rest = p.slice(CONTENT_DIR.length);
  return /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)?\.json$/.test(rest);
}

export function contentName(p) {
  return p.replace(CONTENT_DIR, '').replace(/\.json$/, '').replace(/[-_/]+/g, ' ').trim();
}

// Handed to the planner + coder on every web build so new/changed content
// is externalised where the operator can edit it later.
export function cmsPromptBlock() {
  return `
EDITABLE CONTENT — put copy the operator will want to change without a rebuild into JSON files under content/:
Headlines, paragraphs, hero/section text, and every repeatable list (services, team, testimonials, FAQ, pricing tiers, menu/nav items, gallery captions, contact details, opening hours) belong in content/*.json — one file per page or section (e.g. content/home.json, content/services.json, content/faq.json), keyed with short human-readable names. Import them at build time (or fetch them at runtime for a static host). Keep the keys and shape stable across builds so edits survive. Do NOT put secrets, API config, routing, or layout structure in there — only user-facing content. Reference Media Library assets by their exact url.
`;
}
