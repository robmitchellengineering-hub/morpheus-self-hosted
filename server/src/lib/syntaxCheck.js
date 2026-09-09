// Deterministic per-file syntax / JSX check, shared by the self-dev verify
// gate (verifySelfDev.js) and every regular build turn (chatWithMorpheus.js).
//
// It runs esbuild's `transform` over each JS/TS/JSX/TSX file on its own —
// no bundling, no import resolution — so it catches the "the model emitted
// code that doesn't even parse" class (an unclosed brace, a stray token, a
// half-applied edit) BEFORE the change is written and the operator hits a
// white screen. Files in other languages (Python, Arduino, Go, plain HTML,
// …) carry no matching extension and are simply skipped, so this is a
// genuine no-op for non-JS projects.
//
// esbuild is already a backend dependency (added for verifySelfDev). If it
// somehow can't be loaded, checkSyntax returns [] rather than blocking a
// build on its own failure.
const CODE_EXT = /\.(jsx?|tsx?|mjs|cjs)$/;

function loaderFor(pathname) {
  if (/\.tsx$/.test(pathname)) return 'tsx';
  if (/\.ts$/.test(pathname)) return 'ts';
  return 'jsx'; // .js/.jsx/.mjs/.cjs — 'jsx' loader also parses plain JS
}

// files: [{ path, content }]. Returns [{ file, line, column, text }], one per
// distinct parse error, capped at `limit`.
export async function checkSyntax(files, { limit = 50 } = {}) {
  const code = (files || []).filter((f) => f && typeof f.content === 'string' && CODE_EXT.test(f.path));
  if (code.length === 0) return [];

  let esbuild;
  try {
    esbuild = await import('esbuild');
  } catch {
    return []; // no esbuild in this environment — don't block on our own gap
  }

  const errors = [];
  await Promise.all(code.map(async (f) => {
    try {
      await esbuild.transform(f.content, {
        loader: loaderFor(f.path),
        jsx: 'automatic',
        sourcefile: f.path,
      });
    } catch (e) {
      for (const err of e.errors || [{ text: e.message }]) {
        errors.push({
          file: err.location?.file || f.path,
          line: err.location?.line ?? null,
          column: err.location?.column ?? null,
          text: err.text || String(e.message || 'syntax error'),
        });
      }
    }
  }));

  const seen = new Set();
  return errors
    .filter((e) => {
      const k = `${e.file}:${e.line}:${e.text}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, limit);
}
