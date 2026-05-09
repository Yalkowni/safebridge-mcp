// Fixed-size character chunker with line-range metadata.
//
// Splits text into overlapping windows of CHUNK_SIZE chars.
// Each chunk records its startLine and endLine within the source file so
// the calling LLM can cite exact locations rather than just file paths.

export const CHUNK_SIZE = 3000;    // ~750 tokens @ 4 chars/tok
export const CHUNK_OVERLAP = 150;  // overlap between consecutive chunks

/**
 * Split `text` into chunks and return metadata for each.
 *
 * @param {string} text - File content (already redacted).
 * @param {string} path - Relative path (stored as metadata, not used for I/O).
 * @param {object} [opts]
 * @param {number} [opts.chunkSize]
 * @param {number} [opts.overlap]
 * @returns {Array<{path:string, startLine:number, endLine:number, text:string}>}
 */
export function chunkText(text, path, { chunkSize = CHUNK_SIZE, overlap = CHUNK_OVERLAP } = {}) {
  if (!text || text.length === 0) return [];

  // Build a sorted array of char-offsets where each new line begins.
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') lineStarts.push(i + 1);
  }

  // Binary search: which 1-indexed line contains char offset `idx`?
  function charToLine(idx) {
    let lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if (lineStarts[mid] <= idx) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  }

  const chunks = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + chunkSize, text.length);
    chunks.push({
      path,
      startLine: charToLine(start),
      endLine: charToLine(Math.max(end - 1, start)),
      text: text.slice(start, end),
    });
    if (end >= text.length) break;
    start = end - overlap;
  }
  return chunks;
}
