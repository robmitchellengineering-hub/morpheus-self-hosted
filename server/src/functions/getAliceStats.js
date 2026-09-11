// Aggregates live Aliceinthealice highlights for the /stats/alice page.
// Uses the Wikimedia APIs directly (no keys required) and caches in memory
// for 15 minutes. See the self-dev decision for why this is a dedicated
// function rather than three generic ones: the operator wanted a single
// endpoint for a hardcoded subject.
const TTL_MS = 15 * 60 * 1000;
const USER_AGENT = 'MorpheusStatsBot/1.0 (https://morpheus.nz; rob@morpheus.nz)'; // Added per review: descriptive UA for Wikimedia API compliance
let cached = { data: null, at: 0 };

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function fetchJson(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function getWikidataLabels(ids) {
  const unique = [...new Set(ids)].filter(Boolean);
  if (unique.length === 0) return {};
  const chunks = chunk(unique, 50);
  const labels = {};
  for (const idsChunk of chunks) {
    const url = `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${idsChunk.join('|')}&props=labels&languages=en&format=json&origin=*`;
    const data = await fetchJson(url).catch(() => null);
    if (data?.entities) {
      for (const [id, entity] of Object.entries(data.entities)) {
        labels[id] = entity?.labels?.en?.value || id;
      }
    }
  }
  return labels;
}

export default async function handler() {
  const now = Date.now();
  if (cached.data && now - cached.at < TTL_MS) return cached.data;

  const result = {
    editCount: null,
    activityTimeline: [],
    topArticles: [],
    createdArticles: [],
    pageviewSeries: [],
    wikidata: null,
  };

  // 1. Total edit count
  try {
    const data = await fetchJson('https://en.wikipedia.org/w/api.php?action=query&list=users&ususers=Aliceinthealice&usprop=editcount&format=json&origin=*');
    result.editCount = data?.query?.users?.[0]?.editcount ?? null;
  } catch (err) {
    console.error('[getAliceStats] edit count failed:', err.message);
  }

  // 2. Recent contributions (last 500 namespace 0 edits)
  let contributions = [];
  try {
    const data = await fetchJson('https://en.wikipedia.org/w/api.php?action=query&list=usercontribs&ucuser=Aliceinthealice&ucprop=title|timestamp|comment|size|sizediff&uclimit=500&ucnamespace=0&format=json&origin=*');
    contributions = data?.query?.usercontribs || [];
  } catch (err) {
    console.error('[getAliceStats] contributions failed:', err.message);
  }

  // 3. Build activity timeline and top articles from contributions
  const monthCounts = new Map();
  const titleCounts = new Map();
  const created = [];

  for (const c of contributions) {
    const ts = c.timestamp;
    if (ts) {
      const month = String(ts).slice(0, 7); // YYYY-MM
      monthCounts.set(month, (monthCounts.get(month) || 0) + 1);
    }
    const title = c.title;
    if (title) titleCounts.set(title, (titleCounts.get(title) || 0) + 1);
    // "created" heuristic: a page creation has size === sizediff (the new
    // page's entire size is the change). Some old revisions may omit either
    // field, so only count when both are present and equal.
    const size = Number(c.size);
    const sizediff = Number(c.sizediff);
    if (Number.isFinite(size) && Number.isFinite(sizediff) && size === sizediff && title) {
      created.push(title);
    }
  }

  result.activityTimeline = [...monthCounts.entries()]
    .map(([month, count]) => ({ month, count }))
    .sort((a, b) => a.month.localeCompare(b.month));

  result.topArticles = [...titleCounts.entries()]
    .map(([title, count]) => ({ title, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  const createdTitles = [...new Set(created)];
  result.createdArticles = createdTitles;

  // 4. Pageviews for created articles (batch fetch, then top 5 by total)
  if (createdTitles.length > 0) {
    const titleTotals = new Map(); // title -> { total, daily: [{date, views}] }
    const chunks = chunk(createdTitles, 50);
    for (const batch of chunks) {
      const titlesParam = encodeURIComponent(batch.join('|'));
      const url = `https://en.wikipedia.org/w/api.php?action=query&prop=pageviews&titles=${titlesParam}&pvipdays=60&format=json&origin=*`;
      try {
        const data = await fetchJson(url);
        const pages = data?.query?.pages || {};
        for (const page of Object.values(pages)) {
          const pageviews = page?.pageviews;
          if (!pageviews) continue;
          const title = page.title;
          if (!title) continue;
          let total = 0;
          const daily = [];
          for (const [date, views] of Object.entries(pageviews)) {
            const v = Number(views);
            if (!Number.isFinite(v)) continue;
            total += v;
            daily.push({ date, views: v });
          }
          daily.sort((a, b) => a.date.localeCompare(b.date));
          titleTotals.set(title, { total, daily });
        }
      } catch (err) {
        console.error('[getAliceStats] pageviews batch failed:', err.message);
      }
    }

    const top5 = [...titleTotals.entries()]
      .sort((a, b) => b[1].total - a[1].total)
      .slice(0, 5);

    // Shared 60-day date axis from the first series (all should align)
    const dates = top5.length > 0 ? top5[0][1].daily.map(d => d.date) : [];
    const series = {};
    for (const [title, { daily }] of top5) {
      series[title] = daily.map(d => d.views ?? 0);
    }
    result.pageviewSeries = { dates, series };
  }

  // 5. Wikidata: find Alice Woods QID, then fetch claims
  try {
    const searchUrl = 'https://www.wikidata.org/w/api.php?action=wbsearchentities&search=Alice%20Woods&language=en&limit=5&format=json&origin=*';
    const searchData = await fetchJson(searchUrl);
    const candidates = searchData?.search || [];
    // Prefer a description that matches the Alice Woods we want (Australian,
    // Wikimedia, librarian). Fall back to the first result.
    let chosen = candidates[0];
    for (const c of candidates) {
      const desc = (c.description || '').toLowerCase();
      if (/wikimed|australia|librarian|archivist/.test(desc)) {
        chosen = c;
        break;
      }
    }
    if (chosen) {
      const qid = chosen.id;
      const entityUrl = `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${qid}&props=claims|labels|descriptions&languages=en&format=json&origin=*`;
      const entityData = await fetchJson(entityUrl);
      const entity = entityData?.entities?.[qid];
      if (entity) {
        const label = entity.labels?.en?.value || chosen.label || qid;
        const description = entity.descriptions?.en?.value || chosen.description || '';
        const claims = entity.claims || {};

        const propertyDistribution = Object.entries(claims)
          .map(([propertyId, claimList]) => ({ propertyId, count: claimList.length }))
          .sort((a, b) => b.count - a.count);

        // Curated properties to surface as notable claims.
        const notablePropertyIds = ['P106', 'P108', 'P39', 'P69', 'P19', 'P20', 'P27', 'P166'];
        const notableClaimsRaw = [];
        for (const pid of notablePropertyIds) {
          const claimList = claims[pid];
          if (!claimList) continue;
          for (const claim of claimList) {
            const snak = claim?.mainsnak;
            const datavalue = snak?.datavalue;
            if (!datavalue) continue;
            let valueId = null;
            let valueLiteral = null;
            if (datavalue.type === 'wikibase-entityid') {
              valueId = datavalue.value?.id;
            } else {
              valueLiteral = datavalue.value;
            }
            notableClaimsRaw.push({ propertyId: pid, valueId, valueLiteral });
          }
        }

        // Gather all ids needing labels (property ids + entity value ids).
        const labelIds = [
          ...notableClaimsRaw.map((c) => c.propertyId),
          ...notableClaimsRaw.map((c) => c.valueId).filter(Boolean),
        ];
        const labels = await getWikidataLabels(labelIds).catch(() => ({}));

        const notableClaims = notableClaimsRaw.map((c) => ({
          property: labels[c.propertyId] || c.propertyId,
          value: c.valueId ? (labels[c.valueId] || c.valueId) : String(c.valueLiteral ?? ''),
        }));

        const propertyDistributionWithLabels = propertyDistribution.map((p) => ({
          propertyId: p.propertyId,
          name: labels[p.propertyId] || p.propertyId,
          count: p.count,
        }));

        result.wikidata = {
          label,
          description,
          propertyDistribution: propertyDistributionWithLabels,
          notableClaims,
        };
      }
    }
  } catch (err) {
    console.error('[getAliceStats] wikidata failed:', err.message);
    result.wikidata = null;
  }

  cached = { data: result, at: now };
  return result;
}
