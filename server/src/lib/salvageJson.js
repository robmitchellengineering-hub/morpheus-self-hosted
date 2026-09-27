// Recover the complete part of a JSON value that was cut off mid-write.
//
// Why this exists (2026-09-28): a reasoning model's thinking is billed against the same maxTokens
// as its answer, so a schema call can hit the cap before it finishes. `invokeAI` throws on that for
// a schema call, and that is right when the value is ONE object the caller will act on — half of it
// is a lie. It is the wrong shape for a LIST: every item already written is complete and usable,
// and throwing them away turns "the split was cut short" into "nothing was classified at all".
//
// Call this ONLY after a parse of the full text has already failed. It is not a validator: it
// returns the largest complete prefix, which by definition is missing whatever came after it. The
// caller must surface that (`truncated: true`) and keep its own honesty rules for the remainder —
// see lib/deckDumpClassify.js's coverage guard, which files the untouched tail rather than losing
// it. Returns `null` when nothing can be recovered, and the caller must then keep its original
// error rather than invent a value.
//
// Dependency-free so it can be asserted by scripts/verify-salvage-json.mjs in CI's no-install job.
export function salvageJson(raw) {
  const text = String(raw ?? '');
  const stack = [];
  const candidates = []; // every point where an object just closed, with the closers it still needs
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      // A brace or bracket inside a string is data, not structure — the whole point of tracking
      // this separately, and the case a naive "last }" cut gets wrong.
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{' || ch === '[') { stack.push(ch); continue; }
    if (ch === '}' || ch === ']') {
      const open = stack.pop();
      // Mismatched containers mean this is not JSON we truncated, it is JSON we should not guess
      // at. Refusing is the honest answer.
      if ((ch === '}' && open !== '{') || (ch === ']' && open !== '[')) return null;
      if (ch === '}') {
        candidates.push({
          end: i,
          closers: stack.slice().reverse().map((o) => (o === '{' ? '}' : ']')).join(''),
        });
      }
    }
  }

  // Newest cut point first: the later the object closed, the more of the answer it keeps. Bounded
  // so a pathological input cannot turn this into a long scan on the request path.
  for (let c = candidates.length - 1, tries = 0; c >= 0 && tries < 64; c--, tries++) {
    const { end, closers } = candidates[c];
    try {
      const value = JSON.parse(text.slice(0, end + 1) + closers);
      if (value && typeof value === 'object') return { value, truncated: true };
    } catch {
      // This cut point is not valid on its own — try the one before it.
    }
  }
  return null;
}
