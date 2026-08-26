// OpenAI-compatible LLM client. Works with OpenAI, OpenRouter, Together,
// Groq, or any local server (Ollama / LM Studio in OpenAI-compat mode).
// Configure via env; no Base44 dependency.
//
//   LLM_BASE_URL  – e.g. https://api.openai.com/v1  (default)
//   LLM_API_KEY   – bearer token (falls back to OPENAI_API_KEY)
//   LLM_MODEL     – e.g. gpt-4o-mini (default)

const BASE_URL = (process.env.LLM_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
const API_KEY = process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || '';
const MODEL = process.env.LLM_MODEL || 'gpt-4o-mini';

export async function chat(messages, { json = false, temperature = 0.2, maxTokens } = {}) {
  if (!API_KEY) throw new Error('LLM_API_KEY (or OPENAI_API_KEY) is not set.');

  const body = { model: MODEL, messages, temperature };
  if (json) body.response_format = { type: 'json_object' };
  if (maxTokens) body.max_tokens = maxTokens;

  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`LLM request failed (${res.status}): ${txt.slice(0, 500)}`);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content || '';
  if (json) {
    try { return JSON.parse(content); }
    catch { throw new Error(`LLM did not return valid JSON: ${content.slice(0, 200)}`); }
  }
  return content;
}