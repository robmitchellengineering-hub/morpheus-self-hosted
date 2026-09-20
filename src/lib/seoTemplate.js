// Site-wide title/description templates — the token list and a display-only
// resolver.
//
// WHY DISPLAY-ONLY: the authoritative substitution happens in PHP
// (Morpheus_SEO::apply_template), because that is where the post body, the
// excerpt and the site's own title actually live — and because the value that
// gets WRITTEN to an item must be produced by the same code that would
// otherwise emit it. This module exists so the settings screen can show the
// operator an example of what a template produces while they type it, and so
// the token list has one home on the JS side.
//
// A preview that quietly disagreed with the thing doing the work would be worse
// than no preview, so scripts/verify-seo.mjs asserts TEMPLATE_TOKENS here
// against Morpheus_SEO::TEMPLATE_TOKENS in the plugin.

export const TEMPLATE_TOKENS = ['%title%', '%sitename%', '%tagline%', '%excerpt%', '%content%'];

/** What each token means, for the UI's help text. */
export const TOKEN_HELP = {
  '%title%': 'the page or post title',
  '%sitename%': 'your site name',
  '%tagline%': 'your site tagline',
  '%excerpt%': 'the excerpt — the first words of the content if there is none',
  '%content%': 'the opening words of the content',
};

/** Insert a token where the operator's cursor is, or append it. */
export function insertToken(value, token, selectionStart = null, selectionEnd = null) {
  const s = String(value ?? '');
  const at = typeof selectionStart === 'number' && selectionStart >= 0 ? selectionStart : s.length;
  const end = typeof selectionEnd === 'number' && selectionEnd >= at ? selectionEnd : at;
  return s.slice(0, at) + token + s.slice(end);
}

/**
 * Substitute tokens for display. Unknown tokens are REMOVED (matching the
 * plugin), so an example never shows a literal %category% that a live title
 * would not contain.
 *
 * `contentPlaceholder` is shown where %content% appears, since the client has
 * no body text for an item — the UI labels the whole block as an example.
 */
export function resolveTemplate(template, vars = {}, contentPlaceholder = 'the opening words of the page') {
  const map = {
    '%title%': vars.title || '',
    '%sitename%': vars.siteName || '',
    '%tagline%': vars.tagline || '',
    '%excerpt%': vars.excerpt || vars.content || contentPlaceholder,
    '%content%': vars.content || contentPlaceholder,
  };
  return String(template ?? '')
    .replace(/%[a-z_]+%/gi, (m) => (Object.prototype.hasOwnProperty.call(map, m.toLowerCase()) ? map[m.toLowerCase()] : ''))
    .replace(/\s+/g, ' ')
    .trim();
}
