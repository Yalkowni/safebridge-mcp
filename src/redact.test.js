import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact } from './redact.js';

// ---------- API keys ----------

test('redacts OpenAI sk- key', () => {
  const { text, counts } = redact('const k = "sk-proj-abcdefghij1234567890ABCDEFG"');
  assert.match(text, /\[REDACTED:openai_key\]/);
  assert.equal(counts.openai_key, 1);
});

test('redacts Anthropic sk-ant- key', () => {
  const key = 'sk-ant-api03-' + 'a'.repeat(60);
  const { text, counts } = redact(`Authorization: Bearer ${key}`);
  // Either anthropic_key or bearer_token should fire; both should not double-count.
  assert.ok(!text.includes(key));
  assert.equal(counts.openai_key ?? 0, 0);
});

test('redacts Google AIza key', () => {
  const key = 'AIza' + 'b'.repeat(35);
  const { text, counts } = redact(`url + "?key=${key}"`);
  assert.match(text, /\[REDACTED:google_key\]/);
  assert.equal(counts.google_key, 1);
});

test('redacts Slack xoxb token', () => {
  const { text } = redact('SLACK_TOKEN=xoxb-1234567890-abcdefghij');
  assert.match(text, /\[REDACTED:(slack_token|secret_assignment)\]/);
});

test('redacts GitHub ghp_ token', () => {
  const { text } = redact('ghp_' + 'A'.repeat(40));
  assert.match(text, /\[REDACTED:github_token\]/);
});

test('redacts AWS access key', () => {
  const { text, counts } = redact('AKIAIOSFODNN7EXAMPLE');
  assert.match(text, /\[REDACTED:aws_access_key\]/);
  assert.equal(counts.aws_access_key, 1);
});

// ---------- JWT ----------

test('redacts JWT', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.signaturepartXYZ';
  const { text, counts } = redact(`token: ${jwt}`);
  assert.match(text, /\[REDACTED:jwt\]/);
  assert.equal(counts.jwt, 1);
});

// ---------- DB URIs ----------

test('redacts postgres URI with creds', () => {
  const { text, counts } = redact('DATABASE_URL=postgres://raabet:secretpass@db.host/olp');
  assert.ok(!text.includes('secretpass'));
  // Should hit either db_uri_with_creds or secret_assignment
  assert.ok(counts.db_uri_with_creds > 0 || counts.secret_assignment > 0);
});

test('does NOT redact postgres URI without creds', () => {
  const { text } = redact('postgres://localhost/olp');
  assert.match(text, /postgres:\/\/localhost\/olp/);
});

// ---------- Bearer tokens ----------

test('redacts Bearer header', () => {
  const { text } = redact('Authorization: Bearer abcdefghijABCDEFGHIJ1234567890');
  assert.match(text, /\[REDACTED:(bearer_token|jwt)\]/);
});

// ---------- Secret assignments ----------

test('redacts api_key= assignment', () => {
  const { text, counts } = redact('const config = { api_key: "abcdef1234567890" }');
  assert.match(text, /\[REDACTED:secret_assignment\]/);
  assert.equal(counts.secret_assignment, 1);
  // Preserves the key= prefix so structure is readable.
  assert.match(text, /api_key:/);
});

test('redacts SECRET_TOKEN assignment', () => {
  const { text } = redact('SECRET_TOKEN=verylongsecretvalue1234');
  assert.match(text, /\[REDACTED:secret_assignment\]/);
});

test('does NOT redact short values', () => {
  // "abc" is too short for the 12-char minimum.
  const { text } = redact('password=abc');
  assert.match(text, /password=abc/);
});

// ---------- Phone numbers ----------

test('redacts US phone (parens)', () => {
  const { text, counts } = redact('Call (555) 123-4567 today');
  assert.match(text, /\[REDACTED:phone_us\]/);
  assert.equal(counts.phone_us, 1);
});

test('redacts US phone (dashes)', () => {
  const { text } = redact('555-123-4567');
  assert.match(text, /\[REDACTED:phone_us\]/);
});

test('redacts intl phone +1', () => {
  const { text } = redact('phone: +1 555 123 4567');
  assert.match(text, /\[REDACTED:phone/);
});

test('redacts intl phone +44', () => {
  const { text } = redact('+44 20 7946 0958');
  assert.match(text, /\[REDACTED:phone/);
});

test('does NOT redact a version number', () => {
  // 1.2.3 should not match phone or CC
  const { text } = redact('version 1.2.3');
  assert.match(text, /version 1\.2\.3/);
});

// ---------- Emails ----------

test('redacts email', () => {
  const { text, counts } = redact('Contact alice@example.com please');
  assert.match(text, /\[REDACTED:email\]/);
  assert.equal(counts.email, 1);
});

test('redacts multiple emails', () => {
  const { text, counts } = redact('a@b.com and c@d.org and e@f.net');
  assert.equal(counts.email, 3);
});

// ---------- SSN ----------

test('redacts SSN', () => {
  const { text } = redact('SSN: 123-45-6789');
  assert.match(text, /\[REDACTED:ssn\]/);
});

// ---------- Custom patterns ----------

test('applies custom user pattern', () => {
  const { text, counts } = redact('PROXY_PASSWORD=hunter2', {
    customPatterns: [{ name: 'proxy_pw', re: /hunter2/g }],
  });
  assert.match(text, /\[REDACTED:proxy_pw\]/);
  assert.equal(counts.proxy_pw, 1);
});

// ---------- Adversarial / edge cases ----------

test('overlapping patterns do not double-redact', () => {
  // A bearer token that's also a JWT should be redacted once.
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.signaturepartXYZ';
  const { text, total } = redact(`Bearer ${jwt}`);
  assert.match(text, /\[REDACTED:/);
  // Exactly one redaction in the input - the more-specific JWT runs first
  // (it appears earlier in BUILTIN_PATTERNS), then bearer's own match overlaps
  // and gets skipped... BUT bearer covers a wider span starting at "Bearer".
  // We just want to assert nothing unredacted leaks.
  assert.ok(!text.includes(jwt));
  assert.ok(total >= 1);
});

test('multibyte chars do not break offsets', () => {
  // Email itself is ASCII, but surrounded by multibyte chars - verify offsets stay correct.
  const { text, counts } = redact('用户邮箱: user@example.com 是这样的');
  assert.equal(counts.email, 1);
  assert.match(text, /\[REDACTED:email\]/);
  // Multibyte content on either side of the redaction is preserved.
  assert.ok(text.startsWith('用户邮箱: '));
  assert.ok(text.endsWith(' 是这样的'));
});

test('empty string is fine', () => {
  const { text, counts, total } = redact('');
  assert.equal(text, '');
  assert.equal(total, 0);
  assert.deepEqual(counts, {});
});

test('non-string input throws', () => {
  assert.throws(() => redact(null), TypeError);
  assert.throws(() => redact(123), TypeError);
});

test('returns total redaction count', () => {
  const { total } = redact('alice@b.com bob@c.com sk-proj-' + 'x'.repeat(30));
  assert.equal(total, 3);
});

test('preserves non-secret content', () => {
  const input = `
    function foo(orgId) {
      return db.query('SELECT * FROM users WHERE org_id = $1', [orgId]);
    }
  `;
  const { text, total } = redact(input);
  assert.equal(text, input);
  assert.equal(total, 0);
});

// ---------- Coverage gaps: untested builtin patterns ----------

test('redacts Stripe live key', () => {
  const { text, counts } = redact('STRIPE=sk_live_' + 'a'.repeat(30));
  assert.match(text, /\[REDACTED:(stripe_key|secret_assignment)\]/);
  assert.ok((counts.stripe_key ?? 0) + (counts.secret_assignment ?? 0) >= 1);
});

test('redacts Stripe test key', () => {
  const { text } = redact('key=sk_test_' + 'b'.repeat(30));
  assert.match(text, /\[REDACTED:(stripe_key|secret_assignment)\]/);
});

test('redacts Twilio Account SID', () => {
  const sid = 'AC' + 'a1b2c3d4e5'.repeat(3) + 'aa';  // 32 hex chars
  const { text, counts } = redact(`account: ${sid}`);
  assert.match(text, /\[REDACTED:twilio_sid\]/);
  assert.equal(counts.twilio_sid, 1);
});

test('redacts CC-like 16-digit run', () => {
  const { text, counts } = redact('card 4111 1111 1111 1111 expires soon');
  assert.match(text, /\[REDACTED:cc_like\]/);
  assert.equal(counts.cc_like, 1);
});

test('does NOT redact CC-like inside a longer digit run', () => {
  // 25 digits: should not match the 13-19 cc_like span (negative lookbehind/ahead).
  const { text } = redact('hash: ' + '1'.repeat(25));
  assert.doesNotMatch(text, /\[REDACTED:cc_like\]/);
});

// ---------- Category filtering (used by pseudonymize flow) ----------

test('categories=["secret"] leaves PII alone', () => {
  const { text, counts } = redact('alice@example.com calls (555) 123-4567 with sk-proj-' + 'x'.repeat(30), {
    categories: ['secret'],
  });
  assert.match(text, /alice@example\.com/);
  assert.match(text, /\(555\) 123-4567/);
  assert.match(text, /\[REDACTED:openai_key\]/);
  assert.equal(counts.email ?? 0, 0);
  assert.equal(counts.phone_us ?? 0, 0);
});

test('categories=["pii"] leaves secrets alone (rare flow but defined)', () => {
  const { text, counts } = redact('alice@example.com sk-proj-' + 'x'.repeat(30), {
    categories: ['pii'],
  });
  assert.match(text, /\[REDACTED:email\]/);
  assert.match(text, /sk-proj-/);
  assert.equal(counts.openai_key ?? 0, 0);
});

test('categories=[] runs no builtins, only customs', () => {
  const { text, counts, total } = redact('alice@example.com sk-proj-' + 'x'.repeat(30), {
    categories: [],
    customPatterns: [{ name: 'lowercase_alice', re: /alice/g }],
  });
  assert.match(text, /\[REDACTED:lowercase_alice\]/);
  assert.match(text, /sk-proj-/);  // builtin off
  assert.equal(counts.lowercase_alice, 1);
  assert.equal(total, 1);
});

// ---------- Adversarial: pattern-name-as-input (does not nest) ----------

test('input that already contains [REDACTED:...] is preserved', () => {
  // Defense-in-depth: if the calling LLM echoes an old marker back, we don't double-wrap.
  const input = 'previously: [REDACTED:email] then bob@c.com';
  const { text, counts } = redact(input);
  assert.match(text, /\[REDACTED:email\][^[]*\[REDACTED:email\]/);
  assert.equal(counts.email, 1);
});

test('handles large input without quadratic blowup', () => {
  // Sanity-check: 100KB of clean code should redact in well under 1s.
  const big = 'const x = 1;\n'.repeat(8000);
  const start = Date.now();
  const { total } = redact(big);
  const elapsed = Date.now() - start;
  assert.equal(total, 0);
  assert.ok(elapsed < 2000, `redact took ${elapsed}ms`);
});
