// Suggest internal links for one page on the operator's own site.
//
// This is the other thing Yoast charges Premium for. It only PROPOSES: the
// panel reviews each link (anchor, target, why) and applying goes through the
// plugin's bulk_add_links, which wraps a phrase that already exists in the
// page's own text. Nothing is written here.
//
// The grounding comes from the site, not the client: the page text is read
// from WordPress, so an anchor cannot be validated against text the caller made
// up, and the candidate URLs are the site's real permalinks — a fabricated
// internal URL is a 404 in a customer's face.
import { prisma } from '../db.js';
import { invokeAI } from '../ai.js';
import { getWpConnection, wpSeo } from '../lib/wpPlugin.js';
import { getDeckBusinessContext } from '../lib/deckBusinessProfile.js';
import {
  buildLinkPrompt, LINK_SCHEMA, normalizeLinkSuggestions,
  MAX_GROUNDING_CHARS, MAX_INTERNAL_LINKS, blockText, oneLine,
} from '../lib/seoPrompts.js';

export default async function handler({ user, body }) {
  const projectId = body?.projectId;
  const id = Number(body?.id);
  if (!projectId) throw Object.assign(new Error('projectId required'), { status: 400 });
  if (!Number.isInteger(id) || id <= 0) throw Object.assign(new Error('Pick a page to suggest links for.'), { status: 400 });

  const project = await prisma.project.findFirst({ where: { id: projectId, created_by_id: user.id }, select: { name: true, description: true } });
  if (!project) throw Object.assign(new Error('Project not found'), { status: 404 });

  const conn = await getWpConnection(projectId, user.id);
  if (!conn) throw Object.assign(new Error('No WordPress site connected — connect one in the SETUP panel first.'), { status: 400 });

  // The page's real text (this is what an anchor must be copied from) and the
  // site's real content list (this is the only set of legal targets).
  const [readRes, listRes, businessCtx] = await Promise.all([
    wpSeo(conn, 'read_content', { id, chars: MAX_GROUNDING_CHARS }),
    wpSeo(conn, 'list_content', { limit: 60 }),
    getDeckBusinessContext(user.id).catch(() => ''),
  ]);
  if (readRes.status === 0 || listRes.status === 0) {
    throw Object.assign(new Error(`Could not reach ${conn.siteUrl} — ${readRes.error || listRes.error || 'no response'}`), { status: 502 });
  }
  if (!(readRes.ok && readRes.data?.ok && readRes.data.item)) {
    // read_content needs plugin 0.5.1+. Saying which piece is missing beats a
    // generic failure the operator cannot act on.
    throw Object.assign(new Error('Could not read that page\'s text — the site\'s Morpheus plugin may need updating from the SETUP tab.'), { status: 409 });
  }

  const item = readRes.data.item;
  const content = blockText(item.content_text, MAX_GROUNDING_CHARS);
  if (content.length < 40) {
    throw Object.assign(new Error('That page has almost no text to link from — write some content first.'), { status: 422 });
  }

  const all = Array.isArray(listRes.data?.items) ? listRes.data.items : [];
  const self = String(item.url || '').replace(/\/+$/, '');
  const candidates = all
    .filter((c) => c && c.url && c.status === 'publish' && String(c.url).replace(/\/+$/, '') !== self)
    .slice(0, MAX_INTERNAL_LINKS)
    .map((c) => ({ title: oneLine(c.title, 120), url: c.url, type: c.type }));

  if (candidates.length === 0) {
    return { links: [], dropped: [], considered: 0, title: item.title, note: 'There is nothing else published on the site to link to yet.' };
  }

  const business = [businessCtx, project.description].filter(Boolean).join(' — ');
  const prompt = buildLinkPrompt({ business, title: item.title, url: item.url, content, candidates });

  const { result } = await invokeAI({
    userId: user.id,
    prompt,
    schema: LINK_SCHEMA,
    role: 'diagnosis',
    maxTokens: 1500,
  });

  const { links, dropped } = normalizeLinkSuggestions(result, { content, pageUrl: item.url, candidates });

  return {
    links,
    // Reported rather than hidden: "3 of 6 suggestions were discarded because
    // the phrase is not in your text" is the honest version of showing 3.
    dropped,
    considered: candidates.length,
    title: oneLine(item.title, 200),
    url: item.url,
  };
}
