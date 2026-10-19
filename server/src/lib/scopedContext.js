// Which files a scoped-context turn actually shows the model, and in what order.
//
// WHY THIS IS ITS OWN MODULE
//
// The byte budget is spent in iteration order, so the order IS the rule: whatever
// comes first is what survives a large request. This used to live inline in
// chatWithMorpheus.js and walked the rows the DB returned — and `findMany` has no
// orderBy — so whether the model ever saw AGENTS.md depended on row order.
//
// That is not theoretical. Three consecutive self-dev changes failed CI on the ink
// ladder, a rule stated only in AGENTS.md, and the file it was stated in was not
// guaranteed to arrive. The fix — orientation first — is a guarantee only if it is
// tested, and it could not be tested while it was a closure inside a 1800-line
// handler that pulls in Prisma. So it moved here, where it is pure and a guard can
// assert the ordering directly.
//
// Pure by design: imports nothing, touches no DB, does no I/O.

/**
 * @param {{path: string, content: string}[]} files  every file in the project
 * @param {string[]} focusPaths         files this turn is about (research-selected)
 * @param {string[]} orientationPaths   files shown regardless (house rules, hazards, schema)
 * @param {number} maxBytes             budget for CONTENT across all shown files
 * @returns {{shown: string[], text: string}}
 */
export function buildScopedFilesContext(files, focusPaths, orientationPaths, maxBytes) {
  const list = Array.isArray(files) ? files : [];
  const focus = Array.isArray(focusPaths) ? focusPaths : [];
  const orientation = Array.isArray(orientationPaths) ? orientationPaths : [];

  const tree = list.map((f) => f.path).sort().join('\n');
  const byPath = new Map(list.map((f) => [f.path, f]));

  // Orientation first. These are the files that state the rules a change has to
  // obey — AGENTS.md's house conventions, KNOWN-HAZARDS.md, the schema, App.jsx.
  // They are small, they are never optional, and a house rule the model may or may
  // not be shown is not stated at all.
  const ordered = [...orientation, ...focus.filter((p) => !orientation.includes(p))];

  const shown = [];
  const sections = [];
  let used = 0;
  for (const p of ordered) {
    const f = byPath.get(p);
    // A path that is not in this project is simply absent — a missing orientation
    // entry must never throw, and must never consume budget.
    if (!f) continue;
    if (used > maxBytes) break;
    sections.push(`--- ${f.path} ---\n${f.content}`);
    shown.push(f.path);
    used += f.content.length;
  }

  const contentBlock = sections.join('\n\n') || '(no files selected yet)';
  return {
    shown,
    text: `FULL REPO FILE TREE (${list.length} files total — every path listed exists, but only the files below have their CONTENT shown):\n${tree}\n\nRELEVANT FILE CONTENTS:\n${contentBlock}`,
  };
}
