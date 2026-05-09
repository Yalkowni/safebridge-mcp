// Multi-provider chat adapter. Routes to the right provider backend and
// normalizes all responses to:
//   { content: string, usage: { prompt_tokens, completion_tokens, prompt_cache_hit_tokens }, model: string, finish_reason: string }
//
// Supported providers: deepseek | openai | ollama | gemini
//
// DeepSeek is handled by the existing deepseek.js module (OpenAI-compatible
// endpoint with a thinking control extension). OpenAI and Ollama share the
// same OpenAI-compatible path. Gemini uses Google's REST API shape.

import { chat as deepseekChat } from './deepseek.js';

export const PROVIDERS = Object.freeze(['deepseek', 'openai', 'ollama', 'gemini']);

// ---- OpenAI-compatible (openai, ollama) ----

async function chatOpenAICompat({ endpoint, apiKey, model, messages, maxTokens, temperature, timeoutMs, signal }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('safebridge: request timeout')), timeoutMs);
  const onAbort = () => controller.abort(signal?.reason ?? new Error('aborted'));
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature, stream: false }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${body.length > 500 ? body.slice(0, 500) + '...' : body}`);
    }

    const data = await res.json();
    const choice = data.choices?.[0];
    if (!choice?.message) throw new Error('malformed response (no choices[0].message)');

    // Normalize OpenAI cached-token field → common shape used by actualCost().
    const raw = data.usage ?? {};
    return {
      content: choice.message.content ?? '',
      usage: {
        prompt_tokens: raw.prompt_tokens ?? 0,
        completion_tokens: raw.completion_tokens ?? 0,
        prompt_cache_hit_tokens: raw.prompt_tokens_details?.cached_tokens ?? 0,
      },
      model: data.model ?? model,
      finish_reason: choice.finish_reason ?? 'unknown',
    };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

// ---- Gemini ----

async function chatGemini({ apiKey, model, messages, maxTokens, temperature, timeoutMs, signal }) {
  // Convert OpenAI-style message array to Gemini format:
  //   system role → top-level systemInstruction
  //   assistant role → role:'model' in contents
  const systemMsg = messages.find(m => m.role === 'system');
  const otherMsgs = messages.filter(m => m.role !== 'system');

  const body = {
    contents: otherMsgs.map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    })),
    generationConfig: { maxOutputTokens: maxTokens, temperature },
  };
  if (systemMsg) body.systemInstruction = { parts: [{ text: systemMsg.content }] };

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('safebridge: request timeout')), timeoutMs);
  const onAbort = () => controller.abort(signal?.reason ?? new Error('aborted'));
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${text.length > 500 ? text.slice(0, 500) + '...' : text}`);
    }

    const data = await res.json();
    const candidate = data.candidates?.[0];
    if (!candidate?.content) throw new Error('malformed response (no candidates[0].content)');
    const content = candidate.content.parts?.map(p => p.text ?? '').join('') ?? '';
    const meta = data.usageMetadata ?? {};

    return {
      content,
      usage: {
        prompt_tokens: meta.promptTokenCount ?? 0,
        completion_tokens: meta.candidatesTokenCount ?? 0,
        prompt_cache_hit_tokens: meta.cachedContentTokenCount ?? 0,
      },
      model,
      finish_reason: candidate.finishReason ?? 'unknown',
    };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

// ---- Unified entry point ----

/**
 * @param {object} args
 * @param {'deepseek'|'openai'|'ollama'|'gemini'} args.provider
 * @param {string} [args.apiKey]
 * @param {string} [args.baseUrl]  - Ollama base URL or custom OpenAI-compat endpoint
 * @param {string} args.model
 * @param {Array<{role:string,content:string}>} args.messages
 * @param {number} [args.maxTokens]
 * @param {number} [args.temperature]
 * @param {boolean} [args.thinkingEnabled]  - DeepSeek only
 * @param {string} [args.reasoningEffort]   - DeepSeek only
 * @param {number} [args.timeoutMs]
 * @param {AbortSignal} [args.signal]
 */
export async function chat({
  provider = 'deepseek',
  apiKey,
  baseUrl,
  model,
  messages,
  maxTokens = 4096,
  temperature = 0,
  thinkingEnabled = false,
  reasoningEffort,
  timeoutMs = 120_000,
  signal,
}) {
  if (!PROVIDERS.includes(provider)) {
    throw new Error(`providers: unknown provider "${provider}". Valid: ${PROVIDERS.join(', ')}`);
  }
  if (!model) throw new Error('providers: model is required');
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error('providers: messages must be a non-empty array');
  }

  if (provider === 'deepseek') {
    return deepseekChat({ apiKey, model, messages, maxTokens, temperature, thinkingEnabled, reasoningEffort, timeoutMs, signal });
  }

  if (provider === 'gemini') {
    if (!apiKey) throw new Error('providers: GEMINI_API_KEY is required for gemini provider');
    return chatGemini({ apiKey, model, messages, maxTokens, temperature, timeoutMs, signal });
  }

  // openai | ollama — both use OpenAI-compatible /v1/chat/completions
  const endpoint = provider === 'ollama'
    ? (baseUrl ?? 'http://localhost:11434') + '/v1/chat/completions'
    : (baseUrl ?? 'https://api.openai.com/v1/chat/completions');
  return chatOpenAICompat({ endpoint, apiKey: apiKey ?? '', model, messages, maxTokens, temperature, timeoutMs, signal });
}
