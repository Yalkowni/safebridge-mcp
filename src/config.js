// Config loader: parses .env (no dotenv dep), loads config.json, resolves paths,
// and returns a frozen config object. Throws early on misconfiguration so the
// MCP server fails loudly at startup rather than at first call.

import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOOL_DIR = resolve(__dirname, '..');
// Default to cwd so the tool works when installed anywhere — MCP clients
// launch the server from the project root, making cwd the natural anchor.
// Override with SAFEBRIDGE_PROJECT_ROOT for non-standard setups.
const DEFAULT_PROJECT_ROOT = process.cwd();

function parseEnvFile(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.trim().startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    // Strip surrounding quotes (single or double).
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[k] = v;
  }
  return out;
}

export function loadConfig({ envPath, configPath } = {}) {
  // Layered env: process.env wins, then .env file, then defaults.
  const envFile = envPath ?? join(TOOL_DIR, '.env');
  const fileEnv = existsSync(envFile) ? parseEnvFile(readFileSync(envFile, 'utf8')) : {};
  const env = { ...fileEnv, ...process.env };

  const projectRoot = resolve(env.SAFEBRIDGE_PROJECT_ROOT || DEFAULT_PROJECT_ROOT);
  const cfgPath = configPath ?? env.SAFEBRIDGE_CONFIG ?? join(TOOL_DIR, 'config.json');
  const auditLogPath = env.SAFEBRIDGE_AUDIT_LOG || join(projectRoot, '.safebridge-audit.log');
  const budgetPath = env.SAFEBRIDGE_BUDGET_STATE || join(projectRoot, '.safebridge-budget.json');

  if (!existsSync(cfgPath)) {
    throw new Error(`safebridge: config not found at ${cfgPath}`);
  }
  const userCfg = JSON.parse(readFileSync(cfgPath, 'utf8'));

  if (!Array.isArray(userCfg.allowlist_globs) || userCfg.allowlist_globs.length === 0) {
    throw new Error(`safebridge: config.allowlist_globs must be a non-empty array`);
  }
  if (!Array.isArray(userCfg.denylist_globs)) {
    throw new Error(`safebridge: config.denylist_globs must be an array`);
  }

  const customPatterns = (userCfg.redaction_patterns?.custom ?? []).map(p => {
    if (!p.name || typeof p.regex !== 'string') {
      throw new Error(`safebridge: custom redaction pattern must have {name, regex, flags?}`);
    }
    return { name: p.name, re: new RegExp(p.regex, p.flags ?? 'g') };
  });

  const VALID_PROVIDERS = new Set(['deepseek', 'openai', 'ollama', 'gemini']);
  const provider = (env.SAFEBRIDGE_PROVIDER || 'deepseek').toLowerCase();
  if (!VALID_PROVIDERS.has(provider)) {
    throw new Error(`safebridge: unknown SAFEBRIDGE_PROVIDER "${provider}". Valid: deepseek, openai, ollama, gemini`);
  }

  const KEY_MAP = { deepseek: 'DEEPSEEK_API_KEY', openai: 'OPENAI_API_KEY', gemini: 'GEMINI_API_KEY', ollama: '' };
  const apiKey = env[KEY_MAP[provider]] || '';

  const config = Object.freeze({
    toolDir: TOOL_DIR,
    projectRoot,
    auditLogPath,
    budgetPath,
    provider,
    apiKey,
    ollamaBaseUrl: env.OLLAMA_BASE_URL || 'http://localhost:11434',
    dailyBudgetUsd: parseFloat(env.SAFEBRIDGE_DAILY_BUDGET_USD || '2.00'),
    maxInputTokens: parseInt(env.SAFEBRIDGE_MAX_INPUT_TOKENS || '800000', 10),
    allowlist: Object.freeze([...userCfg.allowlist_globs]),
    denylist: Object.freeze([...userCfg.denylist_globs]),
    customPatterns: Object.freeze(customPatterns),
  });

  return config;
}
