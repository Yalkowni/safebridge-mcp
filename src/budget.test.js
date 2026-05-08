import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkBudget,
  recordCost,
  PRICING,
  estimateCost,
  actualCost,
  estimateTokens,
} from './budget.js';

function tmpPath() {
  const dir = mkdtempSync(join(tmpdir(), 'safebridge-budget-'));
  return { path: join(dir, 'budget.json'), dir };
}

test('checkBudget: empty state passes within cap', () => {
  const { path, dir } = tmpPath();
  try {
    const r = checkBudget(path, 2.0, 0.001);
    assert.equal(r.ok, true);
    assert.equal(r.spent, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recordCost: persists and returns new state', () => {
  const { path, dir } = tmpPath();
  try {
    const s1 = recordCost(path, 0.05);
    assert.equal(s1.spent_usd, 0.05);
    assert.equal(s1.calls, 1);
    const s2 = recordCost(path, 0.10);
    assert.ok(Math.abs(s2.spent_usd - 0.15) < 1e-9);
    assert.equal(s2.calls, 2);
    // Verify it actually wrote to disk
    const onDisk = JSON.parse(readFileSync(path, 'utf8'));
    assert.ok(Math.abs(onDisk.spent_usd - 0.15) < 1e-9);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('checkBudget: refuses when over cap', () => {
  const { path, dir } = tmpPath();
  try {
    recordCost(path, 1.95);
    const r = checkBudget(path, 2.0, 0.10);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'budget_exceeded');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('checkBudget: corrupt file resets to empty', () => {
  const { path, dir } = tmpPath();
  try {
    writeFileSync(path, 'not valid json');
    const r = checkBudget(path, 2.0, 0.001);
    assert.equal(r.ok, true);
    assert.equal(r.spent, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('checkBudget: previous-day state resets', () => {
  const { path, dir } = tmpPath();
  try {
    writeFileSync(path, JSON.stringify({ date: '2020-01-01', spent_usd: 99, calls: 100 }));
    const r = checkBudget(path, 2.0, 0.10);
    assert.equal(r.ok, true);
    assert.equal(r.spent, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('PRICING: known models have positive rates', () => {
  for (const [name, rates] of Object.entries(PRICING)) {
    assert.ok(rates.input_uncached > 0, `${name} input_uncached`);
    assert.ok(rates.output > 0, `${name} output`);
    assert.ok(rates.input_cached <= rates.input_uncached, `${name}: cached <= uncached`);
  }
});

test('estimateCost: flash is cheaper than pro', () => {
  const flash = estimateCost('deepseek-v4-flash', 100_000, 4000);
  const pro = estimateCost('deepseek-v4-pro', 100_000, 4000);
  assert.ok(flash < pro);
  assert.ok(flash > 0);
});

test('estimateCost: unknown model returns 0', () => {
  assert.equal(estimateCost('made-up-model', 1000, 1000), 0);
});

test('actualCost: respects cache hits', () => {
  const allCached = actualCost('deepseek-v4-flash', {
    prompt_tokens: 100_000,
    prompt_cache_hit_tokens: 100_000,
    completion_tokens: 0,
  });
  const allUncached = actualCost('deepseek-v4-flash', {
    prompt_tokens: 100_000,
    prompt_cache_hit_tokens: 0,
    completion_tokens: 0,
  });
  assert.ok(allCached < allUncached);
  assert.ok(allCached > 0);
});

test('actualCost: matches manual calculation', () => {
  // 1M cached input on flash = $0.028
  const c = actualCost('deepseek-v4-flash', {
    prompt_tokens: 1_000_000,
    prompt_cache_hit_tokens: 1_000_000,
    completion_tokens: 0,
  });
  assert.ok(Math.abs(c - 0.028) < 1e-9, `expected 0.028, got ${c}`);
});

test('estimateTokens: rough but sane', () => {
  // "hello world" = 11 chars → ~3.7 tokens, padded to ~4.
  assert.ok(estimateTokens('hello world') >= 3 && estimateTokens('hello world') <= 6);
  assert.equal(estimateTokens(''), 0);
  // Big input
  const big = 'x'.repeat(300_000);
  assert.ok(estimateTokens(big) >= 100_000);
});
