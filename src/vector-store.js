// Flat cosine-similarity vector store with JSON persistence.
//
// Index format (version 1):
// {
//   version: 1,
//   configHash: string,         // SHA-256 of sorted allowlist+denylist+embedProvider+embedModel
//   embedProvider: string,
//   embedModel: string,
//   dims: number,
//   created: ISO string,
//   updated: ISO string,
//   files: { [relPath]: { mtime: number, sha256: string } },
//   chunks: [{ path, startLine, endLine, redactedText, vector: number[] }]
// }

import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';

export const INDEX_VERSION = 1;

export function computeConfigHash({ allowlist, denylist, embedProvider, embedModel }) {
  const payload = JSON.stringify({
    allowlist: [...allowlist].sort(),
    denylist: [...denylist].sort(),
    embedProvider,
    embedModel,
  });
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

export function cosine(a, b) {
  if (a.length !== b.length) {
    throw new Error(`cosine: dimension mismatch ${a.length} vs ${b.length}`);
  }
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom < 1e-10 ? 0 : dot / denom;
}

export function loadIndex(indexPath) {
  if (!existsSync(indexPath)) return null;
  try {
    return JSON.parse(readFileSync(indexPath, 'utf8'));
  } catch {
    return null;
  }
}

export function saveIndex(indexPath, index) {
  writeFileSync(indexPath, JSON.stringify(index), 'utf8');
}

export function clearIndex(indexPath) {
  if (existsSync(indexPath)) unlinkSync(indexPath);
}

/**
 * Find the top-k most similar chunks to a query vector.
 *
 * @param {number[]} queryVector
 * @param {Array} chunks - from index.chunks
 * @param {object} [opts]
 * @param {number} [opts.topK=20]
 * @param {number} [opts.threshold=0.3]
 * @returns {Array<chunk & {score: number}>} sorted by score desc
 */
export function search(queryVector, chunks, { topK = 20, threshold = 0.3 } = {}) {
  return chunks
    .map(chunk => ({ chunk, score: cosine(queryVector, chunk.vector) }))
    .filter(s => s.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map(({ chunk, score }) => ({ ...chunk, score }));
}

/**
 * Compute a fingerprint for change detection.
 * @param {Buffer} buf - raw file bytes
 * @param {number} mtime - file mtimeMs from fs.stat()
 */
export function fileFingerprint(buf, mtime) {
  return {
    mtime,
    sha256: createHash('sha256').update(buf).digest('hex'),
  };
}

/**
 * Returns true if the file has changed since the stored fingerprint was taken.
 */
export function isStale(stored, current) {
  if (stored.mtime === current.mtime) return false;
  return stored.sha256 !== current.sha256;
}
