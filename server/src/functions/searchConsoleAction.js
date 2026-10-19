// Google Search Console for the SEO surface: REAL queries, clicks, impressions,
// CTR and average position for the account's own verified property.
//
// WHAT THIS DELIBERATELY DOES NOT DO: produce a search volume, a difficulty
// score, a ranking estimate or a backlink count. The first three are not in the
// API at all; the last one is not in the API either — Google's reference lists
// Search Analytics, Sitemaps, Sites and URL Inspection, and no links method — so
// the panel links out to Search Console's own Links report instead of implying a
// figure we cannot fetch. lib/searchConsoleInsights.js's shape has no field for
// any of them.
//
// One function with an `action` (rather than six functions) because the widget
// token's scope is a function-name allow-list: one name to grant, one name to
// audit.
import { prisma } from '../db.js';
import {
  getSearchConsoleConnection, listProperties, querySearchAnalytics, dateRange, GSC_SCOPE,
} from '../lib/searchConsole.js';
import { buildOverview } from '../lib/searchConsoleInsights.js';

// Search Console withholds the last day or two while it settles, so asking for
// the window ending today returns a thin tail. Same reason the UI's default is
// 28 days rather than 7.
const ALLOWED_DAYS = new Set([7, 28, 90]);
const DEFAULT_DAYS = 28;
/** Only properties Google says this account can actually read. */
const READABLE = new Set(['siteOwner', 'siteFullUser', 'siteRestrictedUser']);

/** The Links report deep link — the one honest way to answer "who links to me". */
function linksReportUrl(property) {
  const resourceId = property?.startsWith('sc-domain:') ? property : property;
  return `https://search.google.com/search-console/links?resource_id=${encodeURIComponent(resourceId || '')}`;
}

export default async function handler({ user, body }) {
  const action = String(body?.action || 'status');

  if (action === 'status') {
    const conn = await getSearchConsoleConnection(user.id);
    if (!conn) return { connected: false, scope: GSC_SCOPE };
    return {
      connected: true,
      email: conn.email,
      property: conn.property,
      // The account can be connected and still have chosen no property: a
      // verified account may hold several, and a fresh one holds none. Saying so
      // is what stops the panel showing "connected" and then nothing.
      needsProperty: !conn.property,
      linksReportUrl: conn.property ? linksReportUrl(conn.property) : null,
    };
  }

  if (action === 'disconnect') {
    await prisma.searchConsoleConnection.deleteMany({ where: { created_by_id: user.id } });
    return { connected: false };
  }

  const conn = await getSearchConsoleConnection(user.id);
  if (!conn) {
    throw Object.assign(new Error('Search Console is not connected. Connect it from the SEO tab first.'), { status: 400, code: 'NOT_CONNECTED' });
  }

  if (action === 'properties') {
    const sites = await listProperties(conn.accessToken);
    return {
      properties: sites.map((s) => ({
        ...s,
        // Passed through rather than filtered, so the picker can explain why a
        // property cannot be read instead of hiding it.
        readable: READABLE.has(s.permissionLevel),
      })),
      scope: GSC_SCOPE,
    };
  }

  if (action === 'select-property') {
    const wanted = String(body?.property || '');
    if (!wanted) throw Object.assign(new Error('property required'), { status: 400 });
    // Validated against Google's own list for THIS account rather than trusted:
    // storing an arbitrary string would produce a confusing 403 later instead of
    // a clear refusal now.
    const sites = await listProperties(conn.accessToken);
    const match = sites.find((s) => s.siteUrl === wanted);
    if (!match) throw Object.assign(new Error('That property is not in this account\'s Search Console list.'), { status: 400, code: 'UNKNOWN_PROPERTY' });
    if (!READABLE.has(match.permissionLevel)) {
      throw Object.assign(new Error(
        `Google lists "${wanted}" as ${match.permissionLevel}, which cannot read performance data. Verify the property for this Google account first.`,
      ), { status: 400, code: 'PROPERTY_NOT_READABLE' });
    }
    await prisma.searchConsoleConnection.update({
      where: { created_by_id: user.id },
      data: { property: wanted },
    });
    return { ok: true, property: wanted, linksReportUrl: linksReportUrl(wanted) };
  }

  if (action === 'overview') {
    if (!conn.property) {
      throw Object.assign(new Error('Pick a Search Console property first.'), { status: 400, code: 'NO_PROPERTY' });
    }
    const days = ALLOWED_DAYS.has(Number(body?.days)) ? Number(body.days) : DEFAULT_DAYS;
    const { startDate, endDate } = dateRange(days);

    // Two calls: the query dimension and the page dimension. Search Analytics
    // cannot return both in one request, and a page report derived from the
    // query report would be wrong.
    const [byQuery, byPage] = await Promise.all([
      querySearchAnalytics(conn.accessToken, conn.property, { startDate, endDate, dimensions: ['query'] }),
      querySearchAnalytics(conn.accessToken, conn.property, { startDate, endDate, dimensions: ['page'] }),
    ]);

    const overview = buildOverview({
      queryRows: byQuery.rows,
      pageRows: byPage.rows,
      days,
      property: conn.property,
    });

    return {
      ...overview,
      // Distinguishing "Google returned no rows" from "we could not read it" —
      // a failed call throws above and never reaches here, so an empty result is
      // genuinely a quiet window, not a silent failure.
      empty: byQuery.rows.length === 0 && byPage.rows.length === 0,
      range: { startDate, endDate },
      linksReportUrl: linksReportUrl(conn.property),
    };
  }

  throw Object.assign(new Error(`Unknown action: ${action}`), { status: 400 });
}
