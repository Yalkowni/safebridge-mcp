// Unit tests for embed.js. Node built-in test runner.
// No real network calls — fetch is mocked per test.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { embedBatch, EMBED_PROVIDERS } from './embed.js';

describe('embedBatch', () => {
  let originalFetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('EMBED_PROVIDERS is frozen and contains expected values', () => {
    assert.ok(Object.isFrozen(EMBED_PROVIDERS));
    assert.deepEqual([...EMBED_PROVIDERS], ['openai', 'ollama', 'gemini']);
  });

  it('rejects unknown provider', async () => {
    await assert.rejects(
      () => embedBatch({ provider: 'fakeai', model: 'm', texts: ['hi'] }),
      /Unknown embed provider/,
    );
  });

  it('rejects missing model', async () => {
    await assert.rejects(
      () => embedBatch({ provider: 'ollama', model: '', texts: ['hi'] }),
      /model is required/,
    );
  });

  it('rejects empty texts array', async () => {
    await assert.rejects(
      () => embedBatch({ provider: 'ollama', model: 'nomic-embed-text', texts: [] }),
      /non-empty array/,
    );
  });

  // ---- OpenAI ----

  it('openai: sends Bearer auth and returns vectors sorted by index', async () => {
    let captured;
    globalThis.fetch = async (url, opts) => {
      captured = { url, opts };
      return {
        ok: true,
        json: async () => ({
          data: [
            { index: 1, embedding: [0.2, 0.3] },
            { index: 0, embedding: [0.0, 0.1] },
          ],
          model: 'text-embedding-3-small',
        }),
      };
    };
    const r = await embedBatch({
      provider: 'openai',
      apiKey: 'sk-test',
      model: 'text-embedding-3-small',
      texts: ['first', 'second'],
    });
    assert.deepEqual(r.vectors, [[0.0, 0.1], [0.2, 0.3]]);
    assert.equal(r.model, 'text-embedding-3-small');
    assert.ok(captured.opts.headers['Authorization'].startsWith('Bearer sk-test'));
    assert.ok(captured.url.includes('openai.com'));
  });

  it('openai: requires apiKey', async () => {
    await assert.rejects(
      () => embedBatch({ provider: 'openai', model: 'text-embedding-3-small', texts: ['hi'] }),
      /OPENAI_API_KEY/,
    );
  });

  it('openai: throws on HTTP error', async () => {
    globalThis.fetch = async () => ({ ok: false, status: 429, text: async () => 'rate limited' });
    await assert.rejects(
      () => embedBatch({ provider: 'openai', apiKey: 'sk-k', model: 'm', texts: ['hi'] }),
      /embed HTTP 429/,
    );
  });

  // ---- Ollama ----

  it('ollama: no auth header, uses localhost by default', async () => {
    let captured;
    globalThis.fetch = async (url, opts) => {
      captured = { url, opts };
      return {
        ok: true,
        json: async () => ({
          data: [{ index: 0, embedding: [0.5, 0.6] }],
          model: 'nomic-embed-text',
        }),
      };
    };
    const r = await embedBatch({
      provider: 'ollama',
      model: 'nomic-embed-text',
      texts: ['hello'],
    });
    assert.deepEqual(r.vectors, [[0.5, 0.6]]);
    assert.ok(captured.url.includes('localhost:11434'));
    assert.ok(!captured.opts.headers['Authorization']);
  });

  it('ollama: respects custom baseUrl', async () => {
    let capturedUrl;
    globalThis.fetch = async (url) => {
      capturedUrl = url;
      return {
        ok: true,
        json: async () => ({ data: [{ index: 0, embedding: [1, 0] }], model: 'm' }),
      };
    };
    await embedBatch({
      provider: 'ollama',
      baseUrl: 'http://192.168.1.10:11434',
      model: 'nomic-embed-text',
      texts: ['hi'],
    });
    assert.ok(capturedUrl.startsWith('http://192.168.1.10:11434'));
  });

  // ---- Gemini ----

  it('gemini: requires apiKey', async () => {
    await assert.rejects(
      () => embedBatch({ provider: 'gemini', model: 'text-embedding-004', texts: ['hi'] }),
      /GEMINI_API_KEY/,
    );
  });

  it('gemini: posts batchEmbedContents with correct shape', async () => {
    let captured;
    globalThis.fetch = async (url, opts) => {
      captured = { url, opts };
      return {
        ok: true,
        json: async () => ({
          embeddings: [
            { values: [0.1, 0.2, 0.3] },
            { values: [0.4, 0.5, 0.6] },
          ],
        }),
      };
    };
    const r = await embedBatch({
      provider: 'gemini',
      apiKey: 'gm-key',
      model: 'text-embedding-004',
      texts: ['foo', 'bar'],
    });
    assert.deepEqual(r.vectors, [[0.1, 0.2, 0.3], [0.4, 0.5, 0.6]]);
    assert.equal(r.model, 'text-embedding-004');
    assert.ok(captured.url.includes('batchEmbedContents'));
    assert.ok(captured.url.includes('gm-key'));
    const body = JSON.parse(captured.opts.body);
    assert.ok(Array.isArray(body.requests));
    assert.equal(body.requests.length, 2);
    assert.equal(body.requests[0].content.parts[0].text, 'foo');
    assert.equal(body.requests[1].content.parts[0].text, 'bar');
  });

  it('gemini: throws on HTTP error', async () => {
    globalThis.fetch = async () => ({ ok: false, status: 400, text: async () => 'bad request' });
    await assert.rejects(
      () => embedBatch({ provider: 'gemini', apiKey: 'k', model: 'text-embedding-004', texts: ['hi'] }),
      /Gemini embed HTTP 400/,
    );
  });
});
