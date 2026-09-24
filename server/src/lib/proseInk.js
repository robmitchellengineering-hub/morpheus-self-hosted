// CANONICAL COPY — server/src/lib/proseInk.js
//
// Moved here from scripts/lib/prose-ink.mjs so the SERVER can apply the same rules
// the CI guard applies, inside the build turn, instead of the writer finding out
// from a red gate. scripts/lib/prose-ink.mjs is now a re-export of this file: one
// copy, because a guard that re-implements the rule it guards drifts from it.
//
// Pure: imports nothing, reads no files, does no I/O. That is what lets it run in
// the API container (which has no scripts/ directory) and in the no-install CI job.
//
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

/**
 * Tags whose own text is prose. The size of the text is NOT part of this any
 * more: Rob, 2026-09-23 — "all the small text is still green or shades of it, i
 * need all the small text to be white or shades of for clarity". Prose is prose
 * whether or not the source happens to name a font size.
 */
export const PROSE_TAGS = new Set([
  'p', 'span', 'div', 'td', 'li', 'dd', 'dt', 'figcaption', 'blockquote',
  'pre', 'code', 'tr', 'ul', 'ol', 'label',
]);
/**
 * Tags that carry structure or an action, so green keeps meaning something:
 * buttons and controls are actions, `label` is a field label, `a` is a link, and
 * `th` is a column heading. Their text is not the running prose Rob is reading.
 */
export const ACTION_TAGS = new Set(['button', 'a', 'summary', 'details', 'th']);
/**
 * Form fields. Rob, 2026-09-23: "a form label or the text you type into a field
 * is text you read, not structure", so these came OUT of the keep-green set.
 * They need their own set because an `input` has no children to judge — the text
 * the user reads is its value and its placeholder, not a child node.
 */
export const FIELD_TAGS = new Set(['input', 'textarea', 'select', 'option']);
export const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
/** Inline emphasis inside prose: green is the brand's emphasis, so it stays. */
export const EMPHASIS_TAGS = new Set(['strong', 'b', 'em', 'i', 'mark', 'kbd', 'samp', 'var', 'abbr', 'cite']);
/**
 * Headline sizes. A `div` at 24px in the brand green is a title, and Rob keeps
 * titles green — removing the prose size gate must not quietly turn every
 * headline into body copy.
 */
function isTitleSize(c) {
  if (/^text-(?:xl|[2-9]xl)$/.test(c)) return true;
  const m = c.match(/^text-\[(\d+(?:\.\d+)?)(px|rem|em)\]$/);
  if (!m) return false;
  const n = Number(m[1]);
  return m[2] === 'px' ? n >= 18 : n >= 1.125;
}

/**
 * The Command Deck is its own theme and is out of scope, permanently.
 *
 * Rob, 2026-09-23: "command deck is its own theme please dont change it". The
 * Deck is Tweed & Walnut — dark walnut on cream, its own hex palette in
 * deckConstants.js (C.tweed / C.walnut / C.ink) — and it does not use the app's
 * `--text-ink` or `--primary` tokens at all. The reason this needs an explicit
 * boundary rather than relying on that: the prose-ink rule reads only the tag
 * and the class, so the moment a Deck file carries a `text-primary/N` the sweep
 * would happily rewrite it. The exclusion is asserted in verify-prose-ink.mjs.
 */
export const DECK_PATHS = [
  'src/pages/CommandDeck/',
  'src/contexts/CommandDeckContext.jsx',
  'src/contexts/DeckGoogleConnectionContext.jsx',
  'src/hooks/useDeckGoogleConnection.js',
  'deck.html',
];
export const isDeckFile = (rel) =>
  DECK_PATHS.some((p) => (p.endsWith('/') ? rel.startsWith(p) : rel === p));

/**
 * Tailwind text-colour names that mean "a title or a link INSIDE prose", used to
 * judge an arbitrary descendant variant like `[&_h2]:text-primary`.
 */
const VARIANT_TITLE_TARGETS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'th', 'strong', 'b', 'em', 'a', 'code', 'pre']);
const VARIANT_PROSE_TARGETS = new Set(['li', 'p', 'td', 'span', 'div', 'dd', 'dt', 'figcaption', 'blockquote']);

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
/** Does this class list already paint with the ink token? */
const hasInk = (classes) => classes.some((c) => /^text-ink(?:\/\d+)?$/.test(stripVariants(c)));
/** Does one literal carry a colour that would fight the primary token? */
/**
 * Class tokens inside a template literal sit between quotes and braces, so the
 * naive whitespace split yields `text-primary/50'` — which then fails the
 * "not a rival" test and looks like a conflict. Strip the delimiters first.
 */
const cleanToken = (c) => c.replace(/^[^A-Za-z[]+/, '').replace(/[^A-Za-z0-9\]/%.-]+$/, '');
const isPlain = (c) => c && !/^[a-z-]+:/.test(c) && !/^\[/.test(c);
const isPlainPrimary = (c) => isPlain(c) && /^text-primary(?![\w-])(?:\/\d+)?$/.test(c);
const isPlainRival = (c) => isPlain(c) && (isRivalColour(c) || /^text-ink(?:\/\d+)?$/.test(stripVariants(c)));

/**
 * A conflict is two colours that can apply AT THE SAME TIME. In a computed
 * className the branches are quoted, so splitting on the quote characters gives
 * the branches: `cond ? 'text-primary' : 'text-red-400'` is a state pair and
 * converts, while a static `"text-primary/60 text-red-400"` is one segment
 * holding both and does not.
 */
const literalHasRival = (interior) =>
  interior.split(/['"`]/).some((seg) => {
    const toks = seg.split(/\s+/).map(cleanToken).filter(Boolean);
    // BOTH sides must be PLAIN. A reverted `placeholder:text-primary/65` sitting
    // next to a `text-ink` is not a conflict — they apply at different times — and
    // treating it as one let a partial revert hide from the guard.
    return toks.some(isPlainPrimary) && toks.some(isPlainRival);
  });

/**
 * Does the `/` at `k` begin a regex literal rather than a division? A regex is
 * allowed where an expression is expected: after an operator, an opening bracket,
 * a comma, a colon, or one of the keywords that precede an expression.
 */
const REGEX_PRECEDER = /[([{,;:=!&|?+\-*%^~]|\b(?:return|typeof|case|in|of|new|delete|void|instanceof|do|else|yield|await)$/;
function regexCanStartAt(src, k) {
  let j = k - 1;
  while (j >= 0 && /\s/.test(src[j])) j--;
  if (j < 0) return false;
  const before = src.slice(Math.max(0, j - 10), j + 1);
  return REGEX_PRECEDER.test(before);
}

/**
 * Is the occurrence inside a `className=` literal? Then the element pass FAILED
 * to attribute it, which is a scanner bug and must be reported as `unattributed`
 * rather than filed as a harmless class-string constant. SyntaxHighlighter's
 * regex-literal masking bug hid a real JSX occurrence exactly this way.
 */
/** The source text of the literal containing `offset`, for the decision registry. */
function enclosingLiteral(src, offset) {
  let j = offset;
  while (j > 0) {
    const ch = src[j];
    if ((ch === '"' || ch === "'" || ch === '`') && src[j - 1] !== '\\') break;
    j--;
  }
  const q = src[j];
  let e = offset;
  while (e < src.length && src[e] !== q) e++;
  return src.slice(j + 1, e);
}

function isClassNameLiteral(src, offset) {
  let j = offset;
  while (j > 0) {
    const ch = src[j];
    if ((ch === '"' || ch === "'" || ch === '`') && src[j - 1] !== '\\') break;
    j--;
  }
  if (j <= 0) return false;
  let k = j - 1;
  while (k >= 0 && /\s/.test(src[k])) k--;
  if (src[k] === '{') { k--; while (k >= 0 && /\s/.test(src[k])) k--; }
  return /className\s*=$/.test(src.slice(Math.max(0, k - 12), k + 1));
}

/** `hover:`-style prefixes, including arbitrary ones like `[&_li]:`. */
const VARIANTS = '(?:\\[[^\\]]*\\]:|[a-z-]+:)*';
// Both the shades (`text-primary/60`) and the bare token. Rob's complaint is
// "all the small text is still green or shades of it", and a rule that whitened
// `text-primary/70` while leaving `text-primary` bright green on the very same
// kind of element would be incoherent on screen.
// `(?![\\w-])` matters: `text-primary-foreground` is a DIFFERENT token, and
// without the boundary the sweep would rewrite it to the nonexistent
// `text-ink-foreground`. One source string, so the three scans cannot disagree.
const OCC_SRC = `(^|[\\s'"\`])(${VARIANTS})(text-primary(?![\\w-])(?:\\/(\\d+))?)`;
const OCCURRENCE = new RegExp(OCC_SRC, 'g');
/** Names that read as a number/statistic rather than as prose. */
const NUMBERISH = /^(?:n|i|j|k|v|id|ms|s|pct|num|count|total|qty|amount|sum|score|size|length|len|index|progress|percent|percentage|ratio|rate|value|val|version|port|code|duration|elapsed|bytes|kb|mb|gb|tb|width|height|top|left|depth|level|max|min|avg|mean|remaining|left_over|remainingMs|elapsedMs|ms|secs?|mins?|hours?|days?)$/i;


/**
 * Class strings held in constants that stay green — resolved by USAGE on
 * 2026-09-23 rather than by guessing. Every one is a button, a form field, a
 * counter, or a SEMANTIC status colour (`ok ? green : red`): green there means
 * "this is fine", which is exactly what green is for. The two prose constants
 * that were in this set (HealthTab and SearchConsolePanel `faint`) were
 * converted to ink instead.
 *
 * verify-prose-ink.mjs asserts the set matches this list exactly, so a new
 * constant is a decision someone has to make rather than something that
 * silently leaves prose green.
 */
export const KNOWN_GREEN_CONSTANTS = [
  "src/components/matrix/BackendPipelineRunner.jsx|text-primary",
  "src/components/matrix/DistroConfigDialog.jsx|w-full bg-background text-primary border border-primary/30 px-2.5 py-2 text-sm outline-none placeholder:text-primary/20",
  "src/components/matrix/DomainPanel.jsx|text-primary/50",
  "src/components/matrix/LinuxDistroConfigDialog.jsx|w-full bg-background text-primary border border-primary/30 px-2.5 py-2 text-sm outline-none placeholder:text-primary/20",
  "src/components/matrix/PhotoDriveWidget.jsx|inline-flex items-center gap-1.5 px-3 py-1.5 border border-primary/50 text-primary/80 hover:border-primary hover:text-primary text-xs transition-colors disabled:opacity-40",
  "src/components/matrix/PipelineRunner.jsx|text-primary",
  "src/components/matrix/ProjectBar.jsx|flex items-center gap-1 text-xs text-primary/70 hover:text-primary px-3 md:px-2.5 h-[44px] md:h-[34px] whitespace-nowrap shrink-0 border border-primary/30 hover:border-primary/60 hover:bg-primary/5 transition-colors",
  "src/components/matrix/website/CodeTab.jsx|w-full bg-black/30 border border-primary/20 px-2.5 h-[36px] text-[12px] text-primary focus:outline-none focus:border-primary/50",
  "src/components/matrix/website/HealthTab.jsx|inline-flex items-center justify-center gap-1.5 px-3 h-[32px] border border-primary/30 text-[10px] uppercase tracking-wider text-primary/80 hover:text-primary hover:border-primary disabled:opacity-40 shrink-0",
  "src/components/matrix/website/HealthTab.jsx|text-[9px] text-primary/35 uppercase tracking-wider",
  "src/components/matrix/website/HealthTab.jsx|text-primary/45 border-primary/20",
  "src/components/matrix/website/PagesTab.jsx|w-full bg-black/30 border border-primary/20 px-2.5 h-[42px] text-[13px] text-primary focus:outline-none focus:border-primary/50",
  "src/components/matrix/website/PagesTab.jsx|w-full bg-black/30 border border-primary/20 px-2.5 py-2 text-[13px] text-primary focus:outline-none focus:border-primary/50",
  "src/components/matrix/website/SearchConsolePanel.jsx|inline-flex items-center gap-1.5 px-2.5 h-[28px] border border-primary/25 text-[10px] uppercase tracking-wider text-primary/80 hover:text-primary hover:border-primary/50 disabled:opacity-40 disabled:hover:border-primary/25",
  "src/components/matrix/website/SearchConsolePanel.jsx|text-[9px] text-primary/35 uppercase tracking-wider",
  "src/components/matrix/website/SeoTab.jsx|border border-primary/30 text-primary/75 hover:border-primary hover:text-primary",
  "src/components/matrix/website/SeoTab.jsx|text-primary/30",
  "src/components/matrix/website/SeoTab.jsx|text-primary/60",
  "src/components/matrix/website/SeoTab.jsx|w-full bg-black/30 border border-primary/20 px-2.5 h-[38px] text-[12px] text-primary focus:outline-none focus:border-primary/50",
  "src/components/matrix/website/SeoTab.jsx|w-full bg-black/30 border border-primary/20 px-2.5 py-2 text-[12px] text-primary focus:outline-none focus:border-primary/50",
  "src/components/matrix/website/SetupTab.jsx|border-primary/40 text-primary/80 hover:border-primary hover:text-primary",
  "src/components/matrix/website/SetupTab.jsx|border-primary/60 text-primary hover:border-primary",
  "src/components/matrix/website/SetupTab.jsx|w-full bg-black/30 border border-primary/20 px-2.5 h-[42px] text-[13px] text-primary focus:outline-none focus:border-primary/50",
  "src/components/matrix/website/ShopTab.jsx|w-full bg-black/30 border border-primary/20 px-2.5 h-[42px] text-[13px] text-primary focus:outline-none focus:border-primary/50",
  "src/components/matrix/website/ShopTab.jsx|w-full bg-black/30 border border-primary/20 px-2.5 py-2 text-[13px] text-primary focus:outline-none focus:border-primary/50",
  "src/components/matrix/website/TrafficTab.jsx|text-primary/60",
  "src/components/ui/button.jsx|text-primary underline-offset-4 hover:underline",
  "src/pages/AdminPanel.jsx|text-primary",
  "src/pages/AdminPanel.jsx|text-primary/40",
  "src/pages/SelfDev.jsx|${btnBase} text-primary/70 hover:text-primary border-primary/30 hover:border-primary/60 hover:bg-primary/5",
  "src/pages/SelfDev.jsx|text-[10px] tracking-widest text-primary/40 uppercase self-center pr-1",
];
// ── reasons an occurrence is left green ─────────────────────────────────────
// A fixed vocabulary, so the guard and the report cannot drift apart.
export const REASONS = {
  'deck-own-theme': 'the Command Deck is its own theme (Tweed & Walnut) and is out of scope',
  'state-variant': 'the colour applies to hover/focus/placeholder — an action state, not resting prose',
  'descendant-title': 'an arbitrary variant painting a heading/link/code INSIDE prose — those stay green',
  'heading-tag': 'h1–h6 keep the brand green',
  'title-weight': 'font-semibold/bold and up — a title, not prose',
  'text-capitals': 'the text itself is capitals — a label reads as a title whatever the class says',
  'runtime-capitals': 'the content is {x.toUpperCase()} — a label, and it is only visible at runtime',
  uppercase: 'an `uppercase` class — a label style, not prose',
  'title-tracking': 'tracking-wider/widest is a label style, not prose',
  'title-size': 'headline size (text-xl and up) — a title, and titles keep the brand green',
  'inline-emphasis': 'strong/em/code emphasis inside prose — green is the brand emphasis',
  'symbol-content': 'the content is a glyph, not words — a status indicator',
  badge: 'rounded-full pill — a badge stays green',
  'action-tag': 'a button/link/field label — an action or a label, not prose',
  'component-host': 'a component (icon, button, badge), not a prose element',
  'container-only': 'a div with no text of its own — a layout box',
  'dynamic-classname': 'className is computed, so the class list cannot be read statically',
  'multi-colour': 'one static class list carries two text colours — a real conflict',
  'ink-collision': "a computed className already uses text-ink, so converting would collapse its states",
  'number-like': 'the content is a number or a metric, and metrics keep the brand green',
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

    const isTagAt = (k) => isTagAtIn(src, k);

  let i = 0;
  while (i < n) {
    const st = top();
    const c = src[i];

    if (st.mode === 'kids') {
      if (c === '<' && isTagAt(i)) { stack.push({ mode: 'tag', brace: 0, closing: src[i + 1] === '/' }); i++; continue; }
      if (c === '{') { stack.push({ mode: 'js', brace: 1 }); i++; continue; }
      i++; continue; // JSX text — left exactly as it is
    }

    // Inside a JSX tag: attribute values are literals, `{…}` is an expression, and
    // `/` is just the character in `</tag>` or `<br />`. Nothing else is syntax.
    if (st.mode === 'tag') {
      if (c === '{') { stack.push({ mode: 'js', brace: 1 }); i++; continue; }
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
        while (j < n && src[j] !== '`') { if (src[j] === '\\') { j += 2; continue; } blank(j); j++; }
        i = j + 1; continue;
      }
      if (c === '>') {
        let k = i - 1;
        while (k >= 0 && /\s/.test(src[k])) k--;
        const selfClosing = src[k] === '/';
        const wasClosing = st.closing;
        stack.pop();
        if (wasClosing) { if (top().mode === 'kids') stack.pop(); }
        else if (!selfClosing) stack.push({ mode: 'kids' });
        i++; continue;
      }
      i++; continue;
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
    // A regex literal. This is not a nicety: SyntaxHighlighter builds a tokeniser
    // out of `/[^\n]*|\/\*[\s\S]*?\*\/|#[^\n]*/`, and without this the `//`,
    // `/*` and quotes INSIDE those patterns were read as comments and strings, which
    // blanked the remaining 60 lines of the file and hid the JSX in them.
    if (c === '/' && regexCanStartAt(src, i)) {
      let j = i + 1;
      let inClass = false;
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '[') inClass = true;
        else if (src[j] === ']') inClass = false;
        else if (src[j] === '/' && !inClass) break;
        else if (src[j] === '\n') break;
        j++;
      }
      if (j < n && src[j] === '/') {
        blank(i); blank(j);
        for (let k = i + 1; k < j; k++) blank(k);
        i = j + 1;
        continue;
      }
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

/**
 * Is `<` at `k` plausibly a JSX tag rather than a less-than comparison? Shared by
 * the masker and by scanTags, so structure and masking cannot disagree about
 * where a tag begins.
 */
export function isTagAtIn(src, k) {
  const n = src.length;
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
}

/**
 * Every real JSX tag in the file, in source order, with offsets. This is what
 * lets a caller reconstruct nesting — which the ink ladder needs, because an
 * element with no size class of its own inherits the size of the element around
 * it, and "the smaller the text, the more contrast" cannot be applied without
 * knowing what size the text actually is.
 */
export function scanTags(src) {
  const masked = maskSource(src);
  const out = [];
  for (let i = 0; i < masked.length; i++) {
    if (masked[i] !== '<') continue;
    if (!isTagAtIn(src, i)) continue;
    const t = readTag(masked, i);
    if (!t) continue;
    out.push({ start: i, openEnd: t.openEnd, end: t.end, name: t.name, closing: t.closing, selfClosing: t.selfClosing });
    i = t.end - 1;
  }
  return out;
}

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
  /** Depth-0 children with enough detail to tell prose from an icon. */
  const childInfo = [];
  let plain = '';
  if (selfClosing) return { tags, text: false, plain, exprs, childInfo };
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
        if (depth === 0) { tags.push(t.name); childInfo.push(childDetail(masked, t, false)); }
      } else {
        if (depth === 0) { tags.push(t.name); childInfo.push(childDetail(masked, t, true)); }
        depth++;
      }
      i = t.end - 1;
      continue;
    }
    if (depth === 0 && c !== ' ') plain += src[i];
  }
  return { tags, text: /[A-Za-z]/.test(plain), plain: plain.trim(), exprs, childInfo };
}

/**
 * Enough about one child to tell a prose child from an icon child.
 *
 * This matters for containers: `<div className="text-primary/75"><p>…</p></div>`
 * paints that paragraph green through inheritance, so leaving the container
 * green leaves the prose green — which is the thing being fixed. But a container
 * holding only icons should keep its green. The difference is whether any child
 * renders words: a prose tag, a component with children, or a component handed a
 * text-ish prop (`<MatchText content={…} />`).
 */
const TEXT_PROP = /^(?:content|text|label|title|message|body|description|name|value|children)$/;
function childDetail(masked, tag, hasChildren) {
  const props = new Set();
  const start = masked.lastIndexOf('<', tag.openEnd);
  if (start >= 0) {
    for (const m of masked.slice(start, tag.openEnd).matchAll(/([A-Za-z][\w-]*)\s*=/g)) props.add(m[1]);
  }
  return {
    name: tag.name,
    isComponent: /^[A-Z]/.test(tag.name),
    hasChildren,
    selfClosing: tag.selfClosing,
    rendersWords: !/^[A-Z]/.test(tag.name)
      || hasChildren
      || [...props].some((p) => TEXT_PROP.test(p)),
  };
}

/**
 * Is a depth-0 expression snippet number-like rather than prose?
 *
 * Metrics keep the brand green, so this has to recognise the forms a metric
 * actually takes: a raw number, a stat identifier, and the formatting helpers
 * this codebase uses (`fmt(...)`, `.toFixed(2)`, `.toLocaleString()`). Getting
 * this wrong in the other direction is what turned a formatted count into prose
 * in the first pass.
 */
function expressionIsNumberish(expr) {
  const e = expr.trim();
  if (/^[\d\s.,%$+\-*/()]+$/.test(e)) return true;
  // Deliberately NOT `toLocaleString` / `formatAgo`: a timestamp or a relative
  // time is text you read, not a metric you scan. Only real numeric formatting
  // counts, or a timestamp would stay green while the sentence beside it turned
  // white.
  if (/^(?:fmt|num|pct|pctOf|formatNumber|formatCurrency|Math)\s*\(/.test(e)) return true;
  if (/\.(?:toFixed|toPrecision)\s*\(/.test(e)) return true;
  // `cond ? fmt(a) : '—'` is still a metric.
  const parts = e.split('?').map((s) => s.split(':').pop().trim());
  if (parts.length > 1 && parts.every((p) => p === '' || p === "'—'" || p === '"—"' || expressionIsNumberish(p))) return true;
  if (/^[A-Za-z_$][\w$.]*$/.test(e)) {
    const last = e.split('.').pop();
    return NUMBERISH.test(last);
  }
  return false;
}

/** A string literal that carries no words and no digits — a glyph like `✓` or `·`. */
const isGlyph = (expr) => {
  const m = expr.trim().match(/^(['"])(.*)\1$/);
  return Boolean(m) && !/[A-Za-z0-9]/.test(m[2]);
};

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
export function scanElements(src, { pattern = null } = {}) {
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
    // Callers that want a different token family (the ink ladder wants ink, not
    // green) pass their own test; the default keeps this scanner's original job.
    if (pattern) {
      pattern.lastIndex = 0;
      if (!pattern.test(all)) continue;
    } else {
      if (!OCCURRENCE.test(all)) { OCCURRENCE.lastIndex = 0; continue; }
      OCCURRENCE.lastIndex = 0;
    }

    const lt = owningTagStart(masked, m.index);
    const tag = lt >= 0 ? readTag(masked, lt) : null;
    elements.push({
      openStart: lt,
      tag: tag ? tag.name : '?',
      attributed: Boolean(tag),
      dynamic: dynamic || literals.some((l) => l.template && l.interior.includes('${')),
      conflictingLiteral: literals.some((l) => /text-primary/.test(l.interior) && literalHasRival(l.interior)),
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

/**
 * Is the element's content a LABEL produced at runtime, e.g. `{label.toUpperCase()}`?
 *
 * This is the bug Rob named: the literal-capitals test can only see capitals that
 * are in the source, so an uppercase applied at runtime looks like ordinary prose.
 * Alice Stats' stat captions are exactly `{label.toUpperCase()}`, and the rule
 * would have converted them into ink. `text-transform` in a class is handled by
 * the `uppercase` marker; this handles the JS side.
 */
const isRuntimeLabel = (exprs) =>
  exprs.length > 0 && exprs.every((e) => /\.toUpperCase\(\s*\)\s*$/.test(e.trim()));

/** The verdict for one className, before per-occurrence refinements. */
function classify(el) {
  const classes = el.classes;
  const flat = el.tag.toLowerCase();

  if (HEADING_TAGS.has(flat)) return { verdict: 'leave', reason: 'heading-tag' };
  for (const [re, reason] of TITLE_MARKERS) if (classes.some((c) => re.test(c))) return { verdict: 'leave', reason };
  if (classes.some(isTitleSize)) return { verdict: 'leave', reason: 'title-size' };
  if (classes.some((c) => BADGE_MARKER.test(c))) return { verdict: 'leave', reason: 'badge' };

  // Tag reasons come before content reasons, so a `REVERT` button reports that it
  // is a button rather than that it is capitalised — both are true, but only one
  // tells you why it stays green.
  if (ACTION_TAGS.has(flat)) return { verdict: 'leave', reason: 'action-tag' };
  if (EMPHASIS_TAGS.has(flat)) return { verdict: 'leave', reason: 'inline-emphasis' };

  // A form field is judged before the children checks: an `input` renders no
  // children at all, and reading that as "icon or empty" is exactly how a field's
  // text stayed green while everything around it turned white.
  const isField = FIELD_TAGS.has(flat);
  if (!isField && !PROSE_TAGS.has(flat)) return { verdict: 'leave', reason: 'component-host' };

  // A computed className with a rival colour is a STATE pair — `ok ? 'text-primary'
  // : 'text-red-400'` only ever applies one of them — so it converts. A single
  // static class list carrying two colours is a genuine conflict and does not.
  // An existing `text-ink` in a computed list is the exception: converting would
  // collapse the two states into one.
  if (el.conflictingLiteral) return { verdict: 'leave', reason: 'multi-colour' };
  if (el.dynamic && hasInk(classes)) return { verdict: 'leave', reason: 'ink-collision' };

  if (isField) return { verdict: 'convert', reason: null };

  // A label reads as a title whether the capitals come from the class, from the
  // text, or from a `.toUpperCase()` at runtime.
  if (el.kids.text && isLabelCase(el.kids.plain)) return { verdict: 'leave', reason: 'text-capitals' };
  if (isRuntimeLabel(el.kids.exprs)) return { verdict: 'leave', reason: 'runtime-capitals' };

  if (el.selfClosing || (!el.kids.text && !el.kids.exprs.length && !el.kids.tags.length)) {
    return { verdict: 'leave', reason: 'icon-or-empty' };
  }
  // `✓` / `·` / `>` status glyphs are indicators, not words.
  if (!el.kids.text && el.kids.exprs.length && el.kids.exprs.every(isGlyph)) {
    return { verdict: 'leave', reason: 'symbol-content' };
  }
  // A container with nothing of its own still PAINTS its descendants, so the
  // question is whether those descendants render words. `<div class="text-primary/75">
  // <p>…</p></div>` is green prose by inheritance; a div holding only icons is not.
  if (!el.kids.text && !el.kids.exprs.length && el.kids.tags.length) {
    return el.kids.childInfo.some((c) => c.rendersWords)
      ? { verdict: 'convert', reason: null }
      : { verdict: 'leave', reason: 'container-only' };
  }
  if (!el.kids.text && el.kids.exprs.length && el.kids.exprs.every(expressionIsNumberish)) {
    return { verdict: 'leave', reason: 'number-like' };
  }
  if (el.kids.text && !/[A-Za-z]/.test(el.kids.plain)) {
    return { verdict: 'leave', reason: 'number-like' };
  }

  if (!el.attributed) return { verdict: 'leave', reason: 'unattributed' };
  return { verdict: 'convert', reason: null };
}

/**
 * How a variant-qualified occurrence is judged. A `hover:`/`placeholder:` state
 * is an action colour and stays green. An arbitrary DESCENDANT variant is a
 * decision about the descendants, so it follows the same rule one level down:
 * `[&_li]:text-primary` is prose inside a rendered description and converts,
 * while `[&_h2]:text-primary` is a title inside prose and stays green.
 */
function variantVerdict(prefix, tag) {
  if (!prefix) return null;
  // A placeholder is the field's RESTING content — the hint you read before you
  // type — not an interaction state like hover or focus. It is the same text as
  // the value, so it follows the value into ink.
  if (/^placeholder:$/.test(prefix) && FIELD_TAGS.has(String(tag).toLowerCase())) return null;
  const arbitrary = prefix.match(/\[&_([a-z0-9]+)\]:/);
  if (arbitrary) {
    const target = arbitrary[1].toLowerCase();
    if (VARIANT_PROSE_TARGETS.has(target)) return null;            // judge as prose
    return { verdict: 'leave', reason: 'descendant-title' };
  }
  return { verdict: 'leave', reason: 'state-variant' };
}

/**
 * Every `text-primary/N` in the file, exactly once, with a verdict and — when it
 * is left green — the reason.
 */
export function scanSource(src, rel = '') {
  // The Deck is its own theme: the rule refuses it outright, so the boundary does
  // not depend on the sweep remembering to skip it.
  if (rel && isDeckFile(rel)) {
    const raw = new RegExp(OCC_SRC, 'g');
    const out = [];
    let d;
    while ((d = raw.exec(src))) {
      out.push({
        offset: d.index + d[1].length + d[2].length, token: d[3], tag: '?',
        verdict: 'leave', reason: 'deck-own-theme', to: null,
      });
    }
    return out.sort((a, b) => a.offset - b.offset);
  }

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
        if (verdict === 'convert' && variantPrefix) {
          const v = variantVerdict(variantPrefix, el.tag);
          if (v) { verdict = v.verdict; reason = v.reason; }
        }
        claimed[offset] = 1;
        out.push({
          offset, token, tag: el.tag, verdict, reason,
          to: verdict === 'convert' ? token.replace(/^text-primary/, 'text-ink') : null,
        });
      }
    }
  }

  // Anything the element pass did not own still has to be accounted for, or a
  // "complete" sweep is only complete over the part the scanner happened to see.
  const commentMasked = maskSource(src, { commentsOnly: true });
  const bare = new RegExp(OCC_SRC, 'g');
  let b;
  while ((b = bare.exec(src))) {
    const offset = b.index + b[1].length + b[2].length;
    if (claimed[offset]) continue;
    const inComment = commentMasked[offset] === ' ' && src[offset] !== ' ';
    // A className we could not attribute is a FAILURE, not a category.
    const reason = inComment ? 'in-comment'
      : isClassNameLiteral(src, offset) ? 'unattributed'
      : 'class-constant';
    out.push({
      offset, token: b[3], tag: '?', verdict: 'leave', reason, to: null,
      owner: reason === 'class-constant' ? enclosingLiteral(src, offset) : null,
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

/**
 * Every `text-primary` token in the source, bare or shaded, counted the naive
 * way. For the guard's "nothing was skipped" census — the bare form counts too,
 * or the census would under-count and the guard would not notice.
 * `(?![\w-])` keeps `text-primary-foreground` (a different token) out.
 */
export const rawOccurrences = (src) => (src.match(/text-primary(?![\w-])/g) || []).length;
