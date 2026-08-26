// "Morpheus Cloud defaults" — the fallback tier used when THIS deployment's
// operator hasn't configured their own connector credentials.
//
// Every connector in this app resolves in the same three tiers, poorest to
// best-scoped:
//   1. Per-account override   (UserSettings row — AI/TTS only, see ai.js)
//   2. This deployment's env  (server/.env — GITHUB_CLIENT_ID, LLM_API_KEY, ...)
//   3. Morpheus Cloud default (this file — a shared broker/gateway operated
//      by the Morpheus project so a fresh self-host works out of the box
//      with zero API keys, then graduates to the operator's own credentials
//      whenever they're ready)
//
// MORPHEUS_BROKER_URL points at a deployment of `hosted-broker/` (see that
// directory's README) — a small, separate service that holds the *shared*
// OAuth app secrets and upstream AI key so this repo never needs to. Set it
// once; every connector below falls back to it automatically. Leave it
// unset (or point it at your own broker deployment) to disable cloud
// defaults entirely and require operator-supplied credentials everywhere.
//
// The placeholder below is not a live service — replace it via the
// MORPHEUS_BROKER_URL env var once a broker is actually deployed (see
// hosted-broker/README.md for deploy steps). Until then, every fallback in
// this file is inert and connectors simply require local configuration.
const DEFAULT_BROKER_URL = 'https://broker.morpheus.invalid';

export function brokerUrl() {
  const url = process.env.MORPHEUS_BROKER_URL;
  if (!url || url === DEFAULT_BROKER_URL) return null; // unconfigured = feature disabled, not "use the placeholder"
  return url.replace(/\/+$/, '');
}

export function brokerConfigured() {
  return Boolean(brokerUrl());
}

// AI gateway: reuses the broker host by default (one service, several
// routes) but can be pointed at a dedicated gateway via MORPHEUS_AI_GATEWAY_URL
// if the operator wants to split them.
export function aiGatewayDefault() {
  const dedicated = process.env.MORPHEUS_AI_GATEWAY_URL;
  const base = dedicated || brokerUrl();
  if (!base) return null;
  return {
    baseUrl: `${base.replace(/\/+$/, '')}/v1`,
    // A per-deployment identifier, NOT a real upstream API key — the
    // gateway maps this to its own metered upstream key server-side. Ask
    // the broker operator for one, or run `hosted-broker/` yourself and
    // mint your own. See hosted-broker/README.md.
    apiKey: process.env.MORPHEUS_AI_GATEWAY_TOKEN || null,
  };
}
