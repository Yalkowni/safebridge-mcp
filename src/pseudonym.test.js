import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pseudonymize, unpseudonymize } from './pseudonym.js';

test('pseudonymize: assigns stable placeholders to phones', () => {
  const { text, map, reverse, counts } = pseudonymize(
    'Call (555) 123-4567 first, then call (555) 123-4567 again.'
  );
  // Same phone -> same placeholder.
  assert.equal(counts.phone, 2);
  assert.equal(map.size, 1);
  assert.match(text, /PHONE_001/);
  // Reverse map round-trips
  assert.equal(reverse.get('PHONE_001'), '(555) 123-4567');
});

test('pseudonymize: distinct values get distinct placeholders', () => {
  const { map, counts } = pseudonymize('a@b.com and c@d.com');
  assert.equal(counts.email, 2);
  assert.equal(map.size, 2);
});

test('pseudonymize: round-trips via unpseudonymize', () => {
  const original = 'alice@x.com called (555) 123-4567';
  const { text, reverse } = pseudonymize(original);
  // Sanity: text doesn't contain originals
  assert.ok(!text.includes('alice@x.com'));
  assert.ok(!text.includes('(555) 123-4567'));
  // Round-trip
  const { text: restored, unmapped } = unpseudonymize(text, reverse);
  assert.equal(restored, original);
  assert.equal(unmapped, 2);
});

test('pseudonymize: lossy-redacts API keys (NOT round-tripped)', () => {
  const original = 'OPENAI_KEY=sk-proj-' + 'a'.repeat(40) + ' and call (555) 123-4567';
  const { text, reverse } = pseudonymize(original);
  // Phone IS pseudonymized
  assert.match(text, /PHONE_001/);
  assert.ok(reverse.has('PHONE_001'));
  // Key is HARD-redacted, never in reverse map
  assert.match(text, /\[REDACTED:/);
  assert.ok(!text.includes('sk-proj-'));
  for (const v of reverse.values()) {
    assert.ok(!v.startsWith('sk-'));
  }
});

test('unpseudonymize: leaves hallucinated placeholders alone', () => {
  const reverse = new Map([['PHONE_001', '(555) 111-2222']]);
  const llmResponse = 'Calling PHONE_001 and PHONE_999 now.';
  const { text, unmapped, hallucinated } = unpseudonymize(llmResponse, reverse);
  assert.equal(text, 'Calling (555) 111-2222 and PHONE_999 now.');
  assert.equal(unmapped, 1);
  assert.deepEqual(hallucinated, ['PHONE_999']);
});

test('unpseudonymize: empty reverse map is fine', () => {
  const { text, unmapped, hallucinated } = unpseudonymize('plain text', new Map());
  assert.equal(text, 'plain text');
  assert.equal(unmapped, 0);
  assert.deepEqual(hallucinated, []);
});

test('pseudonymize: counts emails correctly', () => {
  const { counts, map } = pseudonymize('a@b.com sent x@y.com a note. b@c.com replied. a@b.com again.');
  // 4 occurrences, 3 unique emails
  assert.equal(counts.email, 4);
  assert.equal(map.size, 3);
});

test('pseudonymize: SSN placeholder', () => {
  const { text, reverse } = pseudonymize('SSN: 123-45-6789');
  assert.match(text, /SSN_001/);
  assert.equal(reverse.get('SSN_001'), '123-45-6789');
});

test('pseudonymize + unpseudonymize: realistic mixed content', () => {
  const original = `
function notifyCustomer(phone, email) {
  // Customer alice@example.com at (555) 123-4567
  return sms.send(phone, 'Hi alice@example.com');
}
  `.trim();
  const { text, reverse } = pseudonymize(original);
  assert.ok(!text.includes('alice@example.com'));
  assert.ok(!text.includes('(555) 123-4567'));
  // The same email appears twice; both should map to EMAIL_001
  const matches = text.match(/EMAIL_\d{3}/g);
  assert.ok(matches.length >= 2);
  assert.equal(new Set(matches).size, 1);
  // Round-trip
  const { text: restored } = unpseudonymize(text, reverse);
  assert.equal(restored, original);
});

test('non-string input throws', () => {
  assert.throws(() => pseudonymize(null), TypeError);
  assert.throws(() => unpseudonymize('x', null), TypeError);
});
