// OpenAI-compatible LLM client. Works with OpenAI, OpenRouter, Together,
// Groq, or any local server (Ollama / LM Studio in OpenAI-compat mode).
// Configure via env; no Base44 dependency.
//
//   LLM_BASE_URL       – e.g. https://api.openai.com/v1  (default)
//   LLM_API_KEY        – bearer token (falls back to OPENAI_API_KEY)
//   LLM_MODEL          – e.g. gpt-4o-mini (default)
//   LLM_PLANNER_MODEL  – override for the planning agent
//   LLM_CODER_MODEL    – override for the coding agent
//   LLM_REVIEWER_MODEL – override for the review agent
//
// chat(messages, { json, schema, temperature, maxTokens, role, fileUrls })
//   - json:      request JSON-object response_format
//   - schema:    JSON schema; when set, the response is parsed into an object
//   - role:      'planner' | 'coder' | 'reviewer' → picks the role model override
//   - fileUrls:  image URLs attached as vision content parts
// Returns { content, model, usage } where content is a string (no schema) or an
// object (schema set). Throws OUTPUT_TRUNCATED when the model hits the token
// limit mid-output so callers can reduce batch size and retry.

const BASE_URL = (process.env.LLM_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
const API_KEY = process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || '';
const DEFAULT_MODEL = process.env.LLM_MODEL || 'gpt-4o-mini';

const ROLE_MODELS = {
  planner: process.env.LLM_PLANNER_MODEL,
  coder: process.env.LLM_CODER_MODEL,
  reviewer: process.env.LLM_REVIEWER_MODEL,
};

function resolveModel(role) {
  if (role && ROLE_MODELS[role]) return ROLE_MODELS[role];
  return DEFAULT_MODEL;
}

export async function chat(messages, { json = false, schema, temperature = 0.7, maxTokens, role, fileUrls } = {}) {
  if (!API_KEY) throw new Error('LLM_API_KEY (or OPENAI_API_KEY) is not set.');
  const model = resolveModel(role);

  // Attach image URLs as vision content parts on the last user message.
  const imageUrls = (fileUrls || []).filter((u) => /\.(png|jpe?g|gif|webp|bmp|svg)(\?|$)/i.test(u));
  const otherUrls = (fileUrls || []).filter((u) => !imageUrls.includes(u));

  let finalMessages = messages;
  if (otherUrls.length > 0 && finalMessages.length > 0) {
    finalMessages = finalMessages.map((m, i) =>
      i === finalMessages.length - 1 && m.role === 'user'
        ? { ...m, content: `${m.content}\n\nUPLOADED REFERENCE FILES (URLs):\n${otherUrls.map((u) => '- ' + u).join('\n')}` }
        : m
    );
  }
  if (imageUrls.length > 0 && finalMessages.length > 0) {
    const last = finalMessages[finalMessages.length - 1];
    if (last.role === 'user' && typeof last.content === 'string') {
      const content = [{ type: 'text', text: last.content }];
      imageUrls.forEach((u) => content.push({ type: 'image_url', image_url: { url: u } }));
      finalMessages = [...finalMessages.slice(0, -1), { role: 'user', content }];
    }
  }

  const body = { model, messages: finalMessages, temperature };
  if (json || schema) body.response_format = { type: 'json_object' };
  if (maxTokens) body.max_tokens = maxTokens;

  let prompt = finalMessages.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
  if (schema) {
    prompt += `\n\nRespond with ONLY a valid JSON object (no markdown fences, no extra prose) matching this exact schema:\n${JSON.stringify(schema)}`;
    // Append the JSON instruction to the text part of a vision message.
    if (imageUrls.length > 0 && Array.isArray(finalMessages[finalMessages.length - 1].content)) {
      finalMessages[finalMessages.length - 1].content[0].text += `\n\nRespond with ONLY a valid JSON object (no markdown fences, no extra prose) matching this exact schema:\n${JSON.stringify(schema)}`;
      body.messages = finalMessages;
    } else {
      body.messages = finalMessages.map((m, i) =>
        i === finalMessages.length - 1 && typeof m.content === 'string'
          ? { ...m, content: m.content + `\n\nRespond with ONLY a valid JSON object (no markdown fences, no extra prose) matching this exact schema:\n${JSON.stringify(schema)}` }
          : m
      );
    }
  }

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
  const usage = data?.usage;
  const choice = data?.choices?.[0];
  const content = choice?.message?.content || '';
  const finishReason = choice?.finish_reason;

  if (content == null) throw new Error('LLM returned no content.');

  // Detect token-limit truncation.
  if (finishReason === 'length') {
    throw new Error('OUTPUT_TRUNCATED: The AI response was cut off by the token limit before it could finish. Reduce the number of files per step (2-3 max) and retry.');
  }

  if (schema) {
    try {
      return { content: JSON.parse(content), model, usage };
    } catch {
      const trimmed = content.trimEnd();
      if (!trimmed.endsWith('}') && !trimmed.endsWith(']')) {
        throw new Error('OUTPUT_TRUNCATED: The AI response was cut off mid-JSON before it could finish. Reduce the number of files per step (2-3 max) and retry.');
      }
      throw new Error('LLM did not return valid JSON: ' + content.slice(0, 200));
    }
  }
  if (json) {
    try { return { content: JSON.parse(content), model, usage }; }
    catch { return { content, model, usage }; }
  }
  return { content, model, usage };
}