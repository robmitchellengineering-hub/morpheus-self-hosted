// CANONICAL COPY — server/src/lib/inkLadder.js
//
// The ink ladder rule itself. Moved from scripts/lib/ink-ladder.mjs so the server
// can run it in-loop against the workspace (see verify.js); scripts/lib/ink-ladder.mjs
// is now a re-export of this file.
//
// Pure: imports only ./proseInk.js, reads no files, does no I/O.
//
// The ink ladder, as one dependency-free implementation.
//
// WHY THIS EXISTS
//
// Rob, 2026-09-23: "the gradients of brightness of the white text need to start
// from the brightest as in the level of the biggest white title should be set as
// the dullest setting and go up from there". The old habit dimmed text as it got
// SMALLER, which is backwards — WCAG asks 3:1 of large text and 4.5:1 of small, so
// the small text is what needs the contrast. Hence:
//
//   text-ink         the FLOOR — the dullest any text may be. 14px and up.
//   text-ink-strong  more contrast — 12–13px.
//   text-ink-max     the most contrast the theme has — 11px and below.
//
// "Max" is maximum CONTRAST, not maximum brightness, which is why the light theme
// resolves it to black and the rule survives every theme block.
//
// THE TWO THINGS THIS MODULE DECIDES
//
//  1. An opacity modifier on ink is forbidden outright. `text-ink/40` can only be
//     dimmer than the floor, and the floor is the one thing that may not be
//     crossed. Every one of them goes, including `placeholder:text-ink/30` and
//     arbitrary/state variants — the modifier is removed and the rung is set from
//     the size.
//  2. The rung follows the size. An element with no size class of its own inherits
//     one from the element around it, so the size is resolved by walking up the
//     JSX tree. Where no ancestor declares a size either — the size comes from a
//     component in another file, or from the base layer — the floor is used, which
//     is the safe direction (nothing ends up duller than ink) and those are
//     counted and reported rather than guessed.
//
// Dependency-free for the same reason as prose-ink.mjs: the CI guards job runs
// without `npm install` (verify-guards-no-install.mjs).

import { scanElements, scanTags, maskSource } from './proseInk.js';

/** The rungs, dullest first. `max` is the most contrast, not the brightest. */
export const RUNGS = ['text-ink', 'text-ink-strong', 'text-ink-max'];
export const RUNG_FOR = { ink: 'text-ink', strong: 'text-ink-strong', max: 'text-ink-max' };
/** A ≤11px, B 12–13px, C ≥14px. */
export const BAND_CEILING = { max: 11, strong: 13 };

const NAMED_PX = {
  xs: 12, sm: 14, base: 16, lg: 18, xl: 20,
  '2xl': 24, '3xl': 30, '4xl': 36, '5xl': 48, '6xl': 60, '7xl': 72, '8xl': 96, '9xl': 128,
};

/**
 * The pixel size a `text-*` utility asks for, or null when the class is not a
 * size. Variant-qualified sizes (`md:text-base`) count, because a responsive
 * class is still a size the text will take.
 */
export function sizePx(cls) {
  const m = String(cls).match(/^(?:[a-z-]+:)*text-(.+)$/);
  if (!m) return null;
  const v = m[1];
  if (NAMED_PX[v] !== undefined) return NAMED_PX[v];
  const arb = v.match(/^\[(\d*\.?\d+)(px|rem|em)\]$/);
  if (arb) {
    const n = Number(arb[1]);
    return arb[2] === 'px' ? n : n * 16;
  }
  return null;
}

/** The smallest size declared on an element — the smaller text wins the contrast. */
export function smallestPx(classes) {
  const sizes = classes.map(sizePx).filter((n) => n !== null);
  return sizes.length ? Math.min(...sizes) : null;
}

/** The band for a size. No size at all resolves to the floor, never below it. */
export function bandForPx(px) {
  if (px === null) return 'ink';
  if (px <= BAND_CEILING.max) return 'max';
  if (px <= BAND_CEILING.strong) return 'strong';
  return 'ink';
}

/** An ink token: `text-ink`, `text-ink-strong`, `text-ink-max`, each ± `/<n>`. */
const INK_TOKEN = /(^|[\s'"`])((?:\[[^\]]*\]:|[a-z-]+:)*)(text-ink(?:-strong|-max)?(?![\w-])(?:\/\d+)?)/g;
/** `opacity-*` utilities that dim a whole element rather than its colour token. */
const OPACITY_UTIL = /^opacity-(?!100$)(\d+)$/;

/** `text-ink` -> 'ink', `text-ink-strong` -> 'strong', `text-ink/40` -> 'ink'. */
export function rungOf(token) {
  const base = token.replace(/\/\d+$/, '');
  if (base === 'text-ink-strong') return 'strong';
  if (base === 'text-ink-max') return 'max';
  return 'ink';
}
export const hasOpacityModifier = (token) => /\/\d+$/.test(token);

/**
 * Every ink token in the file with its resolved band, and whether it conforms.
 *
 * Returns occurrences plus two report-only lists: elements that DIM text with an
 * `opacity-*` utility (which no token-level rule can see), and ink tokens that
 * live in a class constant (where there is no element to read a size from).
 */
export function scanLadder(src) {
  // EVERY className element, not just the ink ones: an element with no size of
  // its own has to read the size off an ancestor, and that ancestor usually has
  // no ink token at all. Filtering to ink here is what made an inherited size
  // look unresolvable.
  const elements = scanElements(src, { pattern: /[\s\S]/g });
  const tags = scanTags(src);

  // nesting: open tag start -> parent open tag start
  const parentOf = new Map();
  const open = [];
  for (const t of tags) {
    if (t.closing) { open.pop(); continue; }
    parentOf.set(t.start, open.length ? open[open.length - 1] : null);
    if (!t.selfClosing) open.push(t.start);
  }
  const elByOpen = new Map(elements.filter((e) => e.openStart !== null && e.openStart !== undefined)
    .map((e) => [e.openStart, e]));

  const hopCache = new Map();
  const resolve = (openStart) => {
    if (hopCache.has(openStart)) return hopCache.get(openStart);
    let cur = openStart;
    let hops = 0;
    let result = { band: 'ink', px: null, from: null };
    while (cur !== null && cur !== undefined && hops++ < 100) {
      const el = elByOpen.get(cur);
      if (el) {
        const px = smallestPx(el.classes);
        if (px !== null) { result = { band: bandForPx(px), px, from: el.tag }; break; }
      }
      cur = parentOf.get(cur);
    }
    hopCache.set(openStart, result);
    return result;
  };

  const occurrences = [];
  const dimmed = [];
  const constants = [];
  const claimed = new Uint8Array(src.length);

  for (const el of elements) {
    for (const lit of el.literals) {
      INK_TOKEN.lastIndex = 0;
      let m;
      while ((m = INK_TOKEN.exec(lit.interior))) {
        const offset = lit.start + m.index + m[1].length + m[2].length;
        const token = m[3];
        const resolved = resolve(el.openStart);
        claimed[offset] = 1;
        occurrences.push({
          offset, token, prefix: m[2], tag: el.tag,
          band: resolved.band, px: resolved.px, sizeFrom: resolved.from,
          rung: rungOf(token), dim: hasOpacityModifier(token),
          to: RUNG_FOR[resolved.band],
          unresolved: resolved.px === null,
        });
      }
    }
    // an `opacity-*` utility dims the whole element; no colour token can see it
    const dimmer = el.classes.find((c) => OPACITY_UTIL.test(c));
    if (dimmer && el.classes.some((c) => /^text-(ink|ink-strong|ink-max|primary)(?![\w-])/.test(c))) {
      dimmed.push({ offset: el.rangeStart, tag: el.tag, util: dimmer, cls: el.classes.join(' ').slice(0, 120) });
    }
  }

  // Ink NOT on an element: a class string in a constant, which has no size to read
  // and cannot be judged by a token-level rule. Comments are excluded — a token in
  // a comment renders nothing. Scanned over the whole file rather than only the
  // className literals, because that is exactly where a constant hides: the first
  // pass missed both `const faint = 'text-ink/30'` declarations for that reason.
  const commentMasked = maskSource(src, { commentsOnly: true });
  INK_TOKEN.lastIndex = 0;
  let c;
  while ((c = INK_TOKEN.exec(src))) {
    const offset = c.index + c[1].length + c[2].length;
    if (claimed[offset]) continue;
    const inComment = commentMasked[offset] === ' ' && src[offset] !== ' ';
    if (inComment) continue;
    constants.push({ offset, token: c[3] });
  }

  return { occurrences: occurrences.sort((a, b) => a.offset - b.offset), dimmed, constants };
}

/** Apply the ladder by exact offset: the token is replaced, its prefix untouched. */
export function applyLadder(src, occurrences) {
  let out = src;
  for (const o of [...occurrences].reverse()) {
    if (o.token === o.to) continue;
    out = out.slice(0, o.offset) + o.to + out.slice(o.offset + o.token.length);
  }
  return out;
}
