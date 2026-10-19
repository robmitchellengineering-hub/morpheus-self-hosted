// Privacy-first web analytics (2026-09-09). Config lives in the project
// (.morpheus/analytics.json) so it travels with export / repo. ZERO
// CUSTODY: the operator's own analytics account collects the data; Morpheus
// stores only which provider + the public site token, and hands the coder
// the exact <script> to embed.
//
// Only cookieless / free options — no paid dependency, and no cookie banner
// needed (which is why the PUBLISH checklist's cookie-notice item stays
// off unless something else sets a cookie).
import { prisma } from '../db.js';

export const ANALYTICS_PATH = '.morpheus/analytics.json';

// provider -> { label, fields, free, cookieless, note }
export const ANALYTICS_PROVIDERS = {
  '': { label: 'None', fields: [] },
  cloudflare: {
    label: 'Cloudflare Web Analytics',
    fields: ['token'],
    free: true,
    note: 'Free and unlimited. In the Cloudflare dashboard → Analytics & Logs → Web Analytics → Add a site (works even if your DNS isn’t on Cloudflare); copy the JS beacon token.',
  },
  goatcounter: {
    label: 'GoatCounter',
    fields: ['code'],
    free: true,
    note: 'Free for personal / small sites. Sign up at goatcounter.com, pick a code (your subdomain), then use that code here.',
  },
  plausible: {
    label: 'Plausible (self-hosted)',
    fields: ['domain', 'src'],
    free: true,
    note: 'Self-host Plausible (community edition) or use any instance you control. src is that instance’s script URL, e.g. https://plausible.example.com/js/script.js.',
  },
  umami: {
    label: 'Umami (self-hosted)',
    fields: ['websiteId', 'src'],
    free: true,
    note: 'Self-host Umami. websiteId is the UUID from your Umami dashboard; src is https://your-umami/script.js.',
  },
};

const TOKEN_RE = /^[A-Za-z0-9_-]{1,120}$/;
const UUID_RE = /^[0-9a-f-]{8,64}$/i;
const HOST_RE = /^[a-z0-9.-]{3,253}$/i;
const URL_RE = /^https:\/\/[^\s"'<>]{6,300}$/i;

export function normalizeAnalytics(raw) {
  const a = raw && typeof raw === 'object' ? raw : {};
  const provider = Object.prototype.hasOwnProperty.call(ANALYTICS_PROVIDERS, a.provider) ? a.provider : '';
  const out = { provider };
  if (provider === 'cloudflare') {
    out.token = TOKEN_RE.test(String(a.token || '').trim()) ? a.token.trim() : '';
  } else if (provider === 'goatcounter') {
    out.code = /^[a-z0-9-]{1,63}$/i.test(String(a.code || '').trim()) ? a.code.trim().toLowerCase() : '';
  } else if (provider === 'plausible') {
    out.domain = HOST_RE.test(String(a.domain || '').trim()) ? a.domain.trim().toLowerCase() : '';
    out.src = URL_RE.test(String(a.src || '').trim()) ? a.src.trim() : '';
  } else if (provider === 'umami') {
    out.websiteId = UUID_RE.test(String(a.websiteId || '').trim()) ? a.websiteId.trim() : '';
    out.src = URL_RE.test(String(a.src || '').trim()) ? a.src.trim() : '';
  }
  return out;
}

export async function getAnalytics(projectId) {
  try {
    const row = await prisma.projectFile.findFirst({ where: { project_id: projectId, path: ANALYTICS_PATH } });
    if (!row?.content) return null;
    return normalizeAnalytics(JSON.parse(row.content));
  } catch {
    return null;
  }
}

// The exact <script> tag for the configured provider, or '' if not ready.
export function analyticsSnippet(a) {
  if (!a || !a.provider) return '';
  if (a.provider === 'cloudflare' && a.token) {
    return `<script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='{"token": "${a.token}"}'></script>`;
  }
  if (a.provider === 'goatcounter' && a.code) {
    return `<script data-goatcounter="https://${a.code}.goatcounter.com/count" async src="//gc.zgo.at/count.js"></script>`;
  }
  if (a.provider === 'plausible' && a.domain && a.src) {
    return `<script defer data-domain="${a.domain}" src="${a.src}"></script>`;
  }
  if (a.provider === 'umami' && a.websiteId && a.src) {
    return `<script defer src="${a.src}" data-website-id="${a.websiteId}"></script>`;
  }
  return '';
}

// Handed to the coder on a web build once analytics is configured.
export function analyticsPromptBlock(a) {
  const snippet = analyticsSnippet(a);
  if (!snippet) return '';
  const label = ANALYTICS_PROVIDERS[a.provider]?.label || a.provider;
  return `
ANALYTICS — the operator uses ${label} (cookieless, privacy-friendly). Add this exact tag to the site's <head> on every page (in the framework's document/head component, or index.html for a static site) — once, not per-route:
${snippet}
It sets no cookies and needs no consent banner. Don't add any other analytics or tag manager.
`;
}
