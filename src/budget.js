// Daily budget tracker. Persists to a JSON sidecar file. Resets at UTC midnight.
//
// State file format:
//   { "date": "YYYY-MM-DD", "spent_usd": 1.234567, "calls": 17 }

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

function utcDate() {
  return new Date().toISOString().slice(0, 10);
}

function readState(path) {
  if (!existsSync(path)) return { date: utcDate(), spent_usd: 0, calls: 0 };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed.date !== utcDate()) {
      // New day - reset.
      return { date: utcDate(), spent_usd: 0, calls: 0 };
    }
    return {
      date: parsed.date,
      spent_usd: Number(parsed.spent_usd) || 0,
      calls: Number(parsed.calls) || 0,
    };
  } catch {
    // Corrupt - reset rather than fail. Caller can observe via audit log.
    return { date: utcDate(), spent_usd: 0, calls: 0 };
  }
}

function writeState(path, state) {
  writeFileSync(path, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

/**
 * Check whether `estimatedCost` would fit within today's remaining budget.
 * Does not modify state.
 *
 * Note: checkBudget and recordCost are not atomic. Two concurrent calls could
 * both pass the check before either records cost. In practice MCP clients call
 * tools sequentially so this is theoretical, but do not rely on this for
 * hard financial controls — treat the cap as a soft guardrail.
 */
export function checkBudget(path, dailyCapUsd, estimatedCost) {
  const state = readState(path);
  const remaining = dailyCapUsd - state.spent_usd;
  if (estimatedCost > remaining) {
    return { ok: false, reason: 'budget_exceeded', spent: state.spent_usd, remaining, dailyCap: dailyCapUsd };
  }
  return { ok: true, spent: state.spent_usd, remaining };
}

/**
 * Record an actual cost incurred. Returns the new state.
 */
export function recordCost(path, actualCost) {
  const state = readState(path);
  state.spent_usd += actualCost;
  state.calls += 1;
  writeState(path, state);
  return state;
}

/**
 * Per-million-token rates in USD. Used for pre-flight cost estimates and budget tracking.
 * Unknown model → estimateCost/actualCost return 0 (no budget gate, no cost recorded).
 * Sources: deepseek.com/pricing, platform.openai.com/docs/pricing, ai.google.dev/pricing
 */
export const PRICING = Object.freeze({
  // DeepSeek (real model IDs as of 2026-05)
  'deepseek-chat':     { input_cached: 0.028, input_uncached: 0.14,  output: 0.28  },
  'deepseek-reasoner': { input_cached: 0.145, input_uncached: 1.74,  output: 3.48  },
  // Legacy aliases kept for backward compat
  'deepseek-v4-flash': { input_cached: 0.028, input_uncached: 0.14,  output: 0.28  },
  'deepseek-v4-pro':   { input_cached: 0.145, input_uncached: 1.74,  output: 3.48  },
  // OpenAI
  'gpt-4o-mini':       { input_cached: 0.075, input_uncached: 0.15,  output: 0.60  },
  'gpt-4o':            { input_cached: 1.25,  input_uncached: 2.50,  output: 10.00 },
  'o3-mini':           { input_cached: 0.55,  input_uncached: 1.10,  output: 4.40  },
  'o4-mini':           { input_cached: 0.275, input_uncached: 1.10,  output: 4.40  },
  // Gemini
  'gemini-2.0-flash':  { input_cached: 0.0,   input_uncached: 0.10,  output: 0.40  },
  'gemini-2.5-flash':  { input_cached: 0.018, input_uncached: 0.15,  output: 0.60  },
  'gemini-2.5-pro':    { input_cached: 0.313, input_uncached: 1.25,  output: 10.00 },
  // Ollama: local, always $0 — any model string returns 0 via the unknown-model fallback
  // Embedding models (openai/gemini/ollama) return 0 via the unknown-model fallback;
  // embedding costs are negligible and tracked separately in the audit log.
});

/**
 * Estimate cost for a call before sending it. Pessimistic: assumes uncached
 * input and full max_tokens output.
 */
export function estimateCost(model, inputTokens, maxOutputTokens) {
  const p = PRICING[model];
  if (!p) return 0; // Unknown model: skip pre-flight cost gate, let DeepSeek error.
  return (inputTokens * p.input_uncached + maxOutputTokens * p.output) / 1_000_000;
}

/**
 * Compute actual cost from usage object returned by DeepSeek.
 * usage shape (OpenAI-compatible): { prompt_tokens, completion_tokens, prompt_cache_hit_tokens? }
 */
export function actualCost(model, usage) {
  const p = PRICING[model];
  if (!p) return 0;
  const cached = Number(usage.prompt_cache_hit_tokens ?? 0);
  const total = Number(usage.prompt_tokens ?? 0);
  const uncached = Math.max(0, total - cached);
  const output = Number(usage.completion_tokens ?? 0);
  return (cached * p.input_cached + uncached * p.input_uncached + output * p.output) / 1_000_000;
}

/**
 * Roughly estimate tokens for a string. Uses a 3 chars/token heuristic, which
 * is conservative (real tokenizers average ~4 for English, less for code/CJK).
 * Add 1% padding so we don't underestimate.
 */
export function estimateTokens(text) {
  return Math.ceil(text.length / 3 * 1.01);
}
