// How a page's title and description will read in a search result.
//
// WHY THIS EXISTS: writing metadata is guesswork without seeing it. A title of
// 58 characters and one of 68 look nearly identical in a form, and the second
// one is the one that gets cut off mid-phrase in results — which is exactly the
// thing the length guidelines exist to prevent. The operator editing this on a
// phone needs to SEE the truncation, not count characters.
//
// These limits mirror the plugin's own guidance (TITLE_MAX / DESC_MAX in
// includes/seo/class-seo.php) and are passed in from the live site's context
// when available, so the two can't silently disagree.
//
// HONESTY: this is an approximation, not a promise. Google rewrites snippets
// and truncates by rendered pixel width, not character count, and the real
// result page varies by query and device. The UI says so.

export const SERP_TITLE_MAX = 60;
export const SERP_DESC_MAX = 160;

/**
 * Truncate on a word boundary at or before `max`, adding an ellipsis only when
 * something was actually removed. Cutting mid-word ("Guitar Repairs in Melbou…")
 * is what search engines do; a writer previewing their own text should see the
 * last whole word they get to keep.
 */
export function truncateAtWord(text, max) {
  const s = String(text ?? '').trim();
  if (max <= 0) return { text: '', truncated: s.length > 0 };
  if (s.length <= max) return { text: s, truncated: false };
  const cut = s.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  // Only fall back to a hard cut when there is no usable word boundary — a
  // single long token ("Supercalifragilistic…") still has to be shortened.
  const head = lastSpace > max * 0.5 ? cut.slice(0, lastSpace) : cut;
  return { text: head.replace(/[\s,;:.\-–—]+$/, '') + '…', truncated: true };
}

/**
 * A readable breadcrumb for the result URL: host without the scheme/www, then
 * the path segments as written (a search engine shows a simplified path, but
 * showing the real one is more useful — it is the URL the reader lands on).
 */
export function serpBreadcrumb(url) {
  const raw = String(url ?? '').trim();
  if (!raw) return '';
  try {
    const u = new URL(raw);
    const host = u.host.replace(/^www\./, '');
    const path = u.pathname.replace(/\/+$/, '');
    return host + path.replace(/\//g, ' › ');
  } catch {
    return raw;
  }
}

/**
 * @param {{title?:string, description?:string, url?:string, titleFallback?:string,
 *          descriptionFallback?:string, titleMax?:number, descMax?:number}} input
 * @returns {{title:string, titleTruncated:boolean, description:string,
 *            descriptionTruncated:boolean, breadcrumb:string,
 *            usedFallback:boolean}}
 */
export function serpPreview({
  title = '',
  description = '',
  url = '',
  titleFallback = '',
  descriptionFallback = '',
  titleMax = SERP_TITLE_MAX,
  descMax = SERP_DESC_MAX,
} = {}) {
  // What goes out when the field is empty is the derived value (the post title,
  // the excerpt) — the preview must show THAT, or an empty field would look
  // like an empty search result when it isn't one.
  const effectiveTitle = String(title || '').trim() || String(titleFallback || '').trim();
  const effectiveDesc = String(description || '').trim() || String(descriptionFallback || '').trim();
  const t = truncateAtWord(effectiveTitle, titleMax);
  const d = truncateAtWord(effectiveDesc, descMax);
  return {
    title: t.text,
    titleTruncated: t.truncated,
    description: d.text,
    descriptionTruncated: d.truncated,
    breadcrumb: serpBreadcrumb(url),
    usedFallback: !String(title || '').trim() || !String(description || '').trim(),
  };
}
