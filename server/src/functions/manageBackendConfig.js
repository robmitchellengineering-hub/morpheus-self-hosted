// Ported from base44/functions/manageBackendConfig/entry.ts.
//
// Manages per-project backend configuration: custom domain and API keys.
// API keys are generated as mk_<random>, stored as SHA-256 hashes (never
// plaintext) — the original never persisted a reversible ciphertext for
// these (crypto.js's encrypt/decrypt is for secrets that must be read back;
// a one-way hash is strictly stronger for a bearer key that's only ever
// compared, never re-displayed). The full key is returned ONLY at
// generation time — afterwards only the prefix is visible.
//
// Actions:
//   get          — returns {custom_domain, api_keys: [{id, name, prefix, created_date, active}]}
//   set_domain   — sets/updates custom_domain (pass {custom_domain})
//   generate_key — creates a new API key, returns the full key once (pass {name})
//   revoke_key   — marks a key inactive by id (pass {keyId})
import crypto from 'node:crypto';
import { prisma } from '../db.js';
import { logUsage } from '../lib/projectUtils.js';

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function randomHex(bytes) {
  return crypto.randomBytes(bytes).toString('hex');
}

export default async function handler({ user, body }) {
  const { projectId, action } = body || {};
  if (!projectId) throw Object.assign(new Error('projectId required'), { status: 400 });
  if (!action) throw Object.assign(new Error('action required'), { status: 400 });

  // Ownership check — the project must belong to this user.
  const project = await prisma.project.findFirst({ where: { id: projectId, created_by_id: user.id } });
  if (!project) throw Object.assign(new Error('Project not found'), { status: 404 });

  // Load existing config for this project
  let config = await prisma.backendConfig.findFirst({ where: { project_id: projectId, created_by_id: user.id } });

  // --- GET ---
  if (action === 'get') {
    const customDomain = config?.custom_domain || '';
    let apiKeys = [];
    if (config?.api_keys) {
      try {
        apiKeys = JSON.parse(config.api_keys).map((k) => ({
          id: k.id, name: k.name, prefix: k.prefix, created_date: k.created_date, active: k.active,
        }));
      } catch {
        // malformed api_keys JSON — treat as empty
      }
    }
    return { custom_domain: customDomain, api_keys: apiKeys };
  }

  // --- SET DOMAIN ---
  if (action === 'set_domain') {
    const customDomain = (body.custom_domain || '').trim().replace(/^https?:\/\//, '').replace(/\/$/, '');
    if (config) {
      await prisma.backendConfig.update({ where: { id: config.id }, data: { custom_domain: customDomain } });
    } else {
      config = await prisma.backendConfig.create({
        data: { created_by_id: user.id, project_id: projectId, custom_domain: customDomain, api_keys: '[]' },
      });
    }
    await logUsage(user.id, 'autonomous_step', projectId, '', { phase: 'set_custom_domain', domain: customDomain });
    return { success: true, custom_domain: customDomain };
  }

  // --- GENERATE KEY ---
  if (action === 'generate_key') {
    const name = (body.name || 'Default').trim().substring(0, 50);
    const fullKey = `mk_${randomHex(24)}`;
    const keyHash = sha256(fullKey);
    const prefix = fullKey.substring(0, 11);
    const keyObj = {
      id: randomHex(8),
      name,
      keyHash,
      prefix,
      created_date: new Date().toISOString(),
      active: true,
    };

    let keys = [];
    if (config?.api_keys) {
      try { keys = JSON.parse(config.api_keys); } catch { keys = []; }
    }
    keys.push(keyObj);

    if (config) {
      await prisma.backendConfig.update({ where: { id: config.id }, data: { api_keys: JSON.stringify(keys) } });
    } else {
      config = await prisma.backendConfig.create({
        data: { created_by_id: user.id, project_id: projectId, custom_domain: '', api_keys: JSON.stringify(keys) },
      });
    }

    await logUsage(user.id, 'autonomous_step', projectId, '', { phase: 'generate_api_key', keyName: name });
    // Return the full key ONCE — only the hash is stored
    return { success: true, key: fullKey, keyId: keyObj.id, name, prefix };
  }

  // --- REVOKE KEY ---
  if (action === 'revoke_key') {
    const keyId = body.keyId;
    if (!keyId) throw Object.assign(new Error('keyId required'), { status: 400 });
    if (!config?.api_keys) throw Object.assign(new Error('No API keys to revoke'), { status: 400 });

    let keys = [];
    try { keys = JSON.parse(config.api_keys); } catch { keys = []; }
    const updated = keys.map((k) => (k.id === keyId ? { ...k, active: false } : k));
    await prisma.backendConfig.update({ where: { id: config.id }, data: { api_keys: JSON.stringify(updated) } });
    await logUsage(user.id, 'autonomous_step', projectId, '', { phase: 'revoke_api_key', keyId });
    return { success: true };
  }

  throw Object.assign(new Error(`Unknown action: ${action}`), { status: 400 });
}
