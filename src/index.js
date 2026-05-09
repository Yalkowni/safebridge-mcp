#!/usr/bin/env node
// safebridge-mcp - privacy-aware MCP server.
//
// Tools exposed to the calling LLM:
//   safebridge_query   - read repo files, ask an LLM a question, return answer
//   safebridge_codegen - read repo files, ask an LLM to generate code, return code
//   safebridge_audit   - inspect the append-only audit log
//   safebridge_discover - pre-flight file/token inspection without an API call
//
// Every outbound payload is allowlist-gated, redacted, audit-logged, budget-checked.
// stdout is reserved for MCP protocol; all logging goes to stderr.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';

const existsSyncSafe = existsSync;

import { loadConfig } from './config.js';
import { redact } from './redact.js';
import { pseudonymize, unpseudonymize } from './pseudonym.js';
import { findFiles, validateRequestedGlobs } from './allowlist.js';
import { appendEvent, verifyLog } from './audit.js';
import {
  checkBudget,
  recordCost,
  estimateCost,
  actualCost,
  estimateTokens,
} from './budget.js';
import { chat } from './providers.js';

const FILE_SIZE_CAP = 1_000_000; // 1 MB per file

const QUERY_SYSTEM_PROMPT = `You are a code analysis assistant. The user has shared files from their repository for context. Answer their question using only the provided context. Cite specific files and quote relevant snippets. Be concise. If the answer requires information not in the context, say so explicitly rather than guessing.

Note: certain values in the context have been replaced with placeholders like [REDACTED:email] or [REDACTED:secret_assignment] for privacy. Reason about structure, not values.`;

const CODEGEN_SYSTEM_PROMPT = `You are a code generation assistant. The user has shared context files and a specification. Generate the requested code in the same style as the context files (naming conventions, error handling patterns, imports). Format your output as one or more file blocks: each block starts with \`### path/to/file.ext\` on its own line, followed by a fenced code block in the appropriate language. Do not include long explanatory prose - keep prose to one sentence per file describing intent. Do not invent file paths that don't fit the spec.

Note: certain values in the context have been replaced with placeholders like [REDACTED:email] or [REDACTED:secret_assignment]. Use the same placeholders in generated code where applicable; do not invent values.`;

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function log(...args) {
  // stderr only - stdout is the MCP protocol channel.
  console.error('[safebridge]', ...args);
}

/**
 * Read + redact files. Returns { blocks, files, totalBytes, totalRedactions }.
 *
 * @param {object} args
 * @param {Array} args.matched - file refs from findFiles()
 * @param {Array} args.customPatterns - extra redaction patterns from config
 * @param {'redact'|'secrets-only'} args.mode -
 *   'redact'        - apply both secret + PII patterns (lossy). DEFAULT.
 *   'secrets-only'  - apply only secret patterns; PII passes through. Used when
 *                     the caller will pseudonymize the assembled prompt afterwards
 *                     to keep placeholders stable across files.
 */
function gatherContext({ matched, customPatterns, mode = 'redact' }) {
  const blocks = [];
  const files = [];
  let totalBytes = 0;
  let totalRedactions = 0;
  const redactionCounts = {};
  const categories = mode === 'secrets-only' ? ['secret'] : ['secret', 'pii'];

  for (const f of matched) {
    let raw;
    try {
      const buf = readFileSync(f.abs);
      if (buf.length > FILE_SIZE_CAP) {
        files.push({ rel: f.rel, skipped: 'oversize', bytes: buf.length });
        continue;
      }
      raw = buf.toString('utf8');
    } catch (e) {
      files.push({ rel: f.rel, skipped: 'read_error', error: String(e.message || e) });
      continue;
    }
    const { text: redacted, counts, total } = redact(raw, { customPatterns, categories });
    blocks.push(`### ${f.rel}\n\`\`\`\n${redacted}\n\`\`\``);
    files.push({ rel: f.rel, bytes: raw.length, redactions: total });
    totalBytes += raw.length;
    totalRedactions += total;
    for (const [k, v] of Object.entries(counts)) {
      redactionCounts[k] = (redactionCounts[k] ?? 0) + v;
    }
  }

  return { blocks, files, totalBytes, totalRedactions, redactionCounts };
}

// Provider-specific key env-var names (used in error messages and startup warnings).
const KEY_ENV_NAMES = {
  deepseek: 'DEEPSEEK_API_KEY',
  openai: 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
  ollama: null, // no key required
};

// Default models per provider and mode. Caller-supplied model always overrides.
// DeepSeek: thinking ON eats max_tokens before content — scan mode disables it.
const PROVIDER_PROFILES = {
  deepseek: {
    scan:   { model: 'deepseek-chat',     thinkingEnabled: false, reasoningEffort: undefined, maxTokens: 4096 },
    reason: { model: 'deepseek-reasoner', thinkingEnabled: true,  reasoningEffort: 'high',    maxTokens: 8000 },
  },
  openai: {
    scan:   { model: 'gpt-4o-mini', thinkingEnabled: false, reasoningEffort: undefined, maxTokens: 4096 },
    reason: { model: 'gpt-4o',      thinkingEnabled: false, reasoningEffort: undefined, maxTokens: 8000 },
  },
  gemini: {
    scan:   { model: 'gemini-2.5-flash', thinkingEnabled: false, reasoningEffort: undefined, maxTokens: 4096 },
    reason: { model: 'gemini-2.5-pro',   thinkingEnabled: false, reasoningEffort: undefined, maxTokens: 8000 },
  },
  ollama: {
    scan:   { model: 'llama3.3', thinkingEnabled: false, reasoningEffort: undefined, maxTokens: 4096 },
    reason: { model: 'llama3.3', thinkingEnabled: false, reasoningEffort: undefined, maxTokens: 8000 },
  },
};

function resolveProfile({ provider, mode, model, maxTokens }) {
  const providerProfiles = PROVIDER_PROFILES[provider] ?? PROVIDER_PROFILES.deepseek;
  const base = providerProfiles[mode] ?? providerProfiles.scan;
  return {
    model: model ?? base.model,
    thinkingEnabled: base.thinkingEnabled,
    reasoningEffort: base.reasoningEffort,
    maxTokens: maxTokens ?? base.maxTokens,
  };
}

/**
 * Run the full safe-call flow. Shared between deepseek_query and deepseek_codegen.
 */
async function safeCall({
  config,
  toolName,
  userPrompt,
  fileGlobs,
  systemPrompt,
  mode,
  model,
  maxTokens,
  pseudonymizeMode = false,
  dryRun = false,
}) {
  const profile = resolveProfile({ provider: config.provider, mode, model, maxTokens });
  model = profile.model;
  maxTokens = profile.maxTokens;
  // Step 0: ensure the API key is configured (unless dry-run or Ollama, which needs no key).
  if (!config.apiKey && !dryRun && config.provider !== 'ollama') {
    const keyName = KEY_ENV_NAMES[config.provider] ?? 'API key';
    appendEvent(config.auditLogPath, 'refused', { tool: toolName, reason: 'no_api_key' });
    return {
      ok: false,
      error: `${keyName} not configured. Add it to .env in the safebridge-mcp directory and restart.`,
    };
  }

  // Step 1: validate globs (defense against path traversal in caller-supplied input).
  if (fileGlobs?.length) validateRequestedGlobs(fileGlobs);

  // Step 2: find files via allowlist + denylist (+ optional caller narrowing).
  const matched = findFiles({
    root: config.projectRoot,
    allowlist: config.allowlist,
    denylist: config.denylist,
    requestedGlobs: fileGlobs?.length ? fileGlobs : undefined,
  });

  if (matched.length === 0) {
    appendEvent(config.auditLogPath, 'refused', {
      tool: toolName,
      reason: 'no_files_matched',
      file_globs: fileGlobs ?? null,
    });
    return {
      ok: false,
      error: `No files matched. ${
        fileGlobs?.length
          ? `Requested globs: ${JSON.stringify(fileGlobs)}. Check that they intersect the configured allowlist.`
          : 'Allowlist returned zero files - check config.json.'
      }`,
    };
  }

  // Step 3: read + scrub. In pseudonymize mode we strip secrets per-file but
  // leave PII alone, then pseudonymize the assembled prompt as one unit so the
  // same value gets the same placeholder across files.
  const { blocks, files, totalBytes, totalRedactions, redactionCounts } = gatherContext({
    matched,
    customPatterns: config.customPatterns,
    mode: pseudonymizeMode ? 'secrets-only' : 'redact',
  });

  // Step 4: build payload.
  let userMessage =
    blocks.length > 0
      ? `Context files:\n\n${blocks.join('\n\n')}\n\n---\n\n${userPrompt}`
      : userPrompt;

  // Step 4b: pseudonymize PII if requested. Reverse map stays in scope only
  // for this call - never persisted, never logged in cleartext.
  let pseudonymReverse = null;
  let pseudonymCounts = {};
  if (pseudonymizeMode) {
    const p = pseudonymize(userMessage);
    userMessage = p.text;
    pseudonymReverse = p.reverse;
    pseudonymCounts = p.counts;
  }

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userMessage },
  ];
  const promptHash = sha256(systemPrompt + '\n' + userMessage);

  // Step 5: token + budget pre-flight.
  const inputTokens = estimateTokens(systemPrompt) + estimateTokens(userMessage);
  if (inputTokens > config.maxInputTokens) {
    appendEvent(config.auditLogPath, 'refused', {
      tool: toolName,
      reason: 'input_tokens_exceeded',
      estimated_tokens: inputTokens,
      cap: config.maxInputTokens,
      file_count: matched.length,
    });
    return {
      ok: false,
      error: `Estimated input tokens (${inputTokens}) exceeds cap (${config.maxInputTokens}). Narrow file_globs.`,
    };
  }

  const estCost = estimateCost(model, inputTokens, maxTokens);

  // Step 5b: dry run - return the prepared payload without calling the API.
  if (dryRun) {
    appendEvent(config.auditLogPath, 'dry_run', {
      tool: toolName,
      model,
      file_count: files.length,
      files: files.map(f => f.rel ?? f),
      total_bytes: totalBytes,
      redaction_total: totalRedactions,
      redaction_counts: redactionCounts,
      pseudonym_counts: pseudonymCounts,
      estimated_input_tokens: inputTokens,
      estimated_cost_usd: estCost,
      prompt_sha256: promptHash,
    });
    const preview = userMessage.length > 8000
      ? userMessage.slice(0, 8000) + `\n\n... [truncated, total ${userMessage.length} chars] ...`
      : userMessage;
    return {
      ok: true,
      text: [
        `[DRY RUN - no API call made]`,
        ``,
        `Would call: ${model}`,
        `Files included: ${files.length} (${totalBytes} bytes total)`,
        `Secret redactions: ${totalRedactions} ${JSON.stringify(redactionCounts)}`,
        pseudonymizeMode
          ? `Pseudonymizations: ${Object.values(pseudonymCounts).reduce((a, b) => a + b, 0)} ${JSON.stringify(pseudonymCounts)}`
          : `Pseudonymization: off`,
        `Estimated input tokens: ${inputTokens} (cap: ${config.maxInputTokens})`,
        `Estimated cost: $${estCost.toFixed(4)} (daily cap: $${config.dailyBudgetUsd})`,
        `Prompt SHA-256: ${promptHash}`,
        ``,
        `--- System prompt ---`,
        systemPrompt,
        ``,
        `--- User message (after redaction${pseudonymizeMode ? '/pseudonymization' : ''}) ---`,
        preview,
      ].join('\n'),
    };
  }

  const budget = checkBudget(config.budgetPath, config.dailyBudgetUsd, estCost);
  if (!budget.ok) {
    appendEvent(config.auditLogPath, 'refused', {
      tool: toolName,
      reason: 'budget_exceeded',
      estimated_cost: estCost,
      spent_today: budget.spent,
      daily_cap: config.dailyBudgetUsd,
    });
    return {
      ok: false,
      error: `Daily budget cap reached. Spent today: $${budget.spent.toFixed(4)} of $${config.dailyBudgetUsd.toFixed(2)}. Estimated cost of this call: $${estCost.toFixed(4)}.`,
    };
  }

  // Step 6: log call start.
  const startEvent = appendEvent(config.auditLogPath, 'call_start', {
    tool: toolName,
    model,
    file_count: files.length,
    files: files.map(f => f.rel ?? f),
    total_bytes: totalBytes,
    redaction_total: totalRedactions,
    redaction_counts: redactionCounts,
    pseudonym_counts: pseudonymCounts,
    estimated_input_tokens: inputTokens,
    estimated_cost_usd: estCost,
    prompt_sha256: promptHash,
  });

  // Step 7: call the provider.
  let result;
  try {
    result = await chat({
      provider: config.provider,
      apiKey: config.apiKey,
      baseUrl: config.ollamaBaseUrl,
      model,
      messages,
      maxTokens,
      temperature: 0,
      thinkingEnabled: profile.thinkingEnabled,
      reasoningEffort: profile.reasoningEffort,
    });
  } catch (e) {
    appendEvent(config.auditLogPath, 'error', {
      tool: toolName,
      step: 'provider_call',
      message: String(e.message || e),
      call_start_seq: startEvent.seq,
    });
    return { ok: false, error: `Provider call failed: ${e.message || e}` };
  }

  // Step 8: post-process response.
  // (a) defense-in-depth redact for hard secrets the LLM might have echoed
  // (b) if pseudonymized, unmap placeholders back to original values
  let responseText = result.content;
  let hallucinatedPlaceholders = [];
  let unmappedCount = 0;
  if (pseudonymReverse) {
    const u = unpseudonymize(responseText, pseudonymReverse);
    responseText = u.text;
    unmappedCount = u.unmapped;
    hallucinatedPlaceholders = u.hallucinated;
  }
  // Always run secret-only redact on the final response. (PII restored via
  // pseudonym round-trip is fine; we only want to catch secrets that leaked through.)
  const { text: redactedResponse, total: responseRedactions } = redact(responseText, {
    categories: ['secret'],
  });

  // Step 9: record actual cost.
  const cost = actualCost(model, result.usage);
  const newState = recordCost(config.budgetPath, cost);

  // Step 10: log completion.
  appendEvent(config.auditLogPath, 'call_end', {
    tool: toolName,
    model: result.model,
    finish_reason: result.finish_reason,
    usage: result.usage,
    cost_usd: cost,
    response_redactions: responseRedactions,
    response_sha256: sha256(redactedResponse),
    daily_spent_after: newState.spent_usd,
    call_start_seq: startEvent.seq,
    pseudonym_unmapped: unmappedCount,
    pseudonym_hallucinated: hallucinatedPlaceholders.length,
  });

  // Step 11: return.
  const metaParts = [
    `${result.model}`,
    `${result.usage?.prompt_tokens ?? '?'}+${result.usage?.completion_tokens ?? '?'} tok`,
    `$${cost.toFixed(6)}`,
    `day total $${newState.spent_usd.toFixed(4)} / $${config.dailyBudgetUsd.toFixed(2)}`,
  ];
  if (responseRedactions > 0) metaParts.push(`${responseRedactions} response redactions`);
  if (pseudonymReverse) metaParts.push(`${unmappedCount} pseudonyms restored`);
  if (hallucinatedPlaceholders.length > 0) metaParts.push(`${hallucinatedPlaceholders.length} hallucinated placeholders left as-is`);

  // Warn when PII was scrubbed from inputs but the response is unfiltered.
  // Responses only get secret-redacted (not PII-redacted) unless pseudonymize
  // was used. Surface this so callers know to use pseudonymize:true when the
  // query involves contacts, leads, or any real customer identifiers.
  const PII_PATTERN_NAMES = new Set(['phone_intl', 'phone_us', 'email', 'cc_like', 'ssn']);
  const inputPiiCount = Object.entries(redactionCounts)
    .filter(([k]) => PII_PATTERN_NAMES.has(k))
    .reduce((sum, [, v]) => sum + v, 0);
  if (!pseudonymizeMode && inputPiiCount > 0) {
    metaParts.push(`⚠ ${inputPiiCount} PII item(s) scrubbed from inputs but NOT from this response — use pseudonymize:true for end-to-end coverage`);
  }

  return {
    ok: true,
    text: `${redactedResponse}\n\n[safebridge: ${metaParts.join(' · ')}]`,
  };
}

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (e) {
    log('FATAL: config load failed:', e.message);
    process.exit(1);
  }

  if (!config.apiKey && config.provider !== 'ollama') {
    // Don't exit - boot the server and let it return a friendly error per call.
    // This way the calling LLM can see the tools exist but is told to set a key.
    const keyName = KEY_ENV_NAMES[config.provider] ?? 'API key';
    log(`WARNING: ${keyName} not set. Tool calls will refuse until set.`);
  }

  const server = new McpServer({ name: 'safebridge', version: '0.2.0' });

  server.registerTool(
    'safebridge_query',
    {
      title: 'Safebridge Repo Query',
      description: 'Ask an LLM a question about repository files. Reads files from the configured allowlist (optionally narrowed by file_globs), redacts secrets/PII, and returns the answer. Use for "where is X used", "how does Y flow", whole-repo summaries, log analysis. Provider is set by SAFEBRIDGE_PROVIDER in .env (deepseek/openai/ollama/gemini).',
      inputSchema: z.object({
        prompt: z.string().min(1).describe('Your question. Be specific.'),
        file_globs: z.array(z.string()).optional().describe('Optional list of glob patterns to narrow which files are included (e.g. ["src/workers/**/*.ts"]). Must intersect the allowlist; cannot bypass denylist.'),
        mode: z.enum(['scan', 'reason']).optional().describe('"scan" (default): fast/cheap model, thinking OFF, 4K max_tokens. Use for grep-style audits, lookups, "where is X used", quick summaries. "reason": capable model with deeper reasoning, 8K max_tokens. Use for cross-file architectural reasoning, root-cause analysis. Default models depend on SAFEBRIDGE_PROVIDER.'),
        model: z.string().optional().describe('Override the model picked by mode. Usually leave empty and let the provider default apply.'),
        max_tokens: z.number().int().positive().max(8000).optional().describe('Override max_tokens. Defaults: scan=4096, reason=8000.'),
        pseudonymize: z.boolean().optional().describe('If true, replace PII (phones, emails, SSNs) with reversible placeholders (PHONE_001 etc) before sending. Response is unmapped back automatically. Default: false (lossy [REDACTED:pii] replacement).'),
        dry_run: z.boolean().optional().describe('If true, prepare the payload but DO NOT call the provider. Returns the redacted prompt + token estimate + cost estimate so you can review before spending. Default: false.'),
      }),
    },
    async ({ prompt, file_globs, mode, model, max_tokens, pseudonymize, dry_run }) => {
      const r = await safeCall({
        config,
        toolName: 'safebridge_query',
        userPrompt: prompt,
        fileGlobs: file_globs,
        systemPrompt: QUERY_SYSTEM_PROMPT,
        mode: mode ?? 'scan',
        model,
        maxTokens: max_tokens,
        pseudonymizeMode: pseudonymize ?? false,
        dryRun: dry_run ?? false,
      });
      return {
        content: [{ type: 'text', text: r.ok ? r.text : `[safebridge refused] ${r.error}` }],
        isError: !r.ok,
      };
    },
  );

  server.registerTool(
    'safebridge_codegen',
    {
      title: 'Safebridge Code Generator',
      description: 'Ask an LLM to generate code from a spec, with repo files as context. Returns code blocks formatted as "### path/to/file" headers + fenced code. The calling LLM applies the code; this tool never writes files. Use for non-critical scaffolding, regex/SQL drafts, test fixtures, mass renames - NOT for engine/worker/auth code.',
      inputSchema: z.object({
        spec: z.string().min(1).describe('What to build. Be specific about file paths, function signatures, and behavior.'),
        file_globs: z.array(z.string()).optional().describe('Files to include as context. Defaults to allowlist; usually narrow this.'),
        mode: z.enum(['scan', 'reason']).optional().describe('"reason" (default for codegen): capable model with deeper reasoning, 8K max_tokens. "scan": fast/cheap model, thinking OFF, 4K — use only for trivial scaffolding. Default models depend on SAFEBRIDGE_PROVIDER.'),
        model: z.string().optional().describe('Override the model picked by mode. Usually leave empty and let the provider default apply.'),
        max_tokens: z.number().int().positive().max(8000).optional().describe('Override max_tokens. Defaults: scan=4096, reason=8000.'),
        dry_run: z.boolean().optional().describe('If true, prepare the payload but DO NOT call the provider. Default: false.'),
      }),
    },
    async ({ spec, file_globs, mode, model, max_tokens, dry_run }) => {
      const r = await safeCall({
        config,
        toolName: 'safebridge_codegen',
        userPrompt: spec,
        fileGlobs: file_globs,
        systemPrompt: CODEGEN_SYSTEM_PROMPT,
        mode: mode ?? 'reason',
        model,
        maxTokens: max_tokens,
        pseudonymizeMode: false,
        dryRun: dry_run ?? false,
      });
      return {
        content: [{ type: 'text', text: r.ok ? r.text : `[safebridge refused] ${r.error}` }],
        isError: !r.ok,
      };
    },
  );

  server.registerTool(
    'safebridge_audit',
    {
      title: 'Safebridge Audit Log',
      description: 'Inspect the safebridge audit log: tail recent events, verify the hash chain, or get summary stats. Useful for "what did I send to DeepSeek today?" or confirming the log hasn\'t been tampered with.',
      inputSchema: z.object({
        action: z.enum(['tail', 'verify', 'stats']).optional().describe('tail (default): last N entries. verify: check hash chain integrity. stats: counts and totals.'),
        count: z.number().int().positive().max(200).optional().describe('For tail: number of entries to return. Default 20.'),
      }),
    },
    async ({ action, count }) => {
      const act = action ?? 'tail';
      const n = count ?? 20;
      try {
        if (act === 'verify') {
          const r = verifyLog(config.auditLogPath);
          return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] };
        }
        if (!existsSyncSafe(config.auditLogPath)) {
          return { content: [{ type: 'text', text: '(audit log empty - no calls made yet)' }] };
        }
        const lines = readFileSync(config.auditLogPath, 'utf8').split('\n').filter(l => l.length > 0);
        if (act === 'tail') {
          const tail = lines.slice(-n).map(l => {
            try { return JSON.parse(l); } catch { return { _parse_error: l }; }
          });
          return { content: [{ type: 'text', text: JSON.stringify(tail, null, 2) }] };
        }
        if (act === 'stats') {
          const eventCounts = {};
          let totalCost = 0;
          let totalRedactions = 0;
          let totalFiles = 0;
          for (const l of lines) {
            try {
              const e = JSON.parse(l);
              eventCounts[e.event] = (eventCounts[e.event] ?? 0) + 1;
              if (e.event === 'call_end') {
                totalCost += Number(e.data?.cost_usd ?? 0);
              }
              if (e.event === 'call_start') {
                totalRedactions += Number(e.data?.redaction_total ?? 0);
                totalFiles += Number(e.data?.file_count ?? 0);
              }
            } catch { /* ignore parse errors */ }
          }
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                entries: lines.length,
                event_counts: eventCounts,
                total_cost_usd_lifetime: Number(totalCost.toFixed(6)),
                total_secret_redactions: totalRedactions,
                total_file_reads: totalFiles,
              }, null, 2),
            }],
          };
        }
      } catch (e) {
        return { content: [{ type: 'text', text: `audit failed: ${e.message || e}` }], isError: true };
      }
    },
  );

  // ---------------------------------------------------------------------------
  // safebridge_discover - inspect what files would be sent for a given glob set,
  // WITHOUT calling DeepSeek. Lets the caller refine file_globs before paying
  // for a query that might bust the token cap or hit the wrong path entirely.
  //
  // Workflow: discover -> refine globs -> deepseek_query.
  // No API key required; runs even if DEEPSEEK_API_KEY is unset.
  // ---------------------------------------------------------------------------
  server.registerTool(
    'safebridge_discover',
    {
      title: 'Safebridge File Discovery',
      description: 'Preview which files would be included for a given file_globs set, with per-file token estimates and directory grouping. NO provider call, NO API key required, NO cost. Use this BEFORE safebridge_query/safebridge_codegen to (a) avoid "input tokens exceeded cap" failures by seeing the size up-front and (b) avoid "no files matched" failures by seeing what the allowlist actually contains. If file_globs is omitted, shows the full allowlist with auto-suggested narrowings.',
      inputSchema: z.object({
        file_globs: z.array(z.string()).optional().describe('Optional glob patterns to test (same syntax as deepseek_query). Omit to see the full allowlist.'),
        group_by: z.enum(['dir', 'ext', 'flat']).optional().describe('How to group results. "dir" (default): group by top-2-level directory prefix. "ext": group by file extension. "flat": one line per file, no grouping.'),
      }),
    },
    async ({ file_globs, group_by }) => {
      const grouping = group_by ?? 'dir';
      try {
        // Validate caller-supplied globs (path traversal defense, same as query tool).
        if (file_globs?.length) validateRequestedGlobs(file_globs);

        // Resolve files via the same allowlist+denylist pipeline the query tool uses.
        const matched = findFiles({
          root: config.projectRoot,
          allowlist: config.allowlist,
          denylist: config.denylist,
          requestedGlobs: file_globs?.length ? file_globs : undefined,
        });

        if (matched.length === 0) {
          appendEvent(config.auditLogPath, 'discover', {
            file_globs: file_globs ?? null,
            file_count: 0,
            estimated_tokens: 0,
          });
          const lines = [
            `safebridge discover - 0 files matched`,
            ``,
            file_globs?.length
              ? `Requested globs: ${JSON.stringify(file_globs)}`
              : `Allowlist returned zero files - check config.json in the safebridge-mcp directory.`,
            ``,
            `Allowlist patterns:`,
            ...config.allowlist.map(g => `  ${g}`),
          ];
          return { content: [{ type: 'text', text: lines.join('\n') }] };
        }

        // Read each file's size + token estimate. Files >FILE_SIZE_CAP are
        // tracked separately because gatherContext() will skip them at query
        // time - surfacing them here avoids surprise "missing file" debugging.
        const included = []; // { rel, bytes, tokens }
        const oversized = []; // { rel, bytes }
        const readErrors = []; // { rel, error }
        let totalTokens = 0;

        for (const f of matched) {
          let buf;
          try {
            buf = readFileSync(f.abs);
          } catch (e) {
            readErrors.push({ rel: f.rel, error: String(e.message || e) });
            continue;
          }
          if (buf.length > FILE_SIZE_CAP) {
            oversized.push({ rel: f.rel, bytes: buf.length });
            continue;
          }
          // Same heuristic as estimateTokens() (~4 chars/token). Using byte
          // length is fine for ASCII-heavy code; for code we never see enough
          // multibyte content to matter.
          const tokens = estimateTokens(buf.toString('utf8'));
          included.push({ rel: f.rel, bytes: buf.length, tokens });
          totalTokens += tokens;
        }

        const cap = config.maxInputTokens;
        const fits = totalTokens <= cap;
        const overCap = !fits;

        // Group included files for the body of the report.
        let groups; // Map<key, { files: [...], tokens: number }>
        if (grouping === 'flat') {
          groups = null;
        } else if (grouping === 'ext') {
          groups = new Map();
          for (const f of included) {
            const dot = f.rel.lastIndexOf('.');
            const key = dot >= 0 ? f.rel.slice(dot) : '(no ext)';
            if (!groups.has(key)) groups.set(key, { files: [], tokens: 0 });
            const g = groups.get(key);
            g.files.push(f);
            g.tokens += f.tokens;
          }
        } else {
          // 'dir' - top 2 path segments
          groups = new Map();
          for (const f of included) {
            const parts = f.rel.split('/');
            const key = parts.slice(0, 2).join('/') || '(root)';
            if (!groups.has(key)) groups.set(key, { files: [], tokens: 0 });
            const g = groups.get(key);
            g.files.push(f);
            g.tokens += f.tokens;
          }
        }

        // Build suggestion list: top-1/2/3-level dirs sorted by file count desc.
        // Shown when no globs were given (caller is exploring) OR when the
        // current set busts the cap (caller needs to narrow).
        const showSuggestions = !file_globs?.length || overCap;
        const suggestions = [];
        if (showSuggestions) {
          const dirCounts = new Map();
          for (const f of included) {
            const parts = f.rel.split('/');
            // Use top-3 levels for suggestions so they're actionable (e.g.
            // "server/src/lib/core" not just "server/src").
            const depth = Math.min(parts.length - 1, 3);
            for (let d = 1; d <= depth; d++) {
              const prefix = parts.slice(0, d).join('/');
              const entry = dirCounts.get(prefix) ?? { count: 0, tokens: 0 };
              entry.count += 1;
              entry.tokens += f.tokens;
              dirCounts.set(prefix, entry);
            }
          }
          // Pick prefixes whose file count is meaningful (>=2) AND whose own
          // token total fits under the cap - otherwise the suggestion is useless.
          const candidates = [...dirCounts.entries()]
            .filter(([, v]) => v.count >= 2 && v.tokens <= cap)
            .sort((a, b) => b[1].count - a[1].count)
            .slice(0, 8);
          for (const [prefix, v] of candidates) {
            suggestions.push({ glob: `${prefix}/**/*`, count: v.count, tokens: v.tokens });
          }
        }

        // Audit-log the discovery event so all tool use shows up in the chain.
        appendEvent(config.auditLogPath, 'discover', {
          file_globs: file_globs ?? null,
          group_by: grouping,
          file_count: included.length,
          oversized_count: oversized.length,
          read_error_count: readErrors.length,
          estimated_tokens: totalTokens,
          token_cap: cap,
          fits_cap: fits,
        });

        // Render plain-text report.
        const out = [];
        const status = fits ? 'fits' : 'EXCEEDS CAP';
        const oversizeNote = oversized.length > 0 ? ` (${oversized.length} oversize skipped)` : '';
        out.push(`safebridge discover - ${included.length} files matched${oversizeNote}`);
        out.push(``);
        out.push(`Token estimate: ${totalTokens.toLocaleString()} / ${cap.toLocaleString()} cap  [${status}]`);
        if (overCap) {
          out.push(`  Narrow file_globs before calling safebridge_query - see suggestions below.`);
        }
        out.push(``);

        if (file_globs?.length) {
          out.push(`Requested globs:`);
          for (const g of file_globs) out.push(`  ${g}`);
          out.push(``);
        }

        if (grouping === 'flat' || groups === null) {
          out.push(`Files:`);
          for (const f of included) {
            out.push(`  ${f.rel.padEnd(60)}  ${f.tokens.toLocaleString()} tok`);
          }
        } else {
          const label = grouping === 'ext' ? 'extension' : 'directory';
          out.push(`Files by ${label}:`);
          // Sort groups by token total desc so the heaviest show first.
          const sorted = [...groups.entries()].sort((a, b) => b[1].tokens - a[1].tokens);
          for (const [key, g] of sorted) {
            out.push(`  ${key}/  (${g.files.length} files, ~${g.tokens.toLocaleString()} tok)`);
            // Sort files within group by tokens desc, cap at 12 to keep the
            // report scannable when a directory has hundreds of files.
            const sortedFiles = [...g.files].sort((a, b) => b.tokens - a.tokens);
            const shown = sortedFiles.slice(0, 12);
            for (const f of shown) {
              const name = f.rel.startsWith(key + '/') ? f.rel.slice(key.length + 1) : f.rel;
              out.push(`    ${name.padEnd(56)}  ${f.tokens.toLocaleString()} tok`);
            }
            if (sortedFiles.length > shown.length) {
              out.push(`    ... and ${sortedFiles.length - shown.length} more`);
            }
          }
        }

        if (oversized.length > 0) {
          out.push(``);
          out.push(`Skipped (oversize >${(FILE_SIZE_CAP / 1_000_000).toFixed(1)}MB):`);
          for (const f of oversized) {
            const mb = (f.bytes / 1_000_000).toFixed(2);
            out.push(`  ${f.rel.padEnd(60)}  ${mb}MB`);
          }
        }

        if (readErrors.length > 0) {
          out.push(``);
          out.push(`Read errors:`);
          for (const f of readErrors) {
            out.push(`  ${f.rel}: ${f.error}`);
          }
        }

        if (suggestions.length > 0) {
          out.push(``);
          out.push(overCap
            ? `Suggestions - try narrowing to:`
            : `Suggestions - common narrowings:`);
          for (const s of suggestions) {
            out.push(`  ${s.glob.padEnd(50)}  (${s.count} files, ~${s.tokens.toLocaleString()} tok)`);
          }
        }

        return { content: [{ type: 'text', text: out.join('\n') }] };
      } catch (e) {
        log('discover failed:', e.message || e);
        appendEvent(config.auditLogPath, 'error', {
          tool: 'safebridge_discover',
          message: String(e.message || e),
        });
        return {
          content: [{ type: 'text', text: `safebridge discover failed: ${e.message || e}` }],
          isError: true,
        };
      }
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`safebridge-mcp v0.2.0 ready. provider=${config.provider} project_root=${config.projectRoot} budget=$${config.dailyBudgetUsd}/day`);

  const shutdown = (sig) => {
    log(`received ${sig}, shutting down`);
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((e) => {
  log('FATAL:', e?.stack ?? e);
  process.exit(1);
});
