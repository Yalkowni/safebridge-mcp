import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendEvent, readTail, verifyLog, _internal } from './audit.js';

function tmpLog() {
  const dir = mkdtempSync(join(tmpdir(), 'safebridge-audit-'));
  return { path: join(dir, 'audit.log'), dir };
}

test('readTail: returns GENESIS for missing file', () => {
  const { path, dir } = tmpLog();
  try {
    const tail = readTail(path);
    assert.equal(tail.seq, -1);
    assert.equal(tail.hash, 'GENESIS');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('appendEvent: writes a chained sequence', () => {
  const { path, dir } = tmpLog();
  try {
    const e1 = appendEvent(path, 'call_start', { tool: 'deepseek_query', files: 3 });
    const e2 = appendEvent(path, 'call_end',   { tool: 'deepseek_query', tokens: 12000, cost: 0.0034 });
    const e3 = appendEvent(path, 'refused',    { reason: 'denylist match' });

    assert.equal(e1.seq, 0);
    assert.equal(e1.prev, 'GENESIS');
    assert.equal(e2.seq, 1);
    assert.equal(e2.prev, e1.hash);
    assert.equal(e3.seq, 2);
    assert.equal(e3.prev, e2.hash);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('verifyLog: empty log is ok', () => {
  const { path, dir } = tmpLog();
  try {
    const r = verifyLog(path);
    assert.deepEqual(r, { ok: true, count: 0 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('verifyLog: verifies an honest chain', () => {
  const { path, dir } = tmpLog();
  try {
    appendEvent(path, 'a', { x: 1 });
    appendEvent(path, 'b', { x: 2 });
    appendEvent(path, 'c', { x: 3 });
    const r = verifyLog(path);
    assert.equal(r.ok, true);
    assert.equal(r.count, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('verifyLog: detects tampered data field', () => {
  const { path, dir } = tmpLog();
  try {
    appendEvent(path, 'a', { x: 1 });
    appendEvent(path, 'b', { x: 2 });
    appendEvent(path, 'c', { x: 3 });
    // Tamper with the middle entry's data
    let content = readFileSync(path, 'utf8');
    content = content.replace('"x":2', '"x":99');
    writeFileSync(path, content);
    const r = verifyLog(path);
    assert.equal(r.ok, false);
    assert.equal(r.brokenAt, 1);
    assert.equal(r.reason, 'hash_mismatch');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('verifyLog: detects appended forgery (no chain back)', () => {
  const { path, dir } = tmpLog();
  try {
    appendEvent(path, 'a', { x: 1 });
    // Hand-write a forged entry that pretends prev is GENESIS again.
    const forged = JSON.stringify({
      ts: '2030-01-01T00:00:00Z',
      seq: 1,
      event: 'forged',
      data: {},
      prev: 'GENESIS',  // wrong - should be hash of entry 0
      hash: 'fake'.padEnd(64, '0'),
    });
    appendFileSync(path, forged + '\n');
    const r = verifyLog(path);
    assert.equal(r.ok, false);
    assert.equal(r.brokenAt, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('verifyLog: detects deleted middle entry (seq skip)', () => {
  const { path, dir } = tmpLog();
  try {
    appendEvent(path, 'a', { x: 1 });
    appendEvent(path, 'b', { x: 2 });
    appendEvent(path, 'c', { x: 3 });
    const lines = readFileSync(path, 'utf8').split('\n').filter(l => l);
    // Drop the middle line.
    writeFileSync(path, [lines[0], lines[2]].join('\n') + '\n');
    const r = verifyLog(path);
    assert.equal(r.ok, false);
    assert.ok(r.reason === 'seq_skip' || r.reason === 'prev_mismatch');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('canonicalize: stable across key order', () => {
  const a = _internal.canonicalize({ b: 2, a: 1, c: 3 });
  const b = _internal.canonicalize({ c: 3, a: 1, b: 2 });
  assert.equal(a, b);
});

test('canonicalize: handles nested objects', () => {
  const a = _internal.canonicalize({ x: { b: 1, a: 2 }, y: [1, 2] });
  const b = _internal.canonicalize({ y: [1, 2], x: { a: 2, b: 1 } });
  assert.equal(a, b);
});
