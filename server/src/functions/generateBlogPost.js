// Draft a blog post for the operator's own site, grounded in their business
// context and in the pages they already have.
//
// Nothing is published here. The panel shows the draft, the operator edits it,
// and creating it goes through the Store module's create_post as a DRAFT —
// which is the same rule every other content path in this app follows (a new
// product, a new page and a new post are all drafts until the operator
// publishes them). An AI-written post appearing live on a business's site
// unread is not a feature.
//
// Internal linking is offered with the site's REAL urls and the prompt is told
// not to invent one — a fabricated internal link on a live site is a 404 in a
// customer's face. That is also, incidentally, the part Yoast sells as Premium.
import { prisma } from '../db.js';
import { invokeAI } from '../ai.js';
import { getWpConnection, wpSeo } from '../lib/wpPlugin.js';
import { getDeckBusinessContext } from '../lib/deckBusinessProfile.js';
import { getBrand } from '../lib/projectBrand.js';
import { buildBlogPrompt, BLOG_SCHEMA, normalizeBlogDraft, MAX_INTERNAL_LINKS, oneLine } from '../lib/seoPrompts.js';

export default async function handler({ user, body }) {
  const projectId = body?.projectId;
  if (!projectId) throw Object.assign(new Error('projectId required'), { status: 400 });

  const project = await prisma.project.findFirst({
    where: { id: projectId, created_by_id: user.id },
    select: { name: true, description: true },
  });
  if (!project) throw Object.assign(new Error('Project not found'), { status: 404 });

  const conn = await getWpConnection(projectId, user.id);
  if (!conn) throw Object.assign(new Error('No WordPress site connected — connect one in the SETUP panel first.'), { status: 400 });

  const [businessCtx, brand, ctxRes, listRes] = await Promise.all([
    getDeckBusinessContext(user.id).catch(() => ''),
    getBrand(projectId).catch(() => null),
    wpSeo(conn, 'context', {}),
    wpSeo(conn, 'list_content', { limit: 60 }),
  ]);
  if (ctxRes.status === 0 || listRes.status === 0) {
    throw Object.assign(new Error(`Could not reach ${conn.siteUrl} — ${ctxRes.error || listRes.error || 'no response'}`), { status: 502 });
  }
  const seoContext = ctxRes.ok && ctxRes.data?.ok ? ctxRes.data : null;

  // Published content only: linking a customer to a draft is a broken link for
  // everyone except the operator.
  const existing = (listRes.ok && Array.isArray(listRes.data?.items) ? listRes.data.items : [])
    .filter((it) => it.status === 'publish' && it.url)
    .slice(0, MAX_INTERNAL_LINKS)
    .map((it) => ({ title: oneLine(it.title, 90), url: it.url, type: it.type }));

  const business = [businessCtx, project.description].filter(Boolean).join(' — ');
  const prompt = buildBlogPrompt({
    business,
    brandVoice: brand?.voice || '',
    site: seoContext
      ? {
          site_title: seoContext.site_title,
          tagline: seoContext.tagline,
          owns_head: seoContext.owns_head,
          active_plugin: seoContext.active_plugin,
        }
      : null,
    topic: body?.topic,
    keywords: body?.keywords,
    tone: body?.tone,
    words: body?.words,
    existing,
  });

  const { result } = await invokeAI({
    userId: user.id,
    prompt,
    schema: BLOG_SCHEMA,
    role: 'diagnosis',
    maxTokens: 8000,
  });

  const normalized = normalizeBlogDraft(result);
  if (!normalized) {
    throw Object.assign(new Error('The model returned an empty draft — try again, or give it a topic.'), { status: 502 });
  }

  return {
    draft: normalized.draft,
    warnings: normalized.warnings,
    // Surfaced so the panel can say "linked to 3 of your existing pages" and the
    // operator can see whether the links the model used are ones they recognise.
    linkable: existing.length,
  };
}
