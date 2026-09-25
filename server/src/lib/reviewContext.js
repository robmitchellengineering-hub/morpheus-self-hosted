// What the REVIEWER is shown — deliberately not what the Coder is shown.
//
// WHY THIS IS ITS OWN MODULE
//
// Until now the reviewer was handed the Coder's own context block verbatim
// (`let reviewContext = contextBlock` in chatWithMorpheus.js). Measured over 30
// days of production (`usage_events`), the reviewer is 1,254 calls averaging
// **26,138 input tokens** each — 30.6% of all AI spend, the single largest line
// item in the product, all of it deepseek-v4-pro. Almost none of that is the
// change under review: `REVIEW_CHUNK_SIZE` caps the files under review at 3,
// while the shared block carries the whole repo tree (984 paths in self-dev,
// ~8.7k tokens) plus every orientation file — `server/prisma/schema.prisma`
// alone is ~15.1k tokens, `README.md` ~2.8k, `src/App.jsx` ~3.1k.
//
// The Coder needs breadth: it has to decide what to write and reuse. The
// reviewer does not — it has the operations in front of it and four questions:
// does this obey the house rules, does this repeat a known hazard, does this
// break a caller (added by the caller-impact block at the call site), and does
// the file it imports actually exist. So this emits exactly what answers those:
//
//   1. KNOWN-HAZARDS.md and AGENTS.md — the reviewer's own prompt tells it to
//      check against both, so they are never optional.
//   2. A BOUNDED view of the tree. `buildScopedFilesContext`'s tree is not
//      counted against its byte budget at all (it charges `f.content.length`
//      only), so the path list is unbounded by construction. Small projects get
//      the full tree unchanged; past `maxTreeBytes` it degrades to a directory
//      index plus the paths in the directories the change actually touches,
//      which is the part that answers "does this import resolve".
//   3. `server/prisma/schema.prisma` ONLY when the change touches the schema.
//      It is the largest orientation file and it is dead weight in a review of,
//      say, a React component.
//
// Pure by design: imports nothing, touches no DB, does no I/O — so a guard can
// assert its composition directly (`scripts/verify-review-context.mjs`).

/** The files the reviewer's own prompt instructs it to check a change against. */
const RULE_FILES = ['KNOWN-HAZARDS.md', 'AGENTS.md'];

/** Included only when the change under review is actually about it. */
const CONDITIONAL_FILES = [
  { path: 'server/prisma/schema.prisma', whenTouchedPrefix: 'server/prisma/' },
];

function directoriesOf(paths) {
  const dirs = new Set();
  for (const p of paths) {
    const i = p.lastIndexOf('/');
    dirs.add(i === -1 ? '.' : p.slice(0, i));
  }
  return Array.from(dirs).sort();
}

/**
 * @param {{path: string, content: string}[]} files  every file in the project
 * @param {{path: string, content?: string, action?: string}[]} fileOps  the change under review
 * @param {{maxTreeBytes?: number, maxSiblingPaths?: number}} [opts]
 * @returns {string} the context block that precedes the operations in the reviewer prompt
 */
export function buildReviewerContext({ files, fileOps, maxTreeBytes = 12000, maxSiblingPaths = 400 } = {}) {
  const list = Array.isArray(files) ? files : [];
  const ops = Array.isArray(fileOps) ? fileOps : [];
  const byPath = new Map(list.map((f) => [f.path, f]));
  const allPaths = list.map((f) => f.path).sort();
  const opPaths = ops.map((op) => op && op.path).filter((p) => typeof p === 'string' && p);

  const sections = [];

  // 1. The rules first. The reviewer's prompt names both files explicitly, and a
  //    house rule the model may or may not have been shown is not stated at all.
  for (const p of RULE_FILES) {
    const f = byPath.get(p);
    if (f) sections.push(`--- ${f.path} ---\n${f.content}`);
  }

  // 2. The tree — full when it fits, otherwise bounded rather than unbounded.
  if (allPaths.length > 0) {
    const fullTree = allPaths.join('\n');
    if (fullTree.length <= maxTreeBytes) {
      sections.push(`FULL REPO FILE TREE (${allPaths.length} files — every path listed exists):\n${fullTree}`);
    } else {
      // Which paths does the reviewer plausibly need? The ones in the same
      // directories as the change — that is what makes "you import ./x.js but
      // nothing creates it" answerable — plus a directory index for the rest.
      const opDirs = new Set(directoriesOf(opPaths));
      const siblingPaths = allPaths.filter((p) => {
        const i = p.lastIndexOf('/');
        return opDirs.has(i === -1 ? '.' : p.slice(0, i));
      });
      const shownSiblings = siblingPaths.slice(0, maxSiblingPaths);
      const dirs = directoriesOf(allPaths);
      sections.push(
        `REPO FILE TREE (${allPaths.length} files — too large to include in full, so this is a`
        + ` directory index plus every path in the directories this change touches; a path NOT`
        + ` listed here may still exist):\n\nDIRECTORIES (${dirs.length}):\n${dirs.join('\n')}`
        + `\n\nPATHS IN THE TOUCHED DIRECTORIES (${shownSiblings.length} of ${siblingPaths.length}):\n`
        + `${shownSiblings.join('\n') || '(none)'}`
      );
    }
  }

  // 3. The schema only when the change is about it.
  for (const { path, whenTouchedPrefix } of CONDITIONAL_FILES) {
    const touched = opPaths.some((p) => p.startsWith(whenTouchedPrefix));
    if (!touched) continue;
    const f = byPath.get(path);
    if (f) sections.push(`--- ${f.path} (included because this change touches ${whenTouchedPrefix}) ---\n${f.content}`);
  }

  return sections.join('\n\n');
}
