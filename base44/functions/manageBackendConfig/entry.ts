import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { logUsage } from '../../shared/projectUtils.ts';

// Manages per-project backend configuration: custom domain and API keys.
// API keys are generated as mk_<random>, stored as SHA-256 hashes (never plaintext).
// The full key is returned ONLY at generation time — afterwards only the prefix is visible.
//
// Actions:
//   get          — returns {custom_domain, api_keys: [{id, name, prefix, created_date, active}]}
//   set_domain   — sets/updates custom_domain (pass {custom_domain})
//   generate_key — creates a new API key, returns the full key once (pass {name})
//   revoke_key   — marks a key inactive by id (pass {keyId})

async function sha256(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}

export default async function(req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json();
    const { projectId, action } = body;
    if (!projectId) return Response.json({ error: 'projectId required' }, { status: 400 });
    if (!action) return Response.json({ error: 'action required' }, { status: 400 });

    // Load existing config for this project
    const existing = await base44.entities.BackendConfig.filter({ project_id: projectId });
    let config = existing[0];

    // --- GET ---
    if (action === 'get') {
      const customDomain = config?.custom_domain || '';
      let apiKeys: any[] = [];
      if (config?.api_keys) {
        try {
          apiKeys = JSON.parse(config.api_keys).map((k: any) => ({
            id: k.id, name: k.name, prefix: k.prefix, created_date: k.created_date, active: k.active
          }));
        } catch {}
      }
      return Response.json({ custom_domain: customDomain, api_keys: apiKeys });
    }

    // --- SET DOMAIN ---
    if (action === 'set_domain') {
      const customDomain = (body.custom_domain || '').trim().replace(/^https?:\/\//, '').replace(/\/$/, '');
      if (config) {
        await base44.entities.BackendConfig.update(config.id, { custom_domain: customDomain });
      } else {
        config = await base44.entities.BackendConfig.create({
          project_id: projectId,
          custom_domain: customDomain,
          api_keys: '[]'
        });
      }
      await logUsage(base44, 'autonomous_step', projectId, '', { phase: 'set_custom_domain', domain: customDomain });
      return Response.json({ success: true, custom_domain: customDomain });
    }

    // --- GENERATE KEY ---
    if (action === 'generate_key') {
      const name = (body.name || 'Default').trim().substring(0, 50);
      const fullKey = `mk_${randomHex(24)}`;
      const keyHash = await sha256(fullKey);
      const prefix = fullKey.substring(0, 11);
      const keyObj = {
        id: randomHex(8),
        name,
        keyHash,
        prefix,
        created_date: new Date().toISOString(),
        active: true
      };

      let keys: any[] = [];
      if (config?.api_keys) {
        try { keys = JSON.parse(config.api_keys); } catch {}
      }
      keys.push(keyObj);

      if (config) {
        await base44.entities.BackendConfig.update(config.id, { api_keys: JSON.stringify(keys) });
      } else {
        config = await base44.entities.BackendConfig.create({
          project_id: projectId,
          custom_domain: '',
          api_keys: JSON.stringify(keys)
        });
      }

      await logUsage(base44, 'autonomous_step', projectId, '', { phase: 'generate_api_key', keyName: name });
      // Return the full key ONCE — only the hash is stored
      return Response.json({ success: true, key: fullKey, keyId: keyObj.id, name, prefix });
    }

    // --- REVOKE KEY ---
    if (action === 'revoke_key') {
      const keyId = body.keyId;
      if (!keyId) return Response.json({ error: 'keyId required' }, { status: 400 });
      if (!config?.api_keys) return Response.json({ error: 'No API keys to revoke' }, { status: 400 });

      let keys: any[] = [];
      try { keys = JSON.parse(config.api_keys); } catch {}
      const updated = keys.map(k => k.id === keyId ? { ...k, active: false } : k);
      await base44.entities.BackendConfig.update(config.id, { api_keys: JSON.stringify(updated) });
      await logUsage(base44, 'autonomous_step', projectId, '', { phase: 'revoke_api_key', keyId });
      return Response.json({ success: true });
    }

    return Response.json({ error: `Unknown action: ${action}` }, { status: 400 });
  } catch (error) {
    console.error('manageBackendConfig error:', error?.message || error);
    return Response.json({ error: error?.message || 'Unknown error' }, { status: 500 });
  }
}