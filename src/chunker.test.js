// Unit tests for chunker.js. Node built-in test runner.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chunkText, CHUNK_SIZE, CHUNK_OVERLAP } from './chunker.js';

describe('chunkText', () => {
  it('returns empty array for empty string', () => {
    assert.deepEqual(chunkText('', 'foo.js'), []);
  });

  it('returns empty array for falsy text', () => {
    assert.deepEqual(chunkText(null, 'foo.js'), []);
    assert.deepEqual(chunkText(undefined, 'foo.js'), []);
  });

  it('single chunk when text fits in one window', () => {
    const text = 'hello world';
    const chunks = chunkText(text, 'a.js');
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].path, 'a.js');
    assert.equal(chunks[0].text, text);
    assert.equal(chunks[0].startLine, 1);
    assert.equal(chunks[0].endLine, 1);
  });

  it('multiple chunks for text longer than one window', () => {
    const text = 'a'.repeat(CHUNK_SIZE * 2 + 100);
    const chunks = chunkText(text, 'b.js');
    assert.ok(chunks.length >= 3, `expected >=3 chunks, got ${chunks.length}`);
  });

  it('consecutive chunks overlap by the configured amount', () => {
    const overlap = 100;
    const chunkSize = 500;
    const text = 'x'.repeat(chunkSize * 3);
    const chunks = chunkText(text, 'c.js', { chunkSize, overlap });
    assert.ok(chunks.length >= 3);
    const firstEnd = chunks[0].text.slice(-overlap);
    const secondStart = chunks[1].text.slice(0, overlap);
    assert.equal(firstEnd, secondStart);
  });

  it('last chunk ends exactly at text end', () => {
    const text = 'abcdefgh';
    const chunks = chunkText(text, 'e.js', { chunkSize: 5, overlap: 2 });
    const last = chunks[chunks.length - 1];
    assert.ok(text.endsWith(last.text), `text should end with "${last.text}"`);
  });

  it('tracks line numbers correctly', () => {
    // 5 lines, each chunk covers a distinct line range
    const text = 'line1\nline2\nline3\nline4\nline5';
    const chunks = chunkText(text, 'd.js', { chunkSize: 12, overlap: 0 });
    assert.equal(chunks[0].startLine, 1);
    // Second chunk should start after the first 12 chars (which covers lines 1-2)
    assert.ok(chunks[1].startLine >= 2, `expected startLine>=2, got ${chunks[1].startLine}`);
  });

  it('startLine and endLine are 1-indexed', () => {
    const chunks = chunkText('hello\nworld', 'f.js');
    assert.ok(chunks[0].startLine >= 1);
    assert.ok(chunks[0].endLine >= chunks[0].startLine);
  });

  it('each chunk includes the path', () => {
    const chunks = chunkText('data', 'src/foo/bar.ts');
    assert.equal(chunks[0].path, 'src/foo/bar.ts');
  });

  it('CHUNK_SIZE > CHUNK_OVERLAP (sanity)', () => {
    assert.ok(typeof CHUNK_SIZE === 'number');
    assert.ok(typeof CHUNK_OVERLAP === 'number');
    assert.ok(CHUNK_SIZE > CHUNK_OVERLAP);
  });
});
