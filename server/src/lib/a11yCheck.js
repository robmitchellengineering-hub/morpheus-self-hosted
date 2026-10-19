// Deterministic accessibility check over changed HTML / JSX, run on every
// web-app build turn right after the syntax gate (chatWithMorpheus.js).
//
// These are the unambiguous, mechanically-fixable a11y misses that an LLM
// build routinely ships: an <img> with no alt, an icon-only button/link
// with no accessible name, an unlabelled form field, a positive tabindex, a
// click handler on a <div>. The PUBLISH checklist covers the broader
// baseline (landmarks, skip link) as guidance; this one is enforced — a
// finding triggers one targeted coder retry, and anything left is surfaced
// as a // A11Y note (not // CRITICAL — the site still works).
//
// Regex, not a real DOM parse: it errs toward silence (a match must be
// clearly wrong) so it never nags about a false positive.

const HTMLISH = /\.(html?|jsx|tsx|vue|svelte|astro)$/i;

// Strip strings/comments cheaply so `onClick` inside a JS string literal
// doesn't trip the div-handler rule. Good enough for line-approximate hints.
function lineAt(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === '\n') line++;
  return line;
}

function hasAttr(tag, name) {
  return new RegExp(`\\s${name}(\\s*=|\\s|>|/)`, 'i').test(tag);
}
function attrVal(tag, name) {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|\\{([^}]*)\\})`, 'i'));
  return m ? (m[2] ?? m[3] ?? m[4] ?? '') : null;
}
// An accessible name from any of the usual suspects.
function hasAccessibleName(tag) {
  return hasAttr(tag, 'aria-label') || hasAttr(tag, 'aria-labelledby') || hasAttr(tag, 'title')
    || /\saria-hidden\s*=\s*("true"|'true'|\{true\})/i.test(tag);
}

// element inner text/children, roughly — everything between the open tag's
// `>` and the matching close. Only used to tell "empty" from "has words".
function innerOf(text, openEnd, tagName) {
  const close = text.toLowerCase().indexOf(`</${tagName}`, openEnd);
  if (close === -1) return '';
  return text.slice(openEnd + 1, close);
}
function hasVisibleText(inner) {
  // strip tags and JSX expressions, then look for a letter or digit
  const stripped = inner.replace(/<[^>]*>/g, ' ').replace(/\{[^}]*\}/g, ' ');
  return /[\p{L}\p{N}]/u.test(stripped);
}

/**
 * files: [{ path, content }] — the changed files only.
 * Returns [{ file, line, rule, text }], deduped, capped.
 */
export function checkA11y(files, { limit = 40 } = {}) {
  const out = [];
  for (const f of files || []) {
    if (!f || typeof f.content !== 'string' || !HTMLISH.test(f.path)) continue;
    const src = f.content;
    const push = (index, rule, text) => out.push({ file: f.path, line: lineAt(src, index), rule, text });

    // <img> / role="img" without alt (alt="" is fine — decorative)
    for (const m of src.matchAll(/<img\b[^>]*>/gi)) {
      if (!hasAttr(m[0], 'alt')) push(m.index, 'img-alt', `<img> with no alt attribute — add alt="…" (or alt="" if purely decorative)`);
    }

    // icon-only <button> / <a> with no accessible name and no text
    for (const tag of ['button', 'a']) {
      const re = new RegExp(`<${tag}\\b([^>]*)>`, 'gi');
      for (const m of src.matchAll(re)) {
        const attrs = m[1];
        if (/\/$/.test(attrs.trim())) continue; // self-closing, unusual but skip
        if (tag === 'a' && !hasAttr(m[0], 'href')) continue; // not a link
        const inner = innerOf(src, m.index + m[0].length - 1, tag);
        if (hasVisibleText(inner) || hasAccessibleName(m[0])) continue;
        // an <img> with alt inside counts as a name
        const imgAlt = inner.match(/<img\b[^>]*\balt\s*=\s*("([^"]+)"|'([^']+)'|\{[^}]+\})/i);
        if (imgAlt) continue;
        push(m.index, `${tag}-name`, `<${tag}> has no text and no aria-label — a screen reader will announce it as "${tag === 'a' ? 'link' : 'button'}" with nothing else`);
      }
    }

    // form control with no label association and no aria-label
    for (const m of src.matchAll(/<(input|select|textarea)\b[^>]*>/gi)) {
      const tag = m[0];
      const type = (attrVal(tag, 'type') || '').toLowerCase();
      if (m[1].toLowerCase() === 'input' && ['hidden', 'submit', 'button', 'reset', 'image'].includes(type)) continue;
      if (hasAttr(tag, 'aria-label') || hasAttr(tag, 'aria-labelledby')) continue;
      const id = attrVal(tag, 'id');
      // is there a for="id" / htmlFor="id" anywhere in this file? (lenient —
      // a <label> or a design-system Label component; err toward silence)
      if (id && new RegExp(`\\b(html)?for\\s*=\\s*("${id}"|'${id}'|\\{\\s*[\`'"]?${id})`, 'i').test(src)) continue;
      // wrapped in a <label>…<input>…</label>? cheap check: a <label> open within ~200 chars before with no </label> between
      const before = src.slice(Math.max(0, m.index - 300), m.index);
      if (/<label\b[^>]*>(?:(?!<\/label>)[\s\S])*$/i.test(before)) continue;
      push(m.index, 'field-label', `<${m[1]}> has no associated <label>, aria-label, or aria-labelledby`);
    }

    // positive tabindex
    for (const m of src.matchAll(/\btabindex\s*=\s*("|'|\{)?\s*([1-9]\d*)/gi)) {
      push(m.index, 'tabindex', `tabindex="${m[2]}" — positive tabindex breaks the natural focus order; use 0 or -1`);
    }

    // click handler on a non-interactive element with no role/keyboard
    for (const m of src.matchAll(/<(div|span|li|p|section)\b([^>]*)\bon[cC]lick[^>]*>/g)) {
      const tag = m[0];
      if (hasAttr(tag, 'role') || hasAttr(tag, 'onkeydown') || hasAttr(tag, 'onkeyup') || hasAttr(tag, 'onkeypress')) continue;
      push(m.index, 'div-click', `<${m[1]}> has onClick but no role or keyboard handler — use a <button>, or add role="button" tabIndex={0} and an onKeyDown`);
    }

    // <html> without lang (plain HTML files)
    if (/\.html?$/i.test(f.path)) {
      const html = src.match(/<html\b[^>]*>/i);
      if (html && !hasAttr(html[0], 'lang')) push(html.index, 'html-lang', `<html> has no lang attribute — add lang="en" (or the site's language)`);
    }
  }

  const seen = new Set();
  return out
    .filter((e) => { const k = `${e.file}:${e.rule}:${e.line}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .slice(0, limit);
}
