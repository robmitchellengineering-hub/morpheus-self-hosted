// Brand kit (2026-09-09) — a project's brand identity: colours, fonts, corner
// radius, density, logo, voice. Stored as a plain config file in the project
// itself (`.morpheus/brand.json`) so it travels with export / import / repo —
// nothing brand-specific in Morpheus's DB, consistent with the build ethos.
// On a web build the coder is handed these as HARD token values that override
// the default design system, so "match my brand" stops being a guess.
import { prisma } from '../db.js';

export const BRAND_PATH = '.morpheus/brand.json';

// Curated, free Google Fonts — the panel offers these; self-hosting is a
// later option. Keep the list short and opinionated.
export const BRAND_FONTS = [
  'Inter', 'Poppins', 'Montserrat', 'Work Sans', 'DM Sans', 'Space Grotesk',
  'Playfair Display', 'Lora', 'Merriweather', 'Bebas Neue', 'Oswald',
  'Archivo', 'Sora', 'Manrope', 'IBM Plex Sans', 'Source Serif 4',
];

export const DEFAULT_BRAND = {
  colors: { primary: '#4f8cff', accent: '#22d3ee', bg: '#ffffff', surface: '#f7f9fc', text: '#0f172a', muted: '#64748b' },
  fonts: { heading: 'Inter', body: 'Inter' },
  radius: '10px',
  density: 'comfortable', // compact | comfortable | spacious
  logoUrl: '',
  voice: '',
};

const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

// Merge a stored object onto the defaults + coerce every field, so a
// hand-edited or partial file can't produce a bad prompt block.
export function normalizeBrand(raw) {
  const b = raw && typeof raw === 'object' ? raw : {};
  const colors = { ...DEFAULT_BRAND.colors, ...(b.colors && typeof b.colors === 'object' ? b.colors : {}) };
  for (const k of Object.keys(colors)) {
    if (!HEX_RE.test(String(colors[k] || ''))) colors[k] = DEFAULT_BRAND.colors[k];
  }
  const validFont = (f) => (BRAND_FONTS.includes(f) ? f : DEFAULT_BRAND.fonts.body);
  return {
    colors,
    fonts: {
      heading: validFont(b.fonts?.heading),
      body: validFont(b.fonts?.body),
    },
    radius: /^\d{1,3}(px|rem|em)$/.test(String(b.radius || '')) ? b.radius : DEFAULT_BRAND.radius,
    density: ['compact', 'comfortable', 'spacious'].includes(b.density) ? b.density : DEFAULT_BRAND.density,
    logoUrl: typeof b.logoUrl === 'string' && /^https?:\/\//.test(b.logoUrl) ? b.logoUrl.slice(0, 1000) : '',
    voice: typeof b.voice === 'string' ? b.voice.slice(0, 600) : '',
  };
}

// Returns the normalized brand, or null when the project has no brand file.
export async function getBrand(projectId) {
  try {
    const row = await prisma.projectFile.findFirst({ where: { project_id: projectId, path: BRAND_PATH } });
    if (!row?.content) return null;
    return normalizeBrand(JSON.parse(row.content));
  } catch {
    return null;
  }
}

// True when the brand is still entirely on defaults — no point sending a
// "match my brand" instruction that just restates the design system.
export function isDefaultBrand(brand) {
  if (!brand) return true;
  const d = DEFAULT_BRAND;
  return JSON.stringify({ ...brand, logoUrl: '', voice: '' }) === JSON.stringify({ ...d, colors: d.colors, fonts: d.fonts })
    && !brand.logoUrl && !brand.voice;
}

const DENSITY_SPACE = { compact: '6px', comfortable: '8px', spacious: '12px' };

// The block handed to the planner + coder on a web build when a brand is set.
export function brandPromptBlock(brand) {
  if (!brand || isDefaultBrand(brand)) return '';
  const c = brand.colors;
  const fontsNeeded = [...new Set([brand.fonts.heading, brand.fonts.body])];
  return `
BRAND KIT — the operator has set the brand for this site. These are HARD values: override the design system's defaults with them, define them as CSS custom properties in :root, and reference the variables everywhere — never hardcode a colour or font that contradicts this.
  --primary: ${c.primary};   --accent: ${c.accent};
  --bg: ${c.bg};   --surface: ${c.surface};   --text: ${c.text};   --text-muted: ${c.muted};
  --radius: ${brand.radius};   --space: ${DENSITY_SPACE[brand.density] || '8px'};   (density: ${brand.density})
  --font-heading: "${brand.fonts.heading}", sans-serif;   --font-body: "${brand.fonts.body}", sans-serif;
Load the fonts: add <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=${fontsNeeded.map((f) => f.replace(/ /g, '+') + ':wght@400;600;700').join('&family=')}&display=swap"> to every page's <head>. Headings use --font-heading, body copy uses --font-body.${brand.logoUrl ? `\nLogo: ${brand.logoUrl} — use it in the header/nav (and footer if there is one) with sensible sizing and alt text.` : ''}${brand.voice ? `\nVoice & tone for all copy, headings and microcopy: ${brand.voice}` : ''}
`;
}
