// Append-only, hash-chained audit log.
//
// Every event is a single JSON line. Each entry includes the SHA-256 of the
// previous entry's full line, so any tampering with past entries breaks the
// chain at the modification point.
//
// Format per line:
//   {
//     "ts": "2026-05-05T12:34:56.789Z",
//     "seq": 42,
//     "event": "call_end",
//     "data": { ... arbitrary metadata ... },
//     "prev": "<sha256 of previous line, or 'GENESIS' for entry 0>",
//     "hash": "<sha256 of {ts, seq, event, data, prev}>"
//   }

import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, existsSync, writeFileSync } from 'node:fs';

const GENESIS = 'GENESIS';

function sha256(str) {
  return createHash('sha256').update(str, 'utf8').digest('hex');
}

function canonicalize(obj) {
  // Stable stringify: sort keys recursively. Keeps hash deterministic across
  // runs even if JS object iteration order varies.
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(canonicalize).join(',') + ']';
  const keys = Object.keys(obj).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalize(obj[k])).join(',') + '}';
}

function entryHash({ ts, seq, event, data, prev }) {
  return sha256(canonicalize({ ts, seq, event, data, prev }));
}

/**
 * Read the last line of an audit log to get the previous hash + sequence.
 * Returns { seq: -1, hash: GENESIS } for an empty/absent log.
 */
export function readTail(path) {
  if (!existsSync(path)) return { seq: -1, hash: GENESIS };
  const content = readFileSync(path, 'utf8');
  if (content.length === 0) return { seq: -1, hash: GENESIS };
  // Find the last non-empty line.
  let end = content.length;
  while (end > 0 && (content[end - 1] === '\n' || content[end - 1] === '\r')) end--;
  if (end === 0) return { seq: -1, hash: GENESIS };
  let start = end;
  while (start > 0 && content[start - 1] !== '\n') start--;
  const lastLine = content.slice(start, end);
  let parsed;
  try {
    parsed = JSON.parse(lastLine);
  } catch {
    throw new Error(`audit log corrupt: cannot parse last line of ${path}`);
  }
  if (typeof parsed.seq !== 'number' || typeof parsed.hash !== 'string') {
    throw new Error(`audit log corrupt: missing seq or hash in last line of ${path}`);
  }
  return { seq: parsed.seq, hash: parsed.hash };
}

/**
 * Append an event. Returns the entry that was written.
 */
export function appendEvent(path, event, data) {
  const tail = readTail(path);
  const ts = new Date().toISOString();
  const seq = tail.seq + 1;
  const prev = tail.hash;
  const hash = entryHash({ ts, seq, event, data, prev });
  const entry = { ts, seq, event, data, prev, hash };
  appendFileSync(path, JSON.stringify(entry) + '\n', 'utf8');
  return entry;
}

/**
 * Walk the entire log, verify the hash chain. Returns:
 *   { ok: true, count }              if intact
 *   { ok: false, count, brokenAt }   if mismatch found
 *
 * Does NOT throw on a parse error mid-file - reports it as broken.
 */
export function verifyLog(path) {
  if (!existsSync(path)) return { ok: true, count: 0 };
  const content = readFileSync(path, 'utf8');
  if (content.length === 0) return { ok: true, count: 0 };
  const lines = content.split('\n').filter(l => l.length > 0);
  let prevHash = GENESIS;
  let prevSeq = -1;
  for (let i = 0; i < lines.length; i++) {
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      return { ok: false, count: i, brokenAt: i, reason: 'parse_error' };
    }
    if (entry.seq !== prevSeq + 1) {
      return { ok: false, count: i, brokenAt: i, reason: 'seq_skip' };
    }
    if (entry.prev !== prevHash) {
      return { ok: false, count: i, brokenAt: i, reason: 'prev_mismatch' };
    }
    const recomputed = entryHash({
      ts: entry.ts,
      seq: entry.seq,
      event: entry.event,
      data: entry.data,
      prev: entry.prev,
    });
    if (recomputed !== entry.hash) {
      return { ok: false, count: i, brokenAt: i, reason: 'hash_mismatch' };
    }
    prevHash = entry.hash;
    prevSeq = entry.seq;
  }
  return { ok: true, count: lines.length };
}

export const _internal = { canonicalize, entryHash, GENESIS };
