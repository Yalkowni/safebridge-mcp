#!/usr/bin/env node
// Smoke test: boots the MCP server, completes the initialize handshake,
// lists tools, calls deepseek_query without an API key (should refuse cleanly),
// then shuts down. No real DeepSeek calls are made.

import { spawn } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const indexPath = resolve(here, '..', 'src', 'index.js');

let nextId = 0;
const pending = new Map();

function makeRequest(method, params) {
  const id = ++nextId;
  return new Promise((resolveReq, rejectReq) => {
    pending.set(id, { resolve: resolveReq, reject: rejectReq });
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

function makeNotification(method, params) {
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

const env = { ...process.env };
// Force-clear the API key so we can verify the no_api_key refusal path.
// Setting to '' (not delete) so it overrides the .env file fallback in config.js.
env.DEEPSEEK_API_KEY = '';
env.SAFEBRIDGE_AUDIT_LOG = join(here, '..', '.smoke-audit.log');
env.SAFEBRIDGE_BUDGET_STATE = join(here, '..', '.smoke-budget.json');

const proc = spawn(process.execPath, [indexPath], {
  env,
  stdio: ['pipe', 'pipe', 'inherit'],
});

let buf = '';
proc.stdout.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id != null && pending.has(msg.id)) {
      const { resolve: r, reject: rj } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) rj(new Error(`${msg.error.code}: ${msg.error.message}`));
      else r(msg.result);
    }
  }
});

let exitCode = 0;
function fail(msg) {
  console.error('SMOKE FAIL:', msg);
  exitCode = 1;
}

try {
  // 1. initialize
  const init = await makeRequest('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'safebridge-smoke', version: '0.0.0' },
  });
  if (!init.serverInfo || init.serverInfo.name !== 'safebridge') {
    fail(`expected serverInfo.name=safebridge, got ${JSON.stringify(init.serverInfo)}`);
  } else {
    console.log('[ok] initialize - server:', init.serverInfo.name, init.serverInfo.version);
  }
  makeNotification('notifications/initialized', {});

  // 2. tools/list
  const tools = await makeRequest('tools/list', {});
  const names = (tools.tools || []).map(t => t.name).sort();
  const expected = ['safebridge_audit', 'safebridge_codegen', 'safebridge_discover', 'safebridge_query'];
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    fail(`expected tools ${JSON.stringify(expected)}, got ${JSON.stringify(names)}`);
  } else {
    console.log('[ok] tools/list -', names.join(', '));
  }

  // 3. call without API key + no dry_run - expect refusal
  const call = await makeRequest('tools/call', {
    name: 'safebridge_query',
    arguments: { prompt: 'smoke test - no key' },
  });
  const text = call.content?.[0]?.text ?? '';
  if (!call.isError) {
    fail(`expected isError=true on no-key call, got isError=${call.isError}`);
  } else if (!/DEEPSEEK_API_KEY/.test(text)) {
    fail(`expected refusal text to mention DEEPSEEK_API_KEY, got: ${text}`);
  } else {
    console.log('[ok] no-API-key call refused cleanly');
  }

  // 4. dry_run works WITHOUT an API key (no network call made)
  const dryRun = await makeRequest('tools/call', {
    name: 'safebridge_query',
    arguments: {
      prompt: 'smoke test',
      file_globs: ['README.md'],
      dry_run: true,
    },
  });
  const dryText = dryRun.content?.[0]?.text ?? '';
  if (dryRun.isError) {
    fail(`dry_run unexpectedly errored: ${dryText}`);
  } else if (!/DRY RUN/.test(dryText) || !/Would call:/.test(dryText)) {
    fail(`dry_run output missing expected markers: ${dryText.slice(0, 200)}`);
  } else {
    console.log('[ok] dry_run returns prepared payload without network');
  }

  // 5. safebridge_audit action=verify on the (dry-run-populated) log
  const verify = await makeRequest('tools/call', {
    name: 'safebridge_audit',
    arguments: { action: 'verify' },
  });
  const verifyText = verify.content?.[0]?.text ?? '';
  if (verify.isError || !/"ok":\s*true/.test(verifyText)) {
    fail(`audit verify did not return ok=true: ${verifyText}`);
  } else {
    console.log('[ok] safebridge_audit verify - chain intact');
  }

  // 6. safebridge_audit action=tail returns the dry_run event
  const tail = await makeRequest('tools/call', {
    name: 'safebridge_audit',
    arguments: { action: 'tail', count: 5 },
  });
  const tailText = tail.content?.[0]?.text ?? '';
  if (tail.isError || !/"event":\s*"dry_run"/.test(tailText)) {
    fail(`audit tail did not contain dry_run event: ${tailText.slice(0, 300)}`);
  } else {
    console.log('[ok] safebridge_audit tail - shows dry_run entry');
  }

  // 7. path-traversal in file_globs - server must reject without reading anything
  const traversal = await makeRequest('tools/call', {
    name: 'safebridge_query',
    arguments: { prompt: 'should not run', file_globs: ['../../../etc/passwd'], dry_run: true },
  });
  const traversalText = traversal.content?.[0]?.text ?? '';
  if (!traversal.isError) {
    fail(`expected isError on traversal glob, got isError=${traversal.isError}`);
  } else if (!/'\.\.'|traversal|absolute/.test(traversalText)) {
    fail(`expected traversal-rejection message, got: ${traversalText.slice(0, 300)}`);
  } else {
    console.log('[ok] path-traversal glob refused');
  }

  // 8. caller asks for a denylisted file directly - must yield zero matches,
  // proving denylist wins over caller-supplied globs.
  const denyAttempt = await makeRequest('tools/call', {
    name: 'safebridge_query',
    arguments: {
      prompt: 'try to leak env',
      file_globs: ['.env', '**/.env*'],
      dry_run: true,
    },
  });
  const denyText = denyAttempt.content?.[0]?.text ?? '';
  if (!denyAttempt.isError) {
    fail(`expected isError when caller targets denylisted globs, got: ${denyText.slice(0, 300)}`);
  } else if (!/no.?files.?matched/i.test(denyText)) {
    fail(`expected no-files-matched refusal, got: ${denyText.slice(0, 300)}`);
  } else {
    console.log('[ok] denylist wins over caller-supplied globs');
  }

  // 9. audit log must record both refusals and the chain must still verify.
  const verify2 = await makeRequest('tools/call', {
    name: 'safebridge_audit',
    arguments: { action: 'verify' },
  });
  const verify2Text = verify2.content?.[0]?.text ?? '';
  if (!/"ok":\s*true/.test(verify2Text)) {
    fail(`audit chain broken after refusals: ${verify2Text}`);
  } else {
    console.log('[ok] audit chain intact after refusals');
  }

  const stats = await makeRequest('tools/call', {
    name: 'safebridge_audit',
    arguments: { action: 'stats' },
  });
  const statsText = stats.content?.[0]?.text ?? '';
  // Expect at least one 'refused' event (no_api_key + no_files_matched), zero call_end (we never hit network).
  if (!/"refused":\s*[1-9]/.test(statsText)) {
    fail(`expected stats to show refused>=1: ${statsText}`);
  } else if (/"call_end":\s*[1-9]/.test(statsText)) {
    fail(`stats unexpectedly shows call_end events (we did no network calls): ${statsText}`);
  } else {
    console.log('[ok] stats: refusals logged, zero network calls');
  }

  if (exitCode === 0) console.log('\nSMOKE PASS');
} catch (e) {
  fail(e.message || String(e));
} finally {
  proc.kill();
  // Clean up smoke artifacts
  const { rmSync } = await import('node:fs');
  for (const f of [env.SAFEBRIDGE_AUDIT_LOG, env.SAFEBRIDGE_BUDGET_STATE]) {
    try { rmSync(f, { force: true }); } catch {}
  }
  process.exit(exitCode);
}
