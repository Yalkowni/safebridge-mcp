// Minimal DeepSeek API client. Uses the OpenAI-compatible /chat/completions endpoint.
//
// This module deliberately has no retry logic and no streaming. The MCP layer
// can decide whether to retry. Streaming is a v2 feature.

const ENDPOINT = 'https://api.deepseek.com/chat/completions';

/**
 * @param {object} args
 * @param {string} args.apiKey
 * @param {string} args.model      - e.g. 'deepseek-v4-flash' | 'deepseek-v4-pro'
 * @param {Array<{role: string, content: string}>} args.messages
 * @param {number} [args.maxTokens=4096]
 * @param {number} [args.temperature=0]
 * @param {boolean} [args.thinkingEnabled=false] - Both v4-flash and v4-pro default
 *   thinking ON server-side; reasoning tokens consume max_tokens before any content
 *   is emitted, so for grep-style scans we explicitly disable. Pass true only when
 *   the task actually benefits from chain-of-thought (complex reasoning, codegen).
 * @param {'low'|'medium'|'high'|'max'} [args.reasoningEffort] - Only applied when
 *   thinkingEnabled=true. DeepSeek default is 'high'.
 * @param {number} [args.timeoutMs=120000]
 * @param {AbortSignal} [args.signal]
 * @returns {Promise<{ content: string, usage: object, model: string, finish_reason: string }>}
 */
export async function chat({
  apiKey,
  model,
  messages,
  maxTokens = 4096,
  temperature = 0,
  thinkingEnabled = false,
  reasoningEffort,
  timeoutMs = 120_000,
  signal,
}) {
  if (!apiKey) throw new Error('deepseek: apiKey is required');
  if (!model) throw new Error('deepseek: model is required');
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error('deepseek: messages must be a non-empty array');
  }

  // Combine timeout with caller's signal.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('deepseek timeout')), timeoutMs);
  const onAbort = () => controller.abort(signal?.reason ?? new Error('aborted'));
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: maxTokens,
        temperature,
        stream: false,
        thinking: { type: thinkingEnabled ? 'enabled' : 'disabled' },
        ...(thinkingEnabled && reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const truncated = body.length > 500 ? body.slice(0, 500) + '...' : body;
      throw new Error(`deepseek HTTP ${res.status}: ${truncated}`);
    }

    const data = await res.json();
    const choice = data.choices?.[0];
    if (!choice?.message) {
      throw new Error(`deepseek: malformed response (no choices[0].message)`);
    }
    return {
      content: choice.message.content ?? '',
      usage: data.usage ?? {},
      model: data.model ?? model,
      finish_reason: choice.finish_reason ?? 'unknown',
    };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}
