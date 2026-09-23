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
import { estimateCallMs } from '../lib/timingStats.js';
import {
  buildSeoPrompt, SEO_SCHEMA, normalizeSuggestions, SEO_AI_ROLE, SEO_ITEMS_PER_CALL,
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

/**
 * The SEO batch, streamed.
 *
 * WHY (2026-09-23, Rob: the first batch of 5 started, the timer ran, the ETA
 * never appeared, then "Failed to fetch")
 *
 * The panel slices the batch, so one request is meant to be one model call. It
 * was not: this handler read the site, then held the connection in TOTAL silence
 * for as long as the model took — up to AI_FETCH_TIMEOUT_MS (180s) — and answered
 * with one JSON blob at the end. Nothing flowed, so nothing proved the connection
 * was alive, and the ingress in front of Express cut it. Because CORS is added BY
 * Express, a request cut before Express answers arrives with no CORS headers, and
 * the browser can only report the bare "Failed to fetch" — which is why the
 * message said nothing at all.
 *
 * So it now has the shape chatWithMorpheus already has: a start event with an ETA,
 * an event per completed model call, and exactly one terminal event. Bytes flowing
 * is the whole point twice over — it keeps the connection from looking idle, and a
 * failure AFTER the first byte comes back as NDJSON through Express's CORS headers,
 * so the panel shows the real reason instead of "Failed to fetch".
 *
 * NEGOTIATION: the client opts in with `stream: true` in the body. Not the Accept
 * header, because functions.invoke and functions.invokeStream send byte-identical
 * requests today (same headers), so a header could not tell them apart — and a
 * caller that sends no `stream` field (an older deployed bundle, curl, a widget
 * token) gets exactly today's plain JSON response and status codes.
 */
export default async function handler({ user, body, res }) {
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

  // Everything above is cheap argument checking, so it happens BEFORE any byte is
  // written and still answers with a real status code. Streaming starts below, and
  // from there a failure has to travel in the terminal event — the status is
  // already sent.
  if (!(body?.stream === true) || !res || typeof res.writeHead !== 'function') {
    return run({ user, projectId, ids });
  }

  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no', // don't buffer, flush each line (the chat path does the same)
  });
  const emit = (event) => { try { res.write(JSON.stringify(event) + '\n'); } catch { /* client went away */ } };

  // The ETA is the app's OWN measured average for this role (timingStats), not a
  // guess and not the 60s generic seed — see SEO_AI_ROLE.
  const perCallMs = estimateCallMs(SEO_AI_ROLE);
  const startedAt = Date.now();
  emit({
    type: 'stage', stage: 'seo', status: 'start', label: 'Writing metadata',
    etaSeconds: Math.round(perCallMs / 1000), done: 0, total: ids.length,
  });

  // A heartbeat, because the worst case is ONE model call: no call boundary means
  // no progress event, and a single 180s silence is exactly what got cut. Ignored
  // by the client's reader (it only acts on stage/result/error), so it costs the
  // UI nothing.
  const beat = setInterval(() => {
    emit({ type: 'ping', elapsedMs: Date.now() - startedAt });
  }, 15000);
  beat.unref?.();

  let done = 0;
  const onProgress = (items) => {
    done += items;
    const remainingMs = Math.max(0, perCallMs - (Date.now() - startedAt)) + perCallMs * Math.max(0, Math.ceil((ids.length - done) / SEO_ITEMS_PER_CALL));
    emit({
      type: 'stage', stage: 'seo', status: 'progress', label: 'Writing metadata',
      done, total: ids.length, etaSeconds: Math.round(remainingMs / 1000),
    });
  };

  try {
    const payload = await run({ user, projectId, ids, onProgress });
    emit({ type: 'result', data: payload });
  } catch (err) {
    // The status code is long gone, so the error travels as the terminal event.
    // `message` is what base44Client's reader surfaces; `error` is what SeoTab
    // already reads off a thrown function error, so both are set and the panel
    // shows the same wording on either path.
    emit({
      type: 'error',
      message: err?.message || 'Internal error',
      error: err?.message || 'Internal error',
      ...(err?.code ? { code: err.code } : {}),
      ...(err?.status ? { status: err.status } : {}),
    });
  } finally {
    clearInterval(beat);
    try { res.end(); } catch { /* already closed */ }
  }
}

/** The work itself — unchanged, except that it reports each completed call. */
async function run({ user, projectId, ids, onProgress = () => {} }) {
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
      // Its OWN role — see SEO_AI_ROLE. The estimate this handler streams is the
      // rolling average of SEO calls, which only exists because they are recorded
      // under a role nothing else uses.
      role: SEO_AI_ROLE,
      maxTokens: seoCallMaxTokens(chunk.length),
    });
    onProgress(chunk.length);
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
