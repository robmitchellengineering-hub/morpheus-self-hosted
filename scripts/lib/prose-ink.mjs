// The prose-ink rule, as one dependency-free implementation.
//
// WHY THIS EXISTS
//
// The base layer (2026-09-22, commit 4474621) stopped *unclassed* body copy from
// rendering in the bright Matrix green. It could not touch the 1,600-odd places
// that name the green explicitly, and those are the ones that actually surround
// reading text: chat messages, helper lines, table cells, list items. Rob's
// convention is the one Alice Stats already followed — green marks the things
// that are actionable or are titles, ink carries the prose.
//
// WHY NO PARSER
//
// scripts/verify-guards-no-install.mjs walks every script in CI's guards job and
// fails if it can reach a bare package import, because that job deliberately runs
// without `npm install` (hazard H4: server/package-lock.json is untracked, so it
// *cannot* install). A guard that imported @babel/parser would take the whole job
// down. So this module ships its own scanner, and the sweep that uses it is a
// plain text rewrite over exact offsets — which also means it cannot reformat the
// files it touches.
//
// The scanner is deliberately conservative in one direction: every
// `text-primary/N` in a file is accounted for exactly once, and
// verify-prose-ink.mjs asserts that the classified total equals the raw total.
// An occurrence the scanner cannot attribute is a FAILURE, not a skip. A silent
// skip is how a sweep claims to be complete while leaving prose green.
//
// THE RULE (Rob, 2026-09-22 — approved from the proposal, then reviewed on pages)
//
//   Convert text-primary/N to text-ink/N only where it is prose at a small size:
//     * the host is a p / span / td / li — or a div that is purely a text wrapper
//     * it carries a small size class: text-[9px..12px], text-xs or text-sm
//     * it carries no title markers: font-semibold/bold/extrabold/black,
//       uppercase, tracking-wider/widest
//     * it is not a pill/badge (rounded-full), not a heading, not a number
//   Leave green everywhere it is a title, section heading, badge or headline
//   number — the brand colour is the point of the brand.
//
// Everything else is left green AND reported with its reason, so the judgement
// calls are visible rather than silent. See `REASONS` below for the vocabulary.

/** Tags the rule names directly. */
export const PROSE_TAGS = new Set(['p', 'span', 'td', 'li']);
export const DIV = 'div';
export const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

/**
 * Files the sweep must not touch, whatever the classifier says.
 *
 * Alice Stats is the page the whole convention was copied FROM (Rob, 2026-09-22:
 * "Do not touch AliceStats.jsx: it is the reference page and its text-primary/50
 * is intentional"). It is not exempt because it is already correct — it is
 * exempt because it is the reference, and editing the reference while sweeping
 * everything else would leave nothing to compare against. It has 8 occurrences
 * the rule would convert, kept deliberately and listed in the PR report.
 */
export const PROTECTED_FILES = ['src/pages/AliceStats.jsx'];

/** A small-size class, exactly the range the rule approved: 9–12px, xs, sm. */
export const SMALL_SIZE = /^text-\[(?:9|10|11|12)px\]$|^text-(?:xs|sm)$/;
/** Small-looking sizes outside the approved range — reported, not swept. */
export const NEAR_SIZE = /^text-\[(?:6|7|8|13|14)px\]$|^text-\[0\.\d+rem\]$|^text-base$/;

const TITLE_MARKERS = [
  [/^font-(?:semibold|bold|extrabold|black)$/, 'title-weight'],
  [/^uppercase$/, 'uppercase'],
  [/^tracking-(?:wider|widest)$/, 'title-tracking'],
];
const BADGE_MARKER = /^rounded-full$/;

// Tailwind size/alignment utilities that look like `text-<colour>` but are not.
const TEXT_SIZE_UTIL = /^text-(\[\d+(?:\.\d+)?(?:px|rem|em|%)?\]|xs|sm|base|lg|xl|[2-9]xl)$/;
const TEXT_ALIGN_UTIL = /^text-(left|center|right|justify|start|end|wrap|nowrap|balance|pretty|ellipsis|clip)$/;
const stripVariants = (c) => c.replace(/^([a-z-]+:)+/, '');
/** A text colour other than the `text-primary` family we are converting. */
const isRivalColour = (c) => {
  const s = stripVariants(c);
  if (!/^text-/.test(s)) return false;
  if (TEXT_SIZE_UTIL.test(s) || TEXT_ALIGN_UTIL.test(s)) return false;
  // `text-primary` and `text-primary/60` on one element is a state pair, not a
  // conflict: the plain token converts and the state-qualified one stays green.
  if (/^text-primary(?:\/\d+)?$/.test(s)) return false;
  return /^text-[a-z[]/.test(s);
};

/** `hover:`-style prefixes, including arbitrary ones like `[&_li]:`. */
const VARIANTS = '(?:\\[[^\\]]*\\]:|[a-z-]+:)*';
const OCCURRENCE = new RegExp(`(^|[\\s'"\`])(${VARIANTS})(text-primary\\/(\\d+))`, 'g');
/** Names that read as a number/statistic rather than as prose. */
const NUMBERISH = /^(?:n|i|j|k|v|id|ms|s|pct|num|count|total|qty|amount|sum|score|size|length|len|index|progress|percent|percentage|ratio|rate|value|val|version|port|code|status|duration|elapsed|bytes|kb|mb|gb|tb|width|height|top|left|depth|level|max|min|avg|mean|remaining|left_over|remainingMs|elapsedMs|ms|secs?|mins?|hours?|days?)$/i;

// ── reasons an occurrence is left green ─────────────────────────────────────
// A fixed vocabulary, so the guard and the report cannot drift apart.
export const REASONS = {
  'variant-qualified': 'the colour applies to a variant (hover/focus/placeholder/descendant), not to this element\'s resting prose',
  'heading-tag': 'h1–h6 keep the brand green',
  'title-weight': 'font-semibold/bold and up — a title, not prose',
  uppercase: 'uppercase is a label style — whether the class sets it or the text is written in capitals',
  'title-tracking': 'tracking-wider/widest is a label style, not prose',
  badge: 'rounded-full pill — a badge stays green',
  'not-small-size': 'no small-size class, so outside the approved size range',
  'near-size': 'a small size just outside 9–12px (listed for a decision)',
  'tag-out-of-scope': 'the host tag is not a prose tag (button/a/label/input/…)',
  'div-not-text-wrapper': 'a div whose children are block elements — a container, not a paragraph',
  'dynamic-classname': 'className is computed, so the class list cannot be read statically',
  'multi-colour': 'the element already carries another text colour',
  'number-like': 'the content is a number, and numbers keep the brand green',
  'icon-or-empty': 'no text content — an icon or a spinner',
  'class-constant': 'a class string in a constant, not on an element — outside the rule',
  'in-comment': 'inside a comment, so it renders nothing',
  unattributed: 'the scanner could not tell which tag owns this className',
};

// ── masking ────────────────────────────────────────────────────────────────
// Replace the *interior* of every comment and literal with spaces, keeping
// delimiters and newlines, so offsets and line numbers survive and no `<`, `>`,
// `{` or `}` hides inside a string.
//
// This has to be JSX-AWARE, and that is not a nicety. Inside JSX *children* the
// characters `/*`, `//`, `'` and `"` are ordinary prose, not syntax — ContentPanel
// literally says "Text and lists the builder put in content/*.json", and a
// comment-only masker blanked 25 following lines and silently hid every
// className in them. So the lexer tracks which of three places it is in:
//
//   js    — real code: comments, strings and templates are literals here
//   tag   — inside a JSX opening/closing tag: attribute values are literals
//   kids  — JSX children: only `{…}` expressions are literals, the rest is text
//
// `commentsOnly` masks comments and leaves strings alone, which is how a bare
// occurrence is told apart from one inside a class-string constant.
export function maskSource(src, { commentsOnly = false } = {}) {
  const out = [...src];
  const blank = (i) => { if (out[i] !== '\n') out[i] = ' '; };
  const n = src.length;
  const stack = [{ mode: 'js', brace: 0 }];
  const top = () => stack[stack.length - 1];
  const strings = !commentsOnly;

  /** Is `<` at `k` plausibly a JSX tag rather than a less-than comparison? */
  const isTagAt = (k) => {
    if (src[k] !== '<') return false;
    if (src[k + 1] === '>') return true;                       // fragment <>
    if (src[k + 1] === '/' && src[k + 2] === '>') return true;  // fragment </>
    let j = k + 1;
    if (src[j] === '/') j++;
    const s = j;
    while (j < n && /[\w.$:-]/.test(src[j])) j++;
    if (j === s || !/^[A-Za-z]/.test(src[s])) return false;
    let k2 = j;
    while (k2 < n && /\s/.test(src[k2])) k2++;
    // After the name a tag has an attribute, `>`, `/>` or nothing; a comparison
    // has an operator (`a < b && c`), a call (`a < b.size`), or a literal.
    const c = src[k2];
    return c === '>' || c === '/' || c === '{' || (c !== undefined && /[A-Za-z_]/.test(c));
  };

  let i = 0;
  while (i < n) {
    const st = top();
    const c = src[i];

    if (st.mode === 'kids') {
      if (c === '<' && isTagAt(i)) { stack.push({ mode: 'tag', brace: 0, closing: src[i + 1] === '/' }); i++; continue; }
      if (c === '{') { stack.push({ mode: 'js', brace: 1 }); i++; continue; }
      i++; continue; // JSX text — left exactly as it is
    }

    if (c === '/' && src[i + 1] === '/') {
      let j = i; while (j < n && src[j] !== '\n') { blank(j); j++; }
      i = j; continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      blank(i); blank(i + 1);
      let j = i + 2;
      while (j < n && !(src[j] === '*' && src[j + 1] === '/')) { blank(j); j++; }
      if (j < n) { blank(j); blank(j + 1); }
      i = j + 2; continue;
    }
    if (strings && (c === '"' || c === "'")) {
      let j = i + 1;
      while (j < n) {
        if (src[j] === '\\') { blank(j); blank(j + 1); j += 2; continue; }
        if (src[j] === c || src[j] === '\n') break;
        blank(j); j++;
      }
      i = j + 1; continue;
    }
    if (strings && c === '`') {
      let j = i + 1;
      let depth = 0;
      while (j < n) {
        if (src[j] === '\\') { blank(j); blank(j + 1); j += 2; continue; }
        if (src[j] === '$' && src[j + 1] === '{') { depth++; j += 2; continue; }
        if (depth > 0 && src[j] === '}') { depth--; j++; continue; }
        if (depth === 0 && src[j] === '`') break;
        blank(j); j++;
      }
      i = j + 1; continue;
    }

    if (st.mode === 'tag') {
      if (c === '{') { stack.push({ mode: 'js', brace: 1 }); i++; continue; }
      if (c === '>') {
        let k = i - 1;
        while (k >= 0 && /\s/.test(src[k])) k--;
        const selfClosing = src[k] === '/';
        const wasClosing = st.closing;
        stack.pop();
        // An opening tag opens a children region; a closing tag ends one.
        if (wasClosing) { if (top().mode === 'kids') stack.pop(); }
        else if (!selfClosing) stack.push({ mode: 'kids' });
        i++; continue;
      }
      i++; continue;
    }

    // js
    if (c === '{') { st.brace++; i++; continue; }
    if (c === '}') {
      if (st.brace <= 1 && stack.length > 1) stack.pop();
      else if (st.brace > 0) st.brace--;
      i++; continue;
    }
    if (c === '<' && isTagAt(i)) { stack.push({ mode: 'tag', brace: 0, closing: src[i + 1] === '/' }); i++; continue; }
    i++;
  }
  return out.join('');
}

// ── JSX structure over the masked text ─────────────────────────────────────

/** Read the tag that starts at `lt` (which points at `<`); null if not a tag. */
function readTag(masked, lt) {
  let i = lt + 1;
  let closing = false;
  if (masked[i] === '/') { closing = true; i++; }
  const nameStart = i;
  while (i < masked.length && /[\w.$:-]/.test(masked[i])) i++;
  const name = masked.slice(nameStart, i);
  if (!name || !/^[A-Za-z]/.test(name)) return null;
  let depth = 0;
  while (i < masked.length) {
    const c = masked[i];
    if (c === '{') depth++;
    else if (c === '}') depth = Math.max(0, depth - 1);
    else if (c === '>' && depth === 0) break;
    i++;
  }
  if (i >= masked.length) return null;
  return { closing, name, openEnd: i, end: i + 1, selfClosing: masked[i - 1] === '/' };
}

/** Offset of the `<` opening the tag that owns the attribute at `at`. */
function owningTagStart(masked, at) {
  let depth = 0;
  for (let i = at - 1; i >= 0; i--) {
    const c = masked[i];
    if (c === '}') depth++;
    else if (c === '{') depth = Math.max(0, depth - 1);
    else if (c === '<' && depth === 0) {
      const t = readTag(masked, i);
      return t && !t.closing && at < t.end ? i : -1;
    } else if (c === '>' && depth === 0) return -1;
  }
  return -1;
}

/**
 * The immediate children of the element whose opening tag ends at `from`.
 *   tags  — child tag names at depth 1
 *   text  — literal text survives outside children and expressions
 *   plain — that literal text
 *   exprs — depth-0 `{…}` expressions, as source snippets
 *
 * `masked` already leaves JSX children untouched, so `//` in prose survives and
 * a real comment cannot appear at depth 0 here (it must sit inside `{…}`, which
 * the brace counter skips).
 */
function childrenOf(src, masked, from, selfClosing) {
  const tags = [];
  const exprs = [];
  let plain = '';
  if (selfClosing) return { tags, text: false, plain, exprs };
  let depth = 0;
  let brace = 0;
  let exprStart = -1;
  for (let i = from; i < masked.length; i++) {
    const c = masked[i];
    if (c === '{') { if (brace === 0 && depth === 0) exprStart = i + 1; brace++; continue; }
    if (c === '}') {
      brace = Math.max(0, brace - 1);
      if (brace === 0 && depth === 0 && exprStart >= 0) { exprs.push(src.slice(exprStart, i).trim()); exprStart = -1; }
      continue;
    }
    if (brace > 0) continue;
    if (c === '<') {
      const t = readTag(masked, i);
      if (!t) continue;
      if (t.closing) {
        depth--;
        if (depth <= 0) break;
      } else if (t.selfClosing) {
        if (depth === 0) { tags.push(t.name); }
      } else {
        if (depth === 0) tags.push(t.name);
        depth++;
      }
      i = t.end - 1;
      continue;
    }
    if (depth === 0 && c !== ' ') plain += src[i];
  }
  return { tags, text: /[A-Za-z]/.test(plain), plain: plain.trim(), exprs };
}

/** Tags whose presence as an immediate child means "this div is a layout box". */
const BLOCK_CHILD = new Set([
  'div', 'section', 'article', 'header', 'footer', 'main', 'aside', 'nav', 'form',
  'ul', 'ol', 'table', 'thead', 'tbody', 'tr', 'pre', 'fieldset', 'details',
]);
const PROSE_CHILD = new Set(['p', 'span', 'a', 'strong', 'em', 'small', 'code', 'b', 'i', 'label', 'li', 'br']);

/** Is a depth-0 expression snippet number-like rather than prose? */
function expressionIsNumberish(expr) {
  const e = expr.trim();
  if (/^[\d\s.,%$+\-*/()]+$/.test(e)) return true;
  if (/^[A-Za-z_$][\w$.]*$/.test(e)) {
    const last = e.split('.').pop();
    return NUMBERISH.test(last);
  }
  return false;
}

// ── literal extraction from a className expression ─────────────────────────
/** Every class-bearing literal inside `src.slice(start, end)`, with offsets. */
function literalsIn(src, start, end) {
  const found = [];
  let i = start;
  while (i < end) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { while (i < end && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { i += 2; while (i < end && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    if (c === '"' || c === "'") {
      const s = i + 1;
      let j = s;
      while (j < end) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === c) break;
        j++;
      }
      found.push({ interior: src.slice(s, j), start: s, end: j });
      i = j + 1; continue;
    }
    if (c === '`') {
      const s = i + 1;
      let j = s;
      while (j < end) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '`') break;
        j++;
      }
      found.push({ interior: src.slice(s, j), start: s, end: j, template: true });
      i = j + 1; continue;
    }
    i++;
  }
  return found;
}

// ── the scanner ────────────────────────────────────────────────────────────

/** Every className attribute in the file, with the tag that owns it. */
function scanElements(src) {
  const masked = maskSource(src);
  const elements = [];
  const attr = /className\s*=\s*/g;
  let m;
  while ((m = attr.exec(masked))) {
    const valueAt = attr.lastIndex;
    let literals = [];
    let dynamic = false;
    let rangeEnd;
    if (masked[valueAt] === '"' || masked[valueAt] === "'") {
      const q = masked[valueAt];
      let j = valueAt + 1;
      while (j < masked.length && masked[j] !== q) j++;
      literals = literalsIn(src, valueAt, j + 1);
      rangeEnd = j + 1;
    } else if (masked[valueAt] === '{') {
      let depth = 0;
      let j = valueAt;
      while (j < masked.length) {
        if (masked[j] === '{') depth++;
        else if (masked[j] === '}') { depth--; if (depth === 0) break; }
        j++;
      }
      const body = src.slice(valueAt + 1, j).trim();
      const singleString = /^(['"])(?:\\.|(?!\1)[^\\])*\1$/.test(body);
      const singleTemplate = /^`[^`]*`$/.test(body) && !body.includes('${');
      if (singleString || singleTemplate) literals = literalsIn(src, valueAt, j + 1);
      else { literals = literalsIn(src, valueAt, j + 1); dynamic = true; }
      rangeEnd = j + 1;
    } else {
      continue;
    }
    const all = literals.map((l) => l.interior).join(' ');
    if (!OCCURRENCE.test(all)) { OCCURRENCE.lastIndex = 0; continue; }
    OCCURRENCE.lastIndex = 0;

    const lt = owningTagStart(masked, m.index);
    const tag = lt >= 0 ? readTag(masked, lt) : null;
    elements.push({
      tag: tag ? tag.name : '?',
      attributed: Boolean(tag),
      dynamic: dynamic || literals.some((l) => l.template && l.interior.includes('${')),
      literals,
      rangeStart: valueAt,
      rangeEnd,
      classes: all.split(/\s+/).filter(Boolean),
      kids: tag ? childrenOf(src, masked, tag.end, tag.selfClosing) : { tags: [], text: false, plain: '', exprs: [] },
      selfClosing: tag ? tag.selfClosing : true,
    });
  }
  return elements;
}

/** Is the literal text itself capitals? Then it is a label, whatever the class. */
const isLabelCase = (s) => {
  const letters = s.replace(/[^A-Za-z]/g, '');
  return letters.length >= 2 && letters === letters.toUpperCase();
};

/** The verdict for one className, before per-occurrence refinements. */
function classify(el) {
  const classes = el.classes;
  const flat = el.tag.toLowerCase();
  const size = classes.find((c) => SMALL_SIZE.test(c));
  const near = classes.find((c) => NEAR_SIZE.test(c));

  if (HEADING_TAGS.has(flat)) return { verdict: 'leave', reason: 'heading-tag' };
  for (const [re, reason] of TITLE_MARKERS) if (classes.some((c) => re.test(c))) return { verdict: 'leave', reason };
  if (classes.some((c) => BADGE_MARKER.test(c))) return { verdict: 'leave', reason: 'badge' };
  if (classes.some(isRivalColour)) return { verdict: 'leave', reason: 'multi-colour' };
  if (!size) return { verdict: 'leave', reason: near ? 'near-size' : 'not-small-size' };
  if (!PROSE_TAGS.has(flat) && flat !== DIV) return { verdict: 'leave', reason: 'tag-out-of-scope' };
  // A label reads as a title whether the capitals come from the class or the
  // text, so this sits after the tag gate: a `REVERT` button is out of scope
  // because it is a button, not because it is capitalised.
  if (el.kids.text && isLabelCase(el.kids.plain)) return { verdict: 'leave', reason: 'uppercase' };

  if (el.selfClosing || (!el.kids.text && !el.kids.exprs.length && !el.kids.tags.length)) {
    return { verdict: 'leave', reason: 'icon-or-empty' };
  }
  if (el.kids.tags.length && !el.kids.text && !el.kids.exprs.length) {
    return { verdict: 'leave', reason: 'icon-or-empty' };
  }
  if (!el.kids.text && el.kids.exprs.length && el.kids.exprs.every(expressionIsNumberish)) {
    return { verdict: 'leave', reason: 'number-like' };
  }
  if (el.kids.text && /^[\s\d.,:%$+\-–—×x()]*$/.test(el.kids.plain)) {
    return { verdict: 'leave', reason: 'number-like' };
  }

  if (flat === DIV) {
    const blocky = el.kids.tags.some((t) => BLOCK_CHILD.has(t.toLowerCase()));
    const nonProse = el.kids.tags.some((t) => !PROSE_CHILD.has(t.toLowerCase()));
    if (blocky || nonProse) return { verdict: 'leave', reason: 'div-not-text-wrapper' };
  }
  if (el.dynamic) return { verdict: 'leave', reason: 'dynamic-classname' };
  if (!el.attributed) return { verdict: 'leave', reason: 'unattributed' };
  return { verdict: 'convert', reason: null };
}

/**
 * Every `text-primary/N` in the file, exactly once, with a verdict and — when it
 * is left green — the reason.
 */
export function scanSource(src) {
  const elements = scanElements(src);
  const claimed = new Uint8Array(src.length);
  const out = [];

  for (const el of elements) {
    const base = classify(el);
    for (const lit of el.literals) {
      OCCURRENCE.lastIndex = 0;
      let m;
      while ((m = OCCURRENCE.exec(lit.interior))) {
        const offset = lit.start + m.index + m[1].length + m[2].length;
        const token = m[3];
        const variantPrefix = m[2];
        let verdict = base.verdict;
        let reason = base.reason;
        if (verdict === 'convert' && variantPrefix) { verdict = 'leave'; reason = 'state-variant'; }
        claimed[offset] = 1;
        out.push({
          offset, token, tag: el.tag, verdict, reason,
          to: verdict === 'convert' ? token.replace('text-primary/', 'text-ink/') : null,
        });
      }
    }
  }

  // Anything the element pass did not own still has to be accounted for, or a
  // "complete" sweep is only complete over the part the scanner happened to see.
  const commentMasked = maskSource(src, { commentsOnly: true });
  const bare = new RegExp(`(^|[\\s'"\`])(${VARIANTS})(text-primary\\/\\d+)`, 'g');
  let b;
  while ((b = bare.exec(src))) {
    const offset = b.index + b[1].length + b[2].length;
    if (claimed[offset]) continue;
    const inComment = commentMasked[offset] === ' ' && src[offset] !== ' ';
    out.push({
      offset, token: b[3], tag: '?', verdict: 'leave',
      reason: inComment ? 'in-comment' : 'class-constant', to: null,
    });
  }

  return out.sort((a, b2) => a.offset - b2.offset);
}

/** Apply the conversions back onto the source, by exact offset. */
export function applyConversions(src, occurrences) {
  let out = src;
  for (const o of [...occurrences].reverse()) {
    if (o.verdict !== 'convert') continue;
    out = out.slice(0, o.offset) + o.to + out.slice(o.offset + o.token.length);
  }
  return out;
}

/** Every `text-primary/N` in the source, counted the naive way. For the guard. */
export const rawOccurrences = (src) => (src.match(/text-primary\/\d+/g) || []).length;
