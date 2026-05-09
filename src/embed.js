// Embedding adapters for OpenAI (and Ollama OpenAI-compat), and Gemini.
//
// All adapters accept an array of texts and resolve to:
//   { vectors: number[][], model: string }
// Vectors are returned in input order.

export const EMBED_PROVIDERS = Object.freeze(['openai', 'ollama', 'gemini']);

async function embedOpenAICompat({ apiKey, baseUrl, model, texts }) {
  const res = await fetch(`${baseUrl}/v1/embeddings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({ model, input: texts }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`embed HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  const vectors = data.data.sort((a, b) => a.index - b.index).map(d => d.embedding);
  return { vectors, model: data.model ?? model };
}

async function embedGemini({ apiKey, model, texts }) {
  if (!apiKey) throw new Error('GEMINI_API_KEY is required for gemini embed provider');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:batchEmbedContents?key=${apiKey}`;
  const requests = texts.map(text => ({
    model: `models/${model}`,
    content: { parts: [{ text }] },
  }));
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Gemini embed HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  return { vectors: (data.embeddings ?? []).map(e => e.values), model };
}

/**
 * Embed a batch of texts using the configured provider.
 *
 * @param {object} opts
 * @param {'openai'|'ollama'|'gemini'} opts.provider
 * @param {string} [opts.apiKey]
 * @param {string} [opts.baseUrl] - Override for Ollama (default: http://localhost:11434)
 * @param {string} opts.model
 * @param {string[]} opts.texts - Must be non-empty
 * @returns {Promise<{vectors: number[][], model: string}>}
 */
export async function embedBatch({ provider, apiKey, baseUrl, model, texts }) {
  if (!EMBED_PROVIDERS.includes(provider)) {
    throw new Error(`Unknown embed provider "${provider}". Valid: ${EMBED_PROVIDERS.join(', ')}`);
  }
  if (!model) throw new Error('embedBatch: model is required');
  if (!Array.isArray(texts) || texts.length === 0) {
    throw new Error('embedBatch: texts must be a non-empty array');
  }

  if (provider === 'gemini') return embedGemini({ apiKey, model, texts });

  if (provider === 'openai' && !apiKey) {
    throw new Error('OPENAI_API_KEY is required for openai embed provider');
  }

  const effectiveBaseUrl = provider === 'ollama'
    ? (baseUrl || 'http://localhost:11434')
    : 'https://api.openai.com';

  return embedOpenAICompat({ apiKey, baseUrl: effectiveBaseUrl, model, texts });
}
