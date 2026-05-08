#!/usr/bin/env node
// Live smoke test - makes ONE real DeepSeek call against the safebridge README.
// Cost: typically <$0.001 (flash, ~2K input tokens, short response).
// Reads the API key from tools/safebridge-mcp/.env via the normal config path.

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

const proc = spawn(process.execPath, [indexPath], {
  // Inherit env so DEEPSEEK_API_KEY from .env is loaded by config.js
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
  console.error('LIVE-TEST FAIL:', msg);
  exitCode = 1;
}

try {
  await makeRequest('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'safebridge-live', version: '0.0.0' },
  });
  makeNotification('notifications/initialized', {});

  console.log('\n[step 1] Real DeepSeek call against the safebridge README...');
  const t0 = Date.now();
  const call = await makeRequest('tools/call', {
    name: 'deepseek_query',
    arguments: {
      prompt: 'In one sentence, what does this tool do?',
      file_globs: ['tools/safebridge-mcp/README.md'],
      max_tokens: 300,
    },
  });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const text = call.content?.[0]?.text ?? '';

  if (call.isError) {
    fail(`call returned error: ${text}`);
  } else if (text.length < 20) {
    fail(`response suspiciously short: ${text}`);
  } else {
    console.log('\n--- DeepSeek response ---');
    console.log(text);
    console.log('---');
    console.log(`\n[ok] elapsed: ${elapsed}s`);
  }

  console.log('\n[step 2] Audit stats...');
  const stats = await makeRequest('tools/call', {
    name: 'safebridge_audit',
    arguments: { action: 'stats' },
  });
  console.log(stats.content?.[0]?.text ?? '(no stats)');

  console.log('\n[step 3] Hash chain verify...');
  const verify = await makeRequest('tools/call', {
    name: 'safebridge_audit',
    arguments: { action: 'verify' },
  });
  console.log(verify.content?.[0]?.text ?? '(no verify)');

  if (exitCode === 0) console.log('\n=== LIVE TEST PASS ===');
} catch (e) {
  fail(e.message || String(e));
} finally {
  proc.kill();
  process.exit(exitCode);
}
