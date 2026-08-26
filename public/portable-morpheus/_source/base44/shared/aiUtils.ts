// Shared AI invocation. Uses the operator's custom OpenAI-compatible endpoint when
// configured in their UserSettings, otherwise falls back to the platform InvokeLLM.
// "Custom" covers OpenAI, OpenRouter, Together, Groq, Ollama, LM Studio, etc.
//
// The `role` parameter ('planner' | 'coder') lets callers request a role-specific
// model override from UserSettings (planner_model / coder_model). When set, that
// model is used instead of the default — enabling a high-think planner paired
// with a fast lightweight coder in the autonomous build pipeline.

export async function getUserSettings(base44): Promise<any | null> {
  try {
    const rows = await base44.entities.UserSettings.filter({}, '-updated_date', 1);
    return rows[0] || null;
  } catch {
    return null;
  }
}

export interface InvokeAIResult {
  result: any;
  provider: 'platform' | 'custom';
  model: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

// Returns { result, provider, model } so callers can log the exact toolchain
// that produced the output. `model` is the resolved model name (role override
// if set, else the default); `provider` is 'platform' or 'custom'.
export async function invokeAI(
  base44,
  prompt: string,
  responseJsonSchema?: any,
  fileUrls?: string[],
  role?: 'planner' | 'coder' | 'reviewer' | 'diagnosis'
): Promise<InvokeAIResult> {
  const settings = await getUserSettings(base44);

  // Resolve role-specific model override
  let modelOverride: string | undefined;
  if (role === 'planner' && settings?.planner_model) modelOverride = settings.planner_model;
  else if (role === 'coder' && settings?.coder_model) modelOverride = settings.coder_model;
  else if (role === 'reviewer' && settings?.reviewer_model) modelOverride = settings.reviewer_model;
  else if (role === 'diagnosis' && settings?.diagnosis_model) modelOverride = settings.diagnosis_model;

  const custom =
    settings &&
    settings.ai_mode === 'custom' &&
    settings.ai_base_url &&
    settings.ai_api_key &&
    settings.ai_model;

  if (!custom) {
    // Platform default — pass model override if set
    const args: any = { prompt };
    if (responseJsonSchema) args.response_json_schema = responseJsonSchema;
    if (fileUrls && fileUrls.length > 0) args.file_urls = fileUrls;
    if (modelOverride) args.model = modelOverride;
    const result = await base44.asServiceRole.integrations.Core.InvokeLLM(args);
    return { result, provider: 'platform', model: modelOverride || 'automatic' };
  }

  // Custom endpoint: use role-specific model if set, else the default ai_model
  const model = modelOverride || settings.ai_model;

  // Attach image URLs as vision content parts, list others as text
  const imageUrls = (fileUrls || []).filter(u => /\.(png|jpe?g|gif|webp|bmp|svg)(\?|$)/i.test(u));
  const otherUrls = (fileUrls || []).filter(u => !imageUrls.includes(u));
  let effectivePrompt = prompt;
  if (otherUrls.length > 0) {
    effectivePrompt += `\n\nUPLOADED REFERENCE FILES (URLs):\n${otherUrls.map(u => '- ' + u).join('\n')}`;
  }

  const base = String(settings.ai_base_url).replace(/\/+$/, '');
  const url = `${base}/chat/completions`;
  let messages;
  if (imageUrls.length > 0) {
    const content: any[] = [{ type: 'text', text: effectivePrompt }];
    imageUrls.forEach(u => content.push({ type: 'image_url', image_url: { url: u } }));
    messages = [{ role: 'user', content }];
  } else {
    messages = [{ role: 'user', content: effectivePrompt }];
  }
  // No max_tokens cap — let each model use its full output window (max think power).
  // The API defaults to its own maximum when max_tokens is omitted.
  const body: any = {
    model,
    messages,
    temperature: 0.7
  };
  if (responseJsonSchema) {
    body.response_format = { type: 'json_object' };
    const jsonInstruction = `\n\nRespond with ONLY a valid JSON object (no markdown fences, no extra prose) matching this exact schema:\n${JSON.stringify(responseJsonSchema)}`;
    // Preserve image content parts for vision+JSON requests — append the
    // JSON instruction to the text part rather than replacing the whole message
    if (imageUrls.length > 0) {
      (messages[0].content as any[])[0].text += jsonInstruction;
    } else {
      (messages[0].content as string) += jsonInstruction;
    }
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${settings.ai_api_key}`
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Custom AI endpoint error (${res.status}): ${errText.slice(0, 300)}`);
  }

  const data = await res.json();
  const usage = data?.usage;
  const choice = data?.choices?.[0];
  const content = choice?.message?.content;
  const finishReason = choice?.finish_reason;
  if (content == null) throw new Error('Custom AI returned no content');

  // Detect token-limit truncation. The model hit max_tokens before finishing —
  // the JSON or text is cut off mid-way. Throw a sentinel error so callers
  // (especially the autonomous loop) can react: reduce batch size and continue.
  if (finishReason === 'length') {
    throw new Error('OUTPUT_TRUNCATED: The AI response was cut off by the token limit before it could finish. Reduce the number of files per step (2-3 max) and retry.');
  }

  if (responseJsonSchema) {
    try {
      return { result: JSON.parse(content), provider: 'custom', model, usage };
    } catch {
      // JSON parse failed — could be truncation that wasn't flagged, or bad output.
      // Check if the content looks like it was cut off mid-JSON.
      const trimmed = content.trimEnd();
      if (!trimmed.endsWith('}') && !trimmed.endsWith(']')) {
        throw new Error('OUTPUT_TRUNCATED: The AI response was cut off mid-JSON before it could finish. Reduce the number of files per step (2-3 max) and retry.');
      }
      throw new Error('Custom AI did not return valid JSON');
    }
  }
  return { result: content, provider: 'custom', model, usage };
}