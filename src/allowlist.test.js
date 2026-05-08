import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  globToRegex,
  matchesAny,
  safeResolve,
  walkFiles,
  findFiles,
  validateRequestedGlobs,
} from './allowlist.js';

// ---------- glob → regex ----------

test('glob: literal match', () => {
  assert.match('foo.js', globToRegex('foo.js'));
  assert.doesNotMatch('foo.ts', globToRegex('foo.js'));
});

test('glob: * matches single segment', () => {
  assert.match('foo.js', globToRegex('*.js'));
  assert.doesNotMatch('a/foo.js', globToRegex('*.js'));
});

test('glob: ** matches across segments', () => {
  assert.match('a/b/c/foo.js', globToRegex('**/*.js'));
  assert.match('foo.js', globToRegex('**/*.js'));
});

test('glob: brace alternation', () => {
  const re = globToRegex('*.{ts,tsx}');
  assert.match('foo.ts', re);
  assert.match('foo.tsx', re);
  assert.doesNotMatch('foo.js', re);
});

test('glob: nested path with brace', () => {
  const re = globToRegex('server/src/**/*.{ts,js}');
  assert.match('server/src/index.ts', re);
  assert.match('server/src/lib/util.js', re);
  assert.doesNotMatch('server/src/index.tsx', re);
  assert.doesNotMatch('dashboard/src/foo.ts', re);
});

test('glob: ? matches one char', () => {
  const re = globToRegex('a?.txt');
  assert.match('ab.txt', re);
  assert.doesNotMatch('abc.txt', re);
});

// ---------- matchesAny ----------

test('matchesAny: empty list returns false', () => {
  assert.equal(matchesAny('foo.js', []), false);
});

test('matchesAny: any match wins', () => {
  assert.equal(matchesAny('a.ts', ['*.js', '*.ts']), true);
});

// ---------- safeResolve ----------

test('safeResolve: allows path inside root', () => {
  const root = process.cwd();
  const r = safeResolve(root, 'foo/bar.js');
  assert.ok(r.startsWith(root));
});

test('safeResolve: rejects ..', () => {
  assert.throws(() => safeResolve('/srv/app', '../etc/passwd'), /path traversal/);
});

test('safeResolve: rejects absolute escape', () => {
  // resolve('/srv/app', '/etc/passwd') = '/etc/passwd' on POSIX; rel will start with '..'
  if (process.platform !== 'win32') {
    assert.throws(() => safeResolve('/srv/app', '/etc/passwd'), /path traversal/);
  }
});

// ---------- validateRequestedGlobs ----------

test('validateRequestedGlobs: ok for normal glob', () => {
  validateRequestedGlobs(['server/src/**/*.ts', '*.md']);
});

test('validateRequestedGlobs: rejects ..', () => {
  assert.throws(() => validateRequestedGlobs(['../etc/passwd']), /'\.\.'/);
});

test('validateRequestedGlobs: rejects absolute', () => {
  assert.throws(() => validateRequestedGlobs(['/etc/passwd']), /absolute/);
  assert.throws(() => validateRequestedGlobs(['C:/Windows']), /absolute/);
});

test('validateRequestedGlobs: rejects null byte', () => {
  assert.throws(() => validateRequestedGlobs(['foo\0bar']), /null byte/);
});

test('validateRequestedGlobs: rejects empty/non-string', () => {
  assert.throws(() => validateRequestedGlobs(['']), /invalid/);
  assert.throws(() => validateRequestedGlobs([null]), /invalid/);
});

// ---------- walkFiles + findFiles (real fs in tmpdir) ----------

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'safebridge-test-'));
  mkdirSync(join(root, 'server', 'src'), { recursive: true });
  mkdirSync(join(root, 'node_modules', 'evil'), { recursive: true });
  mkdirSync(join(root, 'database', 'backups'), { recursive: true });
  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(join(root, 'server', 'src', 'index.ts'), 'export const x = 1;');
  writeFileSync(join(root, 'server', 'src', 'util.js'), 'export const y = 2;');
  writeFileSync(join(root, 'docs', 'README.md'), '# docs');
  writeFileSync(join(root, '.env'), 'DEEPSEEK_KEY=secret');
  writeFileSync(join(root, 'app.key'), 'private key bytes');
  writeFileSync(join(root, 'node_modules', 'evil', 'pkg.js'), 'do not read');
  writeFileSync(join(root, 'database', 'backups', 'dump.sql'), 'INSERT INTO ...');
  return root;
}

test('walkFiles: skips denylisted directories', () => {
  const root = makeFixture();
  try {
    const all = [...walkFiles(root, ['node_modules/**', 'database/backups/**'])];
    const paths = all.map(f => f.rel);
    assert.ok(paths.some(p => p === 'server/src/index.ts'));
    assert.ok(!paths.some(p => p.startsWith('node_modules/')));
    assert.ok(!paths.some(p => p.startsWith('database/backups/')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('findFiles: applies allowlist + denylist', () => {
  const root = makeFixture();
  try {
    const found = findFiles({
      root,
      allowlist: ['server/src/**/*.{ts,js}', 'docs/**/*.md'],
      denylist: ['**/.env*', '**/*.key', 'node_modules/**', 'database/backups/**'],
    });
    const paths = found.map(f => f.rel).sort();
    assert.deepEqual(paths, [
      'docs/README.md',
      'server/src/index.ts',
      'server/src/util.js',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('findFiles: denylist beats allowlist', () => {
  const root = makeFixture();
  try {
    const found = findFiles({
      root,
      // Deliberately allow EVERYTHING, then verify denylist still excludes secrets.
      allowlist: ['**/*'],
      denylist: ['**/.env*', '**/*.key', 'node_modules/**'],
    });
    const paths = found.map(f => f.rel);
    assert.ok(!paths.includes('.env'));
    assert.ok(!paths.includes('app.key'));
    assert.ok(!paths.some(p => p.startsWith('node_modules/')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('findFiles: requestedGlobs narrows further', () => {
  const root = makeFixture();
  try {
    const found = findFiles({
      root,
      allowlist: ['**/*'],
      denylist: ['**/.env*', '**/*.key', 'node_modules/**', 'database/backups/**'],
      requestedGlobs: ['server/src/**/*.ts'],
    });
    const paths = found.map(f => f.rel);
    assert.deepEqual(paths, ['server/src/index.ts']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------- Adversarial: requestedGlobs cannot bypass denylist ----------

test('findFiles: requestedGlobs cannot reach a denylisted file', () => {
  // Caller asks for the denylisted .env explicitly; allowlist allows everything.
  // Denylist must still win.
  const root = makeFixture();
  try {
    const found = findFiles({
      root,
      allowlist: ['**/*'],
      denylist: ['**/.env*', '**/*.key', 'node_modules/**'],
      requestedGlobs: ['.env', '**/.env*', '**/*.key'],
    });
    assert.deepEqual(found, [], 'denylist must win even when caller explicitly requests the file');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('findFiles: requestedGlobs cannot smuggle in a .key via wildcard', () => {
  const root = makeFixture();
  try {
    const found = findFiles({
      root,
      allowlist: ['**/*'],
      denylist: ['**/*.key'],
      requestedGlobs: ['app.*'],
    });
    assert.ok(!found.some(f => f.rel.endsWith('.key')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------- Symlink escape (POSIX only; Windows requires admin) ----------

test('walkFiles: symlink to outside root does not escape', { skip: process.platform === 'win32' }, async () => {
  const { symlinkSync } = await import('node:fs');
  const root = makeFixture();
  // Create a "secret" file outside the project root.
  const outside = mkdtempSync(join(tmpdir(), 'safebridge-outside-'));
  writeFileSync(join(outside, 'secret.txt'), 'TOP SECRET');
  try {
    symlinkSync(join(outside, 'secret.txt'), join(root, 'sneaky-link'));
  } catch (e) {
    // Some sandboxes refuse symlink creation; treat as skip.
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
    return;
  }
  try {
    const all = [...walkFiles(root, [])];
    const names = all.map(f => f.rel);
    // The sneaky-link entry, if it appears, must still be inside root by relative path.
    // What we DO NOT want is for the iterator to expose absolute paths outside root.
    for (const f of all) {
      assert.ok(!f.abs.startsWith(outside), `walkFiles leaked outside-root abs path: ${f.abs}`);
    }
    // Confirm the secret content didn't slip in via allowlist match.
    const found = findFiles({
      root,
      allowlist: ['**/*'],
      denylist: [],
    });
    for (const f of found) {
      assert.ok(!f.abs.startsWith(outside), `findFiles leaked outside-root abs path: ${f.abs}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

// ---------- Dotfiles + glob ----------

test('matchesAny: ** matches dotfiles', () => {
  // Confirms walkFiles + allowlist don't quietly skip .env by glob alone -
  // it must be the explicit denylist doing the work.
  assert.equal(matchesAny('.env', ['**/*']), true);
  assert.equal(matchesAny('server/.env.local', ['**/*']), true);
});
