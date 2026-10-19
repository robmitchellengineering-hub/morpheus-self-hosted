// Keeps Morpheus itself current — AI models, and a report on outdated
// npm dependencies (server + frontend) — without ever silently rewriting
// code or auto-deploying an untested change.
//
// Design boundary, on purpose: this module DETECTS drift and NOTIFIES an
// operator/admin. It does not auto-edit package.json, does not auto-`npm
// install`, and does not auto-push anything. Two reasons:
//   1. Supply-chain safety — blindly pulling in "latest" on a schedule
//      means an unreviewed, possibly-compromised or breaking package
//      version lands in a codegen platform that other people's generated
//      apps depend on.
//   2. Every Morpheus instance hosts real user projects. A dependency or
//      framework bump that isn't reviewed can break builds/compiles that
//      were working yesterday.
// AI *model selection* is the one exception that's safe to fully automate
// (see resolveModelDefault below / server/src/ai.js) — swapping which
// model string a chat completion call uses carries none of those risks,
// since it's config, not code, and provider-side rollbacks are instant.
//
// See FRESHNESS.md for the full design note.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sendMail } from './lib/mailer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PKG_PATH = path.resolve(__dirname, '../package.json');
const ROOT_PKG_PATH = path.resolve(__dirname, '../../package.json');
const STATE_PATH = path.resolve(__dirname, '../data/freshness-last-report.json');

const MODEL_CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12h — advisory data, no need to hammer provider APIs
const modelCache = new Map(); // `${baseUrl}::${apiKey.slice(0,8)}` -> { model, fetchedAt }

// Ids that come back from a provider's /models list but aren't chat models
// (embeddings, audio, image, moderation, legacy completion models) — skip
// these when picking "the newest chat model".
const NON_CHAT_MODEL_PATTERN = /(embed|whisper|tts|dall-e|image|moderation|davinci|curie|babbage|ada-|clip|rerank)/i;

/**
 * For a Gemini endpoint, Google maintains an official self-updating alias
 * (`gemini-flash-latest`) that they hot-swap server-side — no API call
 * needed, no caching needed, it's just always current. For any other
 * OpenAI-compatible endpoint (OpenAI, OpenRouter, Groq, Together, a local
 * Ollama/LM Studio, etc.) there's no universal "-latest" convention, but
 * every one of them implements the standard `GET {baseUrl}/models` list —
 * so fall back to querying that and picking the most-recently-created chat
 * model. Cached for MODEL_CACHE_TTL_MS since this is advisory, not
 * critical-path (server/src/ai.js's own default only needs to be "pretty
 * current", not perfectly live on every single request).
 */
export async function discoverLatestModel(baseUrl, apiKey) {
  if (typeof baseUrl === 'string' && baseUrl.includes('generativelanguage.googleapis.com')) {
    return { model: 'gemini-flash-latest', method: 'official-alias' };
  }
  if (!apiKey) return { model: null, method: 'no-api-key' };

  const cacheKey = `${baseUrl}::${apiKey.slice(0, 8)}`;
  const cached = modelCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < MODEL_CACHE_TTL_MS) {
    return { model: cached.model, method: 'discovered (cached)' };
  }

  try {
    const res = await fetch(`${String(baseUrl).replace(/\/+$/, '')}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { model: null, method: `discovery failed (${res.status})` };
    const data = await res.json();
    const list = Array.isArray(data?.data) ? data.data : [];
    const chatModels = list.filter((m) => m?.id && !NON_CHAT_MODEL_PATTERN.test(m.id));
    if (chatModels.length === 0) return { model: null, method: 'discovery returned no chat models' };

    chatModels.sort((a, b) => (b.created || 0) - (a.created || 0) || String(b.id).localeCompare(String(a.id)));
    const model = chatModels[0].id;
    modelCache.set(cacheKey, { model, fetchedAt: Date.now() });
    return { model, method: 'discovered via /models' };
  } catch (err) {
    return { model: null, method: `discovery error: ${err.message}` };
  }
}

/** Report on the platform's own configured AI endpoint (server/.env LLM_*). */
export async function getAIModelStatus() {
  const baseUrl = process.env.LLM_BASE_URL || null;
  const apiKey = process.env.LLM_API_KEY || null;
  const pinned = (process.env.LLM_MODEL || '').trim();
  const isAuto = !pinned || ['auto', 'latest'].includes(pinned.toLowerCase());

  if (!baseUrl || !apiKey) {
    return { configured: false };
  }

  const discovery = await discoverLatestModel(baseUrl, apiKey);
  return {
    configured: true,
    baseUrl,
    configuredModel: isAuto ? '(auto — resolves per-request)' : pinned,
    autoUpdating: isAuto,
    currentlyResolvesTo: isAuto ? discovery.model : pinned,
    newestKnownModel: discovery.model,
    driftedFromPinned: !isAuto && discovery.model && discovery.model !== pinned,
    discoveryMethod: discovery.method,
  };
}

async function readPkg(p) {
  try {
    return JSON.parse(await fs.readFile(p, 'utf8'));
  } catch {
    return null;
  }
}

function stripRangePrefix(range) {
  return String(range || '').replace(/^[\^~>=<\s]+/, '').trim();
}

// Minimal semver compare — good enough for "is there a newer version",
// not a full semver-range resolver (avoids pulling in a dependency for
// what's fundamentally an advisory report).
function versionIsNewer(latest, current) {
  const a = String(latest).split('.').map((n) => parseInt(n, 10) || 0);
  const b = String(current).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const av = a[i] || 0, bv = b[i] || 0;
    if (av > bv) return true;
    if (av < bv) return false;
  }
  return false;
}

async function fetchLatestNpmVersion(name) {
  try {
    const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`, {
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.version || null;
  } catch {
    return null;
  }
}

// Simple bounded-concurrency map so a package.json with 60 deps doesn't
// fire 60 simultaneous requests at the npm registry.
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Compares a package.json's pinned dependency floors against npm's current
 * "latest" tag. Returns only the diffs — read-only, changes nothing.
 */
export async function checkNpmDependencies(pkgJsonPath, label) {
  const pkg = await readPkg(pkgJsonPath);
  if (!pkg) return { label, checked: false, reason: 'package.json not found/readable' };

  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const names = Object.keys(deps);
  const results = await mapWithConcurrency(names, 8, async (name) => {
    const current = stripRangePrefix(deps[name]);
    if (!current || !/^\d/.test(current)) return null; // skip "workspace:*", git urls, etc.
    const latest = await fetchLatestNpmVersion(name);
    if (!latest) return null;
    const outdated = versionIsNewer(latest, current);
    if (!outdated) return null;
    const currentMajor = parseInt(current.split('.')[0], 10) || 0;
    const latestMajor = parseInt(latest.split('.')[0], 10) || 0;
    return { name, current, latest, majorBump: latestMajor > currentMajor };
  });

  const outdated = results.filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
  return { label, checked: true, totalDependencies: names.length, outdatedCount: outdated.length, outdated };
}

export async function runFreshnessCheck() {
  const [ai, serverDeps, frontendDeps] = await Promise.all([
    getAIModelStatus().catch((err) => ({ configured: false, error: err.message })),
    checkNpmDependencies(SERVER_PKG_PATH, 'server').catch((err) => ({ label: 'server', checked: false, reason: err.message })),
    checkNpmDependencies(ROOT_PKG_PATH, 'frontend').catch((err) => ({ label: 'frontend', checked: false, reason: err.message })),
  ]);
  return { checkedAt: new Date().toISOString(), ai, serverDeps, frontendDeps };
}

function summarize(report) {
  const parts = [];
  if (report.ai?.driftedFromPinned) {
    parts.push(`AI model pinned to "${report.ai.configuredModel}" but "${report.ai.newestKnownModel}" is newer`);
  }
  for (const section of [report.serverDeps, report.frontendDeps]) {
    if (section?.checked && section.outdatedCount > 0) {
      const majors = section.outdated.filter((d) => d.majorBump).length;
      parts.push(`${section.label}: ${section.outdatedCount} outdated package(s)${majors ? ` (${majors} major)` : ''}`);
    }
  }
  return parts;
}

/**
 * Runs the check and, only if something changed since the last run (so this
 * never spams the operator on an unattended weekly schedule), emails a
 * summary to notifyEmail via the existing SMTP config. Persists the last
 * report to server/data/ so re-runs can diff against it.
 */
export async function runFreshnessCheckAndNotify(notifyEmail) {
  const report = await runFreshnessCheck();
  const summary = summarize(report);

  let previousSummary = [];
  try {
    const prev = JSON.parse(await fs.readFile(STATE_PATH, 'utf8'));
    previousSummary = prev.summary || [];
  } catch {
    // no previous report yet — first run
  }

  await fs.mkdir(path.dirname(STATE_PATH), { recursive: true }).catch(() => {});
  await fs.writeFile(STATE_PATH, JSON.stringify({ ...report, summary }, null, 2)).catch((err) => {
    console.warn('[freshness] failed to persist report:', err.message);
  });

  const changed = JSON.stringify(summary) !== JSON.stringify(previousSummary);
  if (changed && summary.length > 0 && notifyEmail) {
    await sendMail({
      to: notifyEmail,
      subject: `Morpheus freshness check: ${summary.length} item(s) to review`,
      text: `Morpheus checked its own AI model config and dependencies and found:\n\n${summary.map((s) => '- ' + s).join('\n')}\n\nNothing was changed automatically — review and apply at your own pace. Full report: GET /api/admin/freshness on your backend.`,
    }).catch((err) => console.warn('[freshness] notify email failed:', err.message));
  }

  return { report, summary, changedSinceLastRun: changed };
}
