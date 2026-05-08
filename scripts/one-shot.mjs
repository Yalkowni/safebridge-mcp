#!/usr/bin/env node
// Spawn a fresh safebridge subprocess and run a single deepseek_query call.
// Used when the in-Claude MCP server has stale code and we need to validate
// against the just-edited source. Reads prompt from stdin (JSON: { prompt, file_globs, mode? }).
//
// Usage:
//   echo '{"prompt":"...","file_globs":["server/src/**/*.ts"],"mode":"scan"}' | node scripts/one-shot.mjs

import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const indexPath = resolve(here, '..', 'src', 'index.js');

const stdinChunks = [];
for await (const chunk of process.stdin) stdinChunks.push(chunk);
const args = JSON.parse(Buffer.concat(stdinChunks).toString('utf8'));

let nextId = 0;
const pending = new Map();

const proc = spawn(process.execPath, [indexPath], {
  stdio: ['pipe', 'pipe', 'inherit'],
});

function makeRequest(method, params) {
  const id = ++nextId;
  return new Promise((r, rj) => {
    pending.set(id, { resolve: r, reject: rj });
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
function makeNotification(method, params) {
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

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

try {
  await makeRequest('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'safebridge-one-shot', version: '0.0.0' },
  });
  makeNotification('notifications/initialized', {});

  const result = await makeRequest('tools/call', {
    name: 'deepseek_query',
    arguments: args,
  });
  const text = result.content?.[0]?.text ?? '';
  process.stdout.write(text + '\n');
  process.exit(result.isError ? 1 : 0);
} catch (e) {
  console.error('one-shot error:', e.message || e);
  process.exit(1);
} finally {
  proc.kill();
}
