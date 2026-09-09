// Site / domain config (2026-09-09) — the project's production domain and
// where it's hosted. Config lives in the project (.morpheus/site.json), so
// it travels with export / repo. ZERO CUSTODY: Morpheus stores the domain
// string, nothing else — the site is on the operator's own host, served
// from the operator's own repo. This module:
//   1. hands the coder the production URL so absolute links (og:image,
//      canonical, sitemap.xml) are correct;
//   2. generates the exact DNS records the operator adds at their registrar;
//   3. (siteStatus.js) checks the live site on demand.
import { prisma } from '../db.js';

export const SITE_PATH = '.morpheus/site.json';

// Static hosts Morpheus can generate DNS + guidance for. 'other' = the
// operator points DNS themselves (VPS, another PaaS, etc.).
export const SITE_HOSTS = ['netlify', 'vercel', 'cloudflare-pages', 'github-pages', 'other'];

export const DEFAULT_SITE = {
  domain: '',            // apex or subdomain, no protocol/path — e.g. "valiantmusic.com.au"
  host: '',              // one of SITE_HOSTS
  canonical: 'apex',     // which hostname is canonical: 'apex' (redirect www→apex) | 'www' (redirect apex→www)
  hostSubdomain: '',     // the host's own subdomain for CNAME targets, e.g. "valiant-music.netlify.app" (optional)
};

// A hostname: labels of a-z0-9 and hyphens, 2+ parts, TLD 2+ alpha.
const DOMAIN_RE = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

export function cleanDomain(raw) {
  if (typeof raw !== 'string') return '';
  let d = raw.trim().toLowerCase();
  d = d.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/:.*$/, '').replace(/\.$/, '');
  d = d.replace(/^www\./, ''); // store the registrable domain; canonical flag says whether www is preferred
  return DOMAIN_RE.test(d) ? d : '';
}

export function normalizeSite(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  return {
    domain: cleanDomain(s.domain),
    host: SITE_HOSTS.includes(s.host) ? s.host : '',
    canonical: s.canonical === 'www' ? 'www' : 'apex',
    hostSubdomain: typeof s.hostSubdomain === 'string' && /^[a-z0-9.-]{1,120}$/i.test(s.hostSubdomain.trim())
      ? s.hostSubdomain.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')
      : '',
  };
}

export async function getSite(projectId) {
  try {
    const row = await prisma.projectFile.findFirst({ where: { project_id: projectId, path: SITE_PATH } });
    if (!row?.content) return null;
    return normalizeSite(JSON.parse(row.content));
  } catch {
    return null;
  }
}

// Registrar-agnostic DNS records. Apex domains can't be a CNAME — most hosts
// publish anycast A records for the apex and a CNAME for www. Providers that
// support CNAME flattening / ALIAS / ANAME at the apex (Cloudflare, some
// registrars) can use that instead — noted per record.
const HOST_DNS = {
  netlify: {
    apexA: ['75.2.60.5'],
    apexAlias: 'apex-loadbalancer.netlify.com',
    cnameTarget: (s) => s.hostSubdomain || '<your-site>.netlify.app',
    tlsNote: 'Netlify issues a Let’s Encrypt certificate automatically once DNS resolves.',
  },
  vercel: {
    apexA: ['76.76.21.21'],
    apexAlias: '',
    cnameTarget: () => 'cname.vercel-dns.com',
    tlsNote: 'Vercel issues the certificate automatically once the domain verifies.',
  },
  'cloudflare-pages': {
    apexA: [],
    apexAlias: '',
    cnameTarget: (s) => s.hostSubdomain || '<your-project>.pages.dev',
    tlsNote: 'Add the domain in Cloudflare Pages → Custom domains; Cloudflare handles the certificate and can CNAME the apex (flattening).',
  },
  'github-pages': {
    apexA: ['185.199.108.153', '185.199.109.153', '185.199.110.153', '185.199.111.153'],
    apexAlias: '',
    cnameTarget: (s) => s.hostSubdomain || '<your-user>.github.io',
    tlsNote: 'Enable "Enforce HTTPS" in the repo’s Pages settings after DNS resolves. Commit a CNAME file (Morpheus can add it).',
  },
  other: {
    apexA: [],
    apexAlias: '',
    cnameTarget: () => '<your-host-target>',
    tlsNote: 'Your host must terminate TLS for this domain (Let’s Encrypt / Caddy / a reverse proxy).',
  },
};

// → [{ type, name, value, ttl, note }]
export function dnsRecordsFor(site) {
  const s = normalizeSite(site || {});
  if (!s.domain || !s.host) return [];
  const h = HOST_DNS[s.host] || HOST_DNS.other;
  const recs = [];
  const apexPref = s.canonical === 'apex';

  // Apex (root) record
  if (h.apexA.length) {
    for (const ip of h.apexA) {
      recs.push({ type: 'A', name: '@', value: ip, ttl: 3600, note: h.apexAlias ? `Or a single ALIAS/ANAME record: @ → ${h.apexAlias} (if your DNS provider supports it).` : '' });
    }
  } else if (s.host === 'cloudflare-pages') {
    recs.push({ type: 'CNAME', name: '@', value: h.cnameTarget(s), ttl: 3600, note: 'Cloudflare flattens a CNAME at the apex automatically.' });
  } else {
    recs.push({ type: 'ALIAS', name: '@', value: h.cnameTarget(s), ttl: 3600, note: 'Use ALIAS/ANAME if available; otherwise your host will give apex A records.' });
  }

  // www record
  recs.push({ type: 'CNAME', name: 'www', value: h.cnameTarget(s), ttl: 3600, note: apexPref ? 'www redirects to the apex (set the redirect on your host).' : 'This is the canonical hostname.' });

  // De-dupe identical rows
  const seen = new Set();
  return recs.filter((r) => { const k = `${r.type} ${r.name} ${r.value}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

export function tlsNoteFor(host) {
  return (HOST_DNS[host] || HOST_DNS.other).tlsNote;
}

// The context block handed to planner + coder on a web build once a domain
// is set — so absolute URLs are the real production ones.
export function sitePromptBlock(site) {
  const s = site && site.domain ? normalizeSite(site) : null;
  if (!s || !s.domain) return '';
  const canonicalHost = s.canonical === 'www' ? `www.${s.domain}` : s.domain;
  const base = `https://${canonicalHost}`;
  return `
PRODUCTION DOMAIN: ${base}
Use this exact origin as the absolute base for every absolute URL the site needs — og:image and og:url, <link rel="canonical">, every <loc> in sitemap.xml, JSON-LD "url"/"@id", and RSS/feed links. The canonical hostname is ${canonicalHost} (the other of apex/www must 301-redirect to it). ${s.host && s.host !== 'other' ? `Hosted on ${s.host}.` : ''}${s.host === 'github-pages' ? ' Keep a CNAME file at the site root containing exactly "' + canonicalHost + '".' : ''}
`;
}
