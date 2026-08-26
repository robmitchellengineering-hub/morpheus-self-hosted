# Morpheus hosted broker

This is a separate, tiny service — not the main Morpheus app. It exists so a
freshly self-hosted Morpheus instance can connect GitHub, sign in with
Google, and chat with the AI **before its operator has registered a single
OAuth App or bought an API key**. Deploy this once, point every instance's
`MORPHEUS_BROKER_URL` at it, and each instance graduates to its own
credentials (in `server/.env`) whenever it wants — the fallback is per
connector, not all-or-nothing, and every instance can ignore this entirely
by just setting its own `GITHUB_CLIENT_ID`, `GOOGLE_CLIENT_ID`, or
`LLM_API_KEY`.

If you're self-hosting a single instance for yourself, you almost certainly
don't need this — just fill in `server/.env` directly with your own OAuth
Apps and AI key, and skip this service entirely. This exists for the "many
independent self-hosted instances, one operator wants to offer a working
default" case (e.g. Morpheus's own project maintainer offering it to anyone
who self-hosts).

## What it does

Three independent things, none of which share state beyond an in-memory,
2-minute-TTL one-time-code map (see `src/exchangeStore.js`):

1. **GitHub OAuth broker** — holds one shared GitHub OAuth App. An instance
   redirects here instead of straight to GitHub; this service completes the
   OAuth dance with GitHub using its own client secret, then hands the
   resulting access token back to the instance via a one-time code redeemed
   server-to-server (`POST /github/exchange`) — the real GitHub token never
   appears in a browser URL.
2. **Google OAuth broker** — same pattern, for "Sign in with Google."
3. **AI gateway passthrough** — a thin proxy in front of your own real
   OpenAI-compatible key, gated by simple bearer deployment tokens and a
   per-token rate limit, so instances get a working default AI provider
   without needing their own key. This is intentionally minimal (see
   `BROKER_AI_ALLOWED_TOKENS` in `.env.example`) — swap in real per-tenant
   metering/billing before relying on it at any real scale.

## Deploying it

1. Register a GitHub OAuth App (github.com/settings/developers) with
   callback URL `https://<your-broker-domain>/github/callback`, and/or a
   Google OAuth Client (console.cloud.google.com) with redirect URI
   `https://<your-broker-domain>/google/callback`. Both are optional and
   independent — configure either, both, or neither.
2. Copy `.env.example` to `.env` and fill in `BROKER_PUBLIC_URL`,
   `BROKER_JWT_SECRET` (random), the OAuth App credentials from step 1, and
   `BROKER_AI_UPSTREAM_KEY` if you want to offer the AI default too.
3. `npm install && npm start`, or `docker build -t morpheus-broker . && docker run --env-file .env -p 4600:4600 morpheus-broker`. Put it behind TLS (a reverse proxy or your platform's HTTPS termination) — `BROKER_PUBLIC_URL` must be the `https://` address callers actually reach.
4. On each Morpheus instance you want to use these defaults, set
   `MORPHEUS_BROKER_URL=https://<your-broker-domain>` in `server/.env` (and
   `MORPHEUS_AI_GATEWAY_TOKEN` if using the AI gateway — hand out a value
   from `BROKER_AI_ALLOWED_TOKENS` to each instance you trust).

## Protocol reference (for anyone auditing this instead of trusting the code)

GitHub, mirrored exactly for Google with `/google/*`:

```
Instance                         Broker                          GitHub
   |--- GET /github/start ------->|
   |  ?instance_callback=<url>    |
   |  &instance_state=<opaque>    |
   |                              |--- redirect to github.com --->|
   |                                                               |
   |<---------------------------- redirect: instance_callback -----|
   |     ?code=<one-time>&state=<instance_state>   (via broker)   |
   |                                                               |
   |--- POST /github/exchange --->|
   |     {code}                   |
   |<--- {access_token, profile}--|
```

`instance_callback` must be `https://` (or `http://` to localhost only with
`BROKER_ALLOW_INSECURE_CALLBACKS=true`, for local dev). The broker never
sends a real access token to the browser — only the one-time exchange code,
which is single-use and expires in 2 minutes.
