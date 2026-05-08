// Pseudonymization: reversible identifier replacement.
//
// Unlike redact() (which replaces values with category placeholders, lossy),
// pseudonymize() replaces values with stable per-call placeholders and keeps
// a mapping so the LLM's response can be unmapped back.
//
// Use case: "trace this customer's phone through the code" - the LLM needs
// to reason about PHONE_001 as a reference, but never sees the actual digits.
//
// The mapping is per-call only. It is NOT persisted. After the call completes
// and the response is unmapped, the mapping is dropped.

import { redact } from './redact.js';

// We re-use the redact patterns to find what to pseudonymize. To avoid
// duplicating the pattern list, we run redact() in "capture" mode by replacing
// its substitutions with a sentinel and then walking the diff. Simpler approach:
// run our own pattern walk that builds the map.
//
// We intentionally only pseudonymize PII categories, not API keys/secrets.
// API keys etc. should still be HARD-redacted (lossy) - we never want them to
// round-trip even via mapping.
const PSEUDONYM_PATTERNS = [
  { name: 'phone',  re: /(?<!\d)(?:\(\d{3}\)\s?|\d{3}[-.\s])\d{3}[-.\s]\d{4}(?!\d)/g },
  { name: 'phone',  re: /\+\d{1,3}[\s.-]?\(?\d{1,4}\)?(?:[\s.-]?\d{1,4}){2,4}\b/g },
  { name: 'email',  re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { name: 'ssn',    re: /(?<!\d)\d{3}-\d{2}-\d{4}(?!\d)/g },
];

/**
 * Build a pseudonymized copy of `input` plus a forward+reverse map.
 *
 * - Identical values get identical placeholders (deterministic per call).
 * - High-risk secrets are redacted via the lossy redact() pass FIRST,
 *   before pseudonymization runs. They never enter the mapping table.
 *
 * @param {string} input
 * @returns {{ text: string, map: Map<string, string>, reverse: Map<string, string>, counts: Record<string, number> }}
 *   - map: original value → placeholder (for diagnostics)
 *   - reverse: placeholder → original value (used to unmap responses)
 */
export function pseudonymize(input) {
  if (typeof input !== 'string') {
    throw new TypeError('pseudonymize() requires a string');
  }

  // Stage 1: lossy redact for hard secrets (API keys, JWTs, DB URIs, bearer
  // tokens, secret_assignments). These are NEVER round-tripped.
  // We pass categories: ['secret'] to skip PII patterns - those are handled in
  // stage 2 by the pseudonymizer so they remain reversible.
  const { text: hardRedacted } = redact(input, { categories: ['secret'] });

  // Stage 2: walk PII patterns, replacing each match with a stable placeholder.
  const map = new Map();      // original → placeholder
  const reverse = new Map();  // placeholder → original
  const counts = {};
  const counters = {};

  let text = hardRedacted;
  for (const pat of PSEUDONYM_PATTERNS) {
    const re = new RegExp(pat.re.source, pat.re.flags);
    text = text.replace(re, (match) => {
      let placeholder = map.get(match);
      if (!placeholder) {
        counters[pat.name] = (counters[pat.name] ?? 0) + 1;
        placeholder = `${pat.name.toUpperCase()}_${String(counters[pat.name]).padStart(3, '0')}`;
        map.set(match, placeholder);
        reverse.set(placeholder, match);
      }
      counts[pat.name] = (counts[pat.name] ?? 0) + 1;
      return placeholder;
    });
  }

  return { text, map, reverse, counts };
}

/**
 * Replace placeholders in `text` with their original values from `reverse`.
 * Only known placeholders are unmapped - placeholders that DeepSeek may have
 * hallucinated (PHONE_999 with no matching entry) are left as-is.
 *
 * @param {string} text
 * @param {Map<string, string>} reverse
 * @returns {{ text: string, unmapped: number, hallucinated: string[] }}
 */
export function unpseudonymize(text, reverse) {
  if (typeof text !== 'string') throw new TypeError('unpseudonymize() requires a string');
  if (!(reverse instanceof Map)) throw new TypeError('reverse must be a Map');

  let unmapped = 0;
  const hallucinated = new Set();

  // Find all *_NNN style placeholders we issue (PHONE_001, EMAIL_042, ...).
  const placeholderRe = /\b([A-Z]+)_(\d{3})\b/g;
  const result = text.replace(placeholderRe, (match) => {
    if (reverse.has(match)) {
      unmapped++;
      return reverse.get(match);
    }
    // Looks like one of our placeholders, but not in our map.
    // This is the LLM hallucinating an identifier that didn't exist in input.
    hallucinated.add(match);
    return match;
  });

  return { text: result, unmapped, hallucinated: [...hallucinated] };
}
