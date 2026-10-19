# Portable Architect

A framework-agnostic backend architect. Give it any app's **frontend config + connections**, and it **plans → generates → deploys** the right backend to **free-tier hosting** (Cloudflare Workers, Vercel, Netlify, Render, Railway, Fly.io, Supabase) or **self-hosted** (Docker, standalone Node). No Base44 dependency — pure Node/Express + an OpenAI-compatible LLM.

## What's inside

```
src/portable-architect/
  package.json
  server/
    index.js          Express API (the only entry point you need to run)
    architect.js      orchestrator: plan / generate / deploy / health / logs / wire
    llm.js            OpenAI-compatible LLM client (env-configured)
    infrastructure.js  component catalog + credential/readiness checks
    store.js           file-based JSON store (no DB needed)
    health.js         HTTP health probe
    deployers.js      per-platform deployers (live API + ZIP/CLI)
    wire.js           rewrites frontend config to point at the backend
  client/
    api.js            fetch client (set window.ARCHITECT_API_BASE)
    ArchitectPanel.jsx  self-contained config + deploy UI (no UI deps)
    Architect.jsx       drop-in page wrapper
```

## 1 — Run the server

```bash
cd src/portable-architect
npm install
LLM_API_KEY=sk-...  LLM_MODEL=gpt-4o-mini  npm start
# → Architect server on :4400
```

Env vars:

| Var | Default | Purpose |
|---|---|---|
| `LLM_BASE_URL` | `https://api.openai.com/v1` | Any OpenAI-compatible endpoint (OpenRouter, Groq, Ollama, …) |
| `LLM_API_KEY` | — | Bearer token (falls back to `OPENAI_API_KEY`) |
| `LLM_MODEL` | `gpt-4o-mini` | Model used for plan + generate |
| `ARCHITECT_PORT` | `4400` | API port |
| `ARCHITECT_DATA_DIR` | `./.architect-data` | Where project state is stored |
| `ARCHITECT_CORS_ORIGIN` | `*` | CORS allow-origin |
| Platform creds | — | `CLOUDFLARE_API_TOKEN`, `VERCEL_TOKEN`, `NETLIFY_TOKEN`, `SUPABASE_ACCESS_TOKEN`, … (see `infrastructure.js`) |

Credentials can be passed per-project in the `connections` map **or** set as server env vars — the readiness check reads both.

## 2 — Mount the UI in any React app

```jsx
import Architect from 'portable-architect/client/Architect.jsx';

// before mount:
window.ARCHITECT_API_BASE = 'https://your-architect-server.com/architect';

<Route path="/architect" element={<Architect />} />
```

`ArchitectPanel` is self-contained (injects its own CSS, no Tailwind/shadcn). Use it directly if you want to embed the panel inside your own layout:

```jsx
import ArchitectPanel from 'portable-architect/client/ArchitectPanel.jsx';
<ArchitectPanel projectId="..." onClose={() => setOpen(false)} />
```

## 3 — Use the API directly (no UI)

```js
import { createProject, planBackend, generateBackend, deployBackend, checkDeployHealth, wireFrontendToBackend } from 'portable-architect';

const p = await createProject({
  name: 'My App',
  description: 'A task tracker',
  frontendConfig: { features: ['auth', 'tasks', 'uploads'] },
  connections: { CLOUDFLARE_API_TOKEN: '...', CLOUDFLARE_ACCOUNT_ID: '...' },
  components: { api_host: 'cloudflare-workers', database: 'supabase-pg', auth: 'supabase-auth', file_storage: 'supabase-storage', cache: 'none' },
});

await planBackend(p.id);
await generateBackend(p.id);
const results = await deployBackend(p.id);          // live-deploys where creds exist, returns ZIPs otherwise
await checkDeployHealth(p.id);
await wireFrontendToBackend(p.id);                  // injects API_BASE_URL into the generated frontend config
```

## REST endpoints

```
GET    /architect/catalog
POST   /architect/projects                      { name, description, frontendConfig, connections, components }
GET    /architect/projects
GET    /architect/projects/:id
PUT    /architect/projects/:id/config
GET    /architect/projects/:id/readiness
POST   /architect/projects/:id/plan
POST   /architect/projects/:id/generate         { components? }
POST   /architect/projects/:id/deploy
GET    /architect/projects/:id/health
GET    /architect/projects/:id/logs?platform=
POST   /architect/projects/:id/wire
GET    /architect/projects/:id/files
GET    /architect/projects/:id/downloads/:file
```

## Deploy behavior

- **Live deploy** (real API calls): Cloudflare Workers, Vercel, Netlify, Supabase SQL, Render (from a git repo).
- **ZIP + CLI** (honest fallback): Railway, Fly.io, Docker, Standalone — returns a downloadable ZIP and the exact commands to run.
- **Code-level**: auth, storage, cache are configured inside the generated backend via env vars.
- Missing credentials → the component returns `needs-creds` / `sql-ready` instead of failing the whole deploy.

## How it maps to your app

1. Configure your frontend (features, routes, env) and your connections (hosting + DB creds).
2. `planBackend` reads that config and produces an architecture plan (tables, routes, auth, storage).
3. `generateBackend` writes the full backend file set (Express server or CF Worker + SQL + package.json + README).
4. `deployBackend` pushes each component to its platform; ZIPs for self-hosted targets.
5. `wireFrontendToBackend` injects the live `API_BASE_URL` into your frontend config.

MIT licensed. Node >= 20.