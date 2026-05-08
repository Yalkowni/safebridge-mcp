// Redaction layer. Replaces known-shape secrets / PII with category placeholders
// in BOTH outbound (file content + prompts) and inbound (LLM responses) directions.
//
// Design notes:
// - Every match becomes "[REDACTED:<category>]". The calling LLM can still reason
//   about structure (this is a phone, that's a key) without seeing values.
// - Patterns are ordered: most-specific first. Once a span is redacted, later
//   patterns won't re-match it (we operate on a "consumed" mask).
// - Returns { text, counts } so audit log records what was scrubbed.

// Each pattern is tagged with a category:
//   'secret' - API keys, JWTs, DB credentials. Always lossy. Never pseudonymize.
//   'pii'    - phones, emails, SSN, CC. May be pseudonymized (reversible).
const BUILTIN_PATTERNS = [
  // ---- Provider API keys (high specificity, do first) ----
  // Order matters: more-specific keys first so they consume bytes before
  // more-permissive patterns can mis-match. (sk-ant-... would also match the
  // openai_key regex, so anthropic must run first.)
  { name: 'anthropic_key',     category: 'secret', re: /sk-ant-(?:api\d{2}-)?[A-Za-z0-9_-]{40,}/g },
  { name: 'openai_key',        category: 'secret', re: /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g },
  { name: 'google_key',        category: 'secret', re: /AIza[0-9A-Za-z_-]{35}/g },
  { name: 'slack_token',       category: 'secret', re: /xox[baprs]-[A-Za-z0-9-]{10,}/g },
  { name: 'github_token',      category: 'secret', re: /gh[pousr]_[A-Za-z0-9]{36,}/g },
  { name: 'aws_access_key',    category: 'secret', re: /AKIA[0-9A-Z]{16}/g },
  { name: 'stripe_key',        category: 'secret', re: /sk_(?:test|live)_[A-Za-z0-9]{20,}/g },
  { name: 'twilio_sid',        category: 'secret', re: /AC[a-f0-9]{32}/g },

  // ---- JWTs (3 dot-separated base64url segments, header starts with eyJ) ----
  { name: 'jwt',               category: 'secret', re: /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },

  // ---- DB connection strings with credentials ----
  { name: 'db_uri_with_creds', category: 'secret', re: /\b(?:postgres(?:ql)?|mysql|redis|mongodb(?:\+srv)?):\/\/[^\s:@/]+:[^\s@/]+@[^\s/]+/g },

  // ---- Bearer tokens in headers / strings ----
  { name: 'bearer_token',      category: 'secret', re: /\bBearer\s+[A-Za-z0-9._\-+/=]{20,}/g },

  // ---- Generic "secret-shaped" assignments ----
  // matches: api_key="...", password: '...', SECRET_TOKEN=..., API_KEY_PROD=...
  { name: 'secret_assignment', category: 'secret',
    re: /\b([A-Z_]*(?:API[_-]?KEY|SECRET|PASSWORD|PASSWD|TOKEN|AUTH[_-]?TOKEN|ACCESS[_-]?KEY|PRIVATE[_-]?KEY)[A-Z_]*\s*[:=]\s*)["']?([A-Za-z0-9._\-+/=]{12,})["']?/gi,
    replacer: (_match, prefix /* keep the key= part */) => `${prefix}[REDACTED:secret_assignment]` },

  // ---- Phone numbers ----
  { name: 'phone_intl',        category: 'pii', re: /\+\d{1,3}[\s.-]?\(?\d{1,4}\)?(?:[\s.-]?\d{1,4}){2,4}\b/g },
  { name: 'phone_us',          category: 'pii', re: /(?<!\d)(?:\(\d{3}\)\s?|\d{3}[-.\s])\d{3}[-.\s]\d{4}(?!\d)/g },

  // ---- Email addresses ----
  { name: 'email',             category: 'pii', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },

  // ---- Credit-card-like 13-19 digit runs (best-effort, not Luhn) ----
  { name: 'cc_like',           category: 'pii', re: /(?<!\d)(?:\d[ -]?){13,19}(?!\d)/g },

  // ---- US SSN ----
  { name: 'ssn',               category: 'pii', re: /(?<!\d)\d{3}-\d{2}-\d{4}(?!\d)/g },
];

function applyPattern(text, mask, pattern) {
  // Walk matches; skip any whose span overlaps an already-consumed range.
  const re = new RegExp(pattern.re.source, pattern.re.flags);
  let count = 0;
  let result = '';
  let lastEnd = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    // Skip if any byte in [start, end) is masked.
    let overlaps = false;
    for (let i = start; i < end; i++) {
      if (mask[i]) { overlaps = true; break; }
    }
    if (overlaps) continue;

    let replacement;
    if (pattern.replacer) {
      replacement = pattern.replacer(...m);
    } else {
      replacement = `[REDACTED:${pattern.name}]`;
    }
    result += text.slice(lastEnd, start) + replacement;
    // Mark the original span as consumed so later patterns can't re-match.
    for (let i = start; i < end; i++) mask[i] = 1;
    lastEnd = end;
    count++;
  }
  result += text.slice(lastEnd);
  return { text: result, count };
}

/**
 * Redact secrets/PII from text.
 *
 * @param {string} input - The text to scrub.
 * @param {object} [opts]
 * @param {Array<{name: string, re: RegExp, replacer?: Function}>} [opts.customPatterns] -
 *   Additional regex patterns. Run AFTER builtins, on what's left.
 * @param {Array<'secret'|'pii'>} [opts.categories] -
 *   Which builtin categories to apply. Defaults to both. Custom patterns always run.
 * @returns {{ text: string, counts: Record<string, number>, total: number }}
 */
export function redact(input, opts = {}) {
  if (typeof input !== 'string') {
    throw new TypeError('redact() requires a string');
  }
  const customPatterns = opts.customPatterns ?? [];
  const categories = opts.categories ?? ['secret', 'pii'];
  const counts = {};
  let total = 0;
  let text = input;
  const filtered = BUILTIN_PATTERNS.filter(p => categories.includes(p.category));
  // Mask tracks which character positions in the CURRENT `text` are already
  // redacted. We rebuild `text` after each pattern, so the mask resets per pattern.
  for (const pattern of [...filtered, ...customPatterns]) {
    const mask = new Uint8Array(text.length);
    const { text: next, count } = applyPattern(text, mask, pattern);
    if (count > 0) {
      counts[pattern.name] = (counts[pattern.name] ?? 0) + count;
      total += count;
    }
    text = next;
  }
  return { text, counts, total };
}

export const _internal = { BUILTIN_PATTERNS };
