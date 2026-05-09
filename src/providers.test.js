// Unit tests for the multi-provider adapter (providers.js).
// Uses Node's built-in test runner. No real network calls — fetch is mocked per test.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { chat, PROVIDERS } from './providers.js';

describe('providers', () => {
  let originalFetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('PROVIDERS list is frozen and contains expected values', () => {
    assert.ok(Object.isFrozen(PROVIDERS));
    assert.deepEqual([...PROVIDERS], ['deepseek', 'openai', 'ollama', 'gemini']);
  });

  it('rejects unknown provider', async () => {
    await assert.rejects(
      () => chat({ provider: 'fakeai', model: 'x', messages: [{ role: 'user', content: 'hi' }] }),
      /unknown provider/,
    );
  });

  it('rejects missing model', async () => {
    await assert.rejects(
      () => chat({ provider: 'ollama', model: '', messages: [{ role: 'user', content: 'hi' }] }),
      /model is required/,
    );
  });

  it('rejects empty messages array', async () => {
    await assert.rejects(
      () => chat({ provider: 'ollama', model: 'x', messages: [] }),
      /non-empty array/,
    );
  });

  // ---- OpenAI-compat (openai) ----

  it('openai: sends Bearer auth and normalizes cached token usage', async () => {
    let captured;
    globalThis.fetch = async (url, opts) => {
      captured = { url, opts };
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 20,
            prompt_tokens_details: { cached_tokens: 40 },
          },
          model: 'gpt-4o-mini',
        }),
      };
    };
    const r = await chat({
      provider: 'openai',
      apiKey: 'sk-test',
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
      timeoutMs: 5000,
    });
    assert.equal(r.content, 'hello');
    assert.equal(r.usage.prompt_tokens, 100);
    assert.equal(r.usage.completion_tokens, 20);
    assert.equal(r.usage.prompt_cache_hit_tokens, 40);
    assert.equal(r.finish_reason, 'stop');
    assert.ok(captured.opts.headers['Authorization'].startsWith('Bearer sk-test'));
    assert.ok(captured.url.includes('openai.com'));
  });

  it('openai: prompt_cache_hit_tokens defaults to 0 when missing', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
        model: 'gpt-4o-mini',
      }),
    });
    const r = await chat({
      provider: 'openai',
      apiKey: 'sk-test',
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
      timeoutMs: 5000,
    });
    assert.equal(r.usage.prompt_cache_hit_tokens, 0);
  });

  it('openai: throws on HTTP error', async () => {
    globalThis.fetch = async () => ({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized',
    });
    await assert.rejects(
      () => chat({
        provider: 'openai',
        apiKey: 'bad-key',
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'hi' }],
        timeoutMs: 5000,
      }),
      /HTTP 401/,
    );
  });

  // ---- Ollama ----

  it('ollama: uses localhost endpoint, no auth header', async () => {
    let captured;
    globalThis.fetch = async (url, opts) => {
      captured = { url, opts };
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'ollama says hi' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
          model: 'llama3.3',
        }),
      };
    };
    const r = await chat({
      provider: 'ollama',
      model: 'llama3.3',
      messages: [{ role: 'user', content: 'hi' }],
      timeoutMs: 5000,
    });
    assert.equal(r.content, 'ollama says hi');
    assert.equal(r.usage.prompt_cache_hit_tokens, 0);
    assert.ok(captured.url.includes('localhost:11434'));
    assert.ok(!captured.opts.headers['Authorization']);
  });

  it('ollama: respects custom baseUrl', async () => {
    let capturedUrl;
    globalThis.fetch = async (url) => {
      capturedUrl = url;
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 2 },
          model: 'llama3.3',
        }),
      };
    };
    await chat({
      provider: 'ollama',
      baseUrl: 'http://192.168.1.5:11434',
      model: 'llama3.3',
      messages: [{ role: 'user', content: 'hi' }],
      timeoutMs: 5000,
    });
    assert.ok(capturedUrl.startsWith('http://192.168.1.5:11434'));
  });

  // ---- Gemini ----

  it('gemini: converts system message to systemInstruction', async () => {
    let capturedBody;
    globalThis.fetch = async (url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return {
        ok: true,
        json: async () => ({
          candidates: [{
            content: { parts: [{ text: 'gemini says hi' }] },
            finishReason: 'STOP',
          }],
          usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 10, cachedContentTokenCount: 0 },
        }),
      };
    };
    const r = await chat({
      provider: 'gemini',
      apiKey: 'gm-key',
      model: 'gemini-2.0-flash',
      messages: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'hi' },
      ],
      timeoutMs: 5000,
    });
    assert.equal(r.content, 'gemini says hi');
    assert.deepEqual(capturedBody.systemInstruction, { parts: [{ text: 'You are helpful.' }] });
    // system message must NOT appear in contents
    assert.ok(!capturedBody.contents.some(c => c.role === 'system'));
    assert.equal(capturedBody.contents.length, 1);
    assert.equal(capturedBody.contents[0].role, 'user');
  });

  it('gemini: converts assistant role to model', async () => {
    let capturedBody;
    globalThis.fetch = async (url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return {
        ok: true,
        json: async () => ({
          candidates: [{
            content: { parts: [{ text: 'ok' }] },
            finishReason: 'STOP',
          }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
        }),
      };
    };
    await chat({
      provider: 'gemini',
      apiKey: 'gm-key',
      model: 'gemini-2.0-flash',
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi back' },
        { role: 'user', content: 'thanks' },
      ],
      timeoutMs: 5000,
    });
    const roles = capturedBody.contents.map(c => c.role);
    assert.deepEqual(roles, ['user', 'model', 'user']);
  });

  it('gemini: normalizes usageMetadata with cached tokens', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        candidates: [{
          content: { parts: [{ text: 'answer' }] },
          finishReason: 'STOP',
        }],
        usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 15, cachedContentTokenCount: 20 },
      }),
    });
    const r = await chat({
      provider: 'gemini',
      apiKey: 'gm-key',
      model: 'gemini-2.5-flash',
      messages: [{ role: 'user', content: 'hi' }],
      timeoutMs: 5000,
    });
    assert.equal(r.usage.prompt_tokens, 50);
    assert.equal(r.usage.completion_tokens, 15);
    assert.equal(r.usage.prompt_cache_hit_tokens, 20);
    assert.equal(r.content, 'answer');
    assert.equal(r.finish_reason, 'STOP');
    assert.equal(r.model, 'gemini-2.5-flash');
  });

  it('gemini: prompt_cache_hit_tokens defaults to 0 when missing', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        candidates: [{
          content: { parts: [{ text: 'ok' }] },
          finishReason: 'STOP',
        }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4 },
      }),
    });
    const r = await chat({
      provider: 'gemini',
      apiKey: 'gm-key',
      model: 'gemini-2.0-flash',
      messages: [{ role: 'user', content: 'hi' }],
      timeoutMs: 5000,
    });
    assert.equal(r.usage.prompt_cache_hit_tokens, 0);
  });

  it('gemini: requires apiKey', async () => {
    await assert.rejects(
      () => chat({
        provider: 'gemini',
        model: 'gemini-2.0-flash',
        messages: [{ role: 'user', content: 'hi' }],
        timeoutMs: 5000,
      }),
      /GEMINI_API_KEY/,
    );
  });

  it('gemini: throws on HTTP error', async () => {
    globalThis.fetch = async () => ({
      ok: false,
      status: 403,
      text: async () => 'Forbidden',
    });
    await assert.rejects(
      () => chat({
        provider: 'gemini',
        apiKey: 'bad-key',
        model: 'gemini-2.0-flash',
        messages: [{ role: 'user', content: 'hi' }],
        timeoutMs: 5000,
      }),
      /HTTP 403/,
    );
  });
});
