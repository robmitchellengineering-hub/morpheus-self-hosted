// Generate SEO titles, meta descriptions and focus keywords for content that
// is ALREADY on the operator's live site.
//
// This only proposes. Nothing is written here — the operator reviews the batch
// in the SEO panel and applies it, which goes back through wordPressSeoAction's
// set_seo / bulk_set_seo. Generated metadata is published straight into search
// results, so a human look before it lands is the right default, and the
// review step is what makes the batch worth generating in the first place.
//
// Grounding is deliberately fetched from the site, not trusted from the client:
// the caller sends ids, and the titles and page text come from the plugin. A
// caller cannot rewrite somebody else's page by posting a fabricated title,
// and the model can only work from text that is actually published.
import { prisma } from '../db.js';
import { invokeAI } from '../ai.js';
import { getWpConnection, wpSeo } from '../lib/wpPlugin.js';
import { getDeckBusinessContext } from '../lib/deckBusinessProfile.js';
import { getBrand } from '../lib/projectBrand.js';
import {
  buildSeoPrompt, SEO_SCHEMA, normalizeSuggestions,
  MAX_BATCH, MAX_GROUNDING_CHARS, oneLine, blockText,
  seoCallMaxTokens, mergeSeoSuggestions, generateSeoInChunks,
} from '../lib/seoPrompts.js';

/** Grounding for one item: its real title, current fields and (0.5.1+) its text. */
async function loadItem(conn, id) {
  const base = { id, type: null, title: '', url: '', existing_title: '', existing_description: '', focus_keyword: '', word_count: 0, excerpt: '', content_text: '' };

  // read_content is the direct route to the body. A plugin older than 0.5.1
  // doesn't have it — the SEO module itself is 0.5.0, so this is a version
  // that can still be driven, just with less to work from.
  const read = await wpSeo(conn, 'read_content', { id, chars: MAX_GROUNDING_CHARS });
  if (read.ok && read.data?.ok && read.data.item) {
    const it = read.data.item;
    return {
      ...base,
      type: it.type || null,
      title: oneLine(it.title, 200),
      url: it.url || '',
      excerpt: blockText(it.excerpt, 400),
      content_text: blockText(it.content_text, MAX_GROUNDING_CHARS),
      word_count: Number(it.word_count) || 0,
      grounded: !!it.content_text,
    };
  }

  const seo = await wpSeo(conn, 'get_seo', { id });
  if (!(seo.ok && seo.data?.ok && seo.data.item)) {
    return { ...base, grounded: false, unreachable: seo.status === 0 };
  }
  const it = seo.data.item;
  return {
    ...base,
    type: it.type || null,
    title: oneLine(it.effective_title || it.title, 200),
    url: it.url || '',
    existing_title: oneLine(it.seo_title, 200),
    existing_description: blockText(it.seo_description, 400),
    focus_keyword: oneLine(it.focus_keyword, 60),
    grounded: false,
  };
}

export default async function handler({ user, body }) {
  const projectId = body?.projectId;
  if (!projectId) throw Object.assign(new Error('projectId required'), { status: 400 });

  // Accept ids, or item objects carrying ids — the panel holds list rows, and
  // forcing it to unwrap them first would buy nothing.
  const raw = Array.isArray(body?.items) ? body.items : [];
  const ids = [];
  for (const entry of raw) {
    const n = typeof entry === 'number' ? entry : Number(entry?.id);
    if (Number.isInteger(n) && n > 0 && !ids.includes(n)) ids.push(n);
  }
  if (ids.length === 0) throw Object.assign(new Error('Pick at least one page or post to generate for.'), { status: 400 });
  if (ids.length > MAX_BATCH) throw Object.assign(new Error(`Generate for at most ${MAX_BATCH} items at a time (${ids.length} asked for).`), { status: 400 });

  const project = await prisma.project.findFirst({
    where: { id: projectId, created_by_id: user.id },
    select: { name: true, description: true },
  });
  if (!project) throw Object.assign(new Error('Project not found'), { status: 404 });

  const conn = await getWpConnection(projectId, user.id);
  if (!conn) throw Object.assign(new Error('No WordPress site connected — connect one in the SETUP panel first.'), { status: 400 });

  // What the model is told about the business: Settings → Business profile, the
  // project's own description, and the brand voice if a brand kit exists. This
  // is the same context every other Jarvis prompt uses, so the SEO panel works
  // for any account rather than being written around one business.
  const [businessCtx, brand, ctxRes] = await Promise.all([
    getDeckBusinessContext(user.id).catch(() => ''),
    getBrand(projectId).catch(() => null),
    wpSeo(conn, 'context', {}),
  ]);
  if (ctxRes.status === 0) {
    throw Object.assign(new Error(`Could not reach ${conn.siteUrl} — ${ctxRes.error || 'no response'}`), { status: 502 });
  }
  const seoContext = ctxRes.ok && ctxRes.data?.ok ? ctxRes.data : null;

  const items = [];
  for (const id of ids) {
    // Sequential on purpose: each call is a signed round trip to the operator's
    // own site, and a burst of parallel requests at a shared WordPress host is
    // a good way to get rate-limited. 25 items is the cap.
    // eslint-disable-next-line no-await-in-loop
    items.push(await loadItem(conn, id));
  }
  const usable = items.filter((it) => it.title || it.content_text);
  if (usable.length === 0) {
    throw Object.assign(new Error('Could not read those items from your site — check the connection and try again.'), { status: 502 });
  }

  const business = [businessCtx, project.description].filter(Boolean).join(' — ');
  const site = seoContext
    ? {
        site_title: seoContext.site_title,
        tagline: seoContext.tagline,
        owns_head: seoContext.owns_head,
        active_plugin: seoContext.active_plugin,
      }
    : null;

  // One model call per chunk, and a chunk that comes back truncated is halved
  // rather than failing the request — one verbose page must not cost the
  // operator the other 24. seoCallMaxTokens pays the model's hidden reasoning out
  // of a floor first; the previous single call for the whole batch sized its cap
  // from the JSON alone, so a 25-item batch died with OUTPUT_TRUNCATED before it
  // returned anything.
  const askChunk = async (chunk) => {
    const prompt = buildSeoPrompt({ business, brandVoice: brand?.voice || '', site, items: chunk });
    const { result } = await invokeAI({
      userId: user.id,
      prompt,
      schema: SEO_SCHEMA,
      role: 'diagnosis',
      maxTokens: seoCallMaxTokens(chunk.length),
    });
    return Array.isArray(result?.suggestions) ? result.suggestions : [];
  };

  // The split/retry loop lives in seoPrompts so the guard can drive every branch
  // with a fake asker. A single item that still truncates has nothing left to
  // split, so it names the item instead of leaking ai.js's "files per step".
  const rawSuggestions = await generateSeoInChunks(usable, askChunk, {
    onGiveUp: (item) => Object.assign(
      new Error(`The model ran out of output budget writing metadata for "${oneLine(item?.title, 60) || `item ${item?.id}`}". Try that row's own Generate button, or shorten the page and retry.`),
      { status: 502 },
    ),
  });

  const suggestions = normalizeSuggestions(
    { suggestions: mergeSeoSuggestions(rawSuggestions) },
    usable,
  ).map((s) => {
    const src = usable.find((it) => it.id === s.id) || {};
    return { ...s, type: src.type, url: src.url, grounded: !!src.grounded };
  });

  if (suggestions.length === 0) {
    throw Object.assign(new Error('The model returned nothing usable — try again, or generate for fewer items.'), { status: 502 });
  }

  // What was actually read, so the UI can be honest about weak grounding
  // (title-only suggestions are marked as such rather than presented as if the
  // model had read the page).
  return {
    suggestions,
    requested: ids.length,
    generated: suggestions.length,
    missing: ids.filter((id) => !suggestions.some((s) => s.id === id)),
    title_only: suggestions.filter((s) => !s.grounded).length,
    owns_head: seoContext?.owns_head ?? null,
    active_plugin: seoContext?.active_plugin ?? null,
  };
}
