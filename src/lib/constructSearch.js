// Finding your construct in the list.
//
// WHY THIS IS A MODULE (2026-09-28). Rob went looking for the construct to run the first live
// deploy on and could not find it: he searched "website test", the construct is called "Web page
// test", and the box matched NAMES ONLY — so the list answered "No constructs match your search."
// with no hint about what it had looked at. A search that silently narrows what it searches is how
// someone concludes their work is gone.
//
// So: one place decides what a query matches and what order the list is in, pure and import-free so
// scripts/verify-workspace-search.mjs can test the rule without a browser or a database. The search
// covers the NAME and the DESCRIPTION — a construct's description is where its intent lives ("Landing
// page with a contact inquiry form"), and it is the field a person is most likely to remember when
// they cannot remember the name.
//
// Deliberately NOT fuzzy: a substring match is predictable, and a fuzzy one would make "no matches"
// mean "no close matches", which is a different and less trustworthy sentence.

/** Does this construct match the query? Name OR description, case-insensitive. Empty query matches all. */
export function matchesConstruct(project, query) {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return true;
  const haystack = `${project?.name ?? ''} ${project?.description ?? ''}`.toLowerCase();
  return haystack.includes(q);
}

/** What the search looks at — said out loud, because a silent scope is the bug this fixes. */
export const SEARCH_SCOPE = 'names and descriptions';

/** The message when nothing matches: names the query AND what was searched. */
export function noMatchesMessage(query) {
  return `No constructs match “${String(query ?? '').trim()}”. Search looks in ${SEARCH_SCOPE}.`;
}

/**
 * The list the workspace renders: frontend constructs only (a self-dev workspace is not a
 * construct you build in), matching the query, in the chosen order.
 *
 * `sortBy` is 'name' or anything else for most-recently-touched first. Ties fall back to
 * created_date so the order is stable rather than dependent on array order.
 */
export function visibleConstructs(projects, { query = '', sortBy = 'recent' } = {}) {
  const when = (p) => new Date(p?.updated_date || p?.created_date || 0).getTime();
  return (Array.isArray(projects) ? projects : [])
    .filter((p) => !p?.project_type || p.project_type === 'frontend')
    .filter((p) => matchesConstruct(p, query))
    .sort((a, b) => (sortBy === 'name'
      ? String(a?.name ?? '').localeCompare(String(b?.name ?? ''))
      : when(b) - when(a)));
}
