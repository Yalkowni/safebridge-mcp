// File access gating: allowlist + denylist + path traversal protection.
//
// Caller provides glob patterns (relative to project root). This module:
// 1. Walks the filesystem from the project root (skipping denylisted dirs).
// 2. Returns files matching at least one allowlist glob.
// 3. Removes any file matching any denylist glob (denylist wins).
// 4. Refuses any path that resolves outside the project root.
//
// All globs use forward slashes, even on Windows. Internal paths are normalized.

import { readdirSync, statSync } from 'node:fs';
import { resolve, relative, sep, posix } from 'node:path';

/**
 * Convert a glob pattern to a RegExp.
 *
 * Supported syntax:
 *   *          - any characters except '/'
 *   **         - any characters including '/'
 *   ?          - one character except '/'
 *   {a,b,c}    - alternation
 *   [abc]      - character class (passed through to regex)
 *
 * Anything else is escaped literally.
 */
export function globToRegex(glob) {
  let re = '';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // ** - match anything including slashes
        re += '.*';
        i += 2;
        // Allow **/ to match zero dirs too: collapse following slash into the .*
        if (glob[i] === '/') i++;
      } else {
        re += '[^/]*';
        i++;
      }
    } else if (c === '?') {
      re += '[^/]';
      i++;
    } else if (c === '{') {
      // Find matching }
      const close = glob.indexOf('}', i);
      if (close < 0) { re += '\\{'; i++; continue; }
      const inner = glob.slice(i + 1, close);
      const parts = inner.split(',').map(p => globToRegex(p).source.replace(/^\^|\$$/g, ''));
      re += '(?:' + parts.join('|') + ')';
      i = close + 1;
    } else if (c === '[') {
      // Character class - find closing ]
      const close = glob.indexOf(']', i + 1);
      if (close < 0) { re += '\\['; i++; continue; }
      re += glob.slice(i, close + 1);
      i = close + 1;
    } else if ('.+^$()|\\'.includes(c)) {
      re += '\\' + c;
      i++;
    } else {
      re += c;
      i++;
    }
  }
  return new RegExp('^' + re + '$');
}

/**
 * Test whether a relative path matches any of the globs.
 * Path must use forward slashes.
 */
export function matchesAny(relPath, globs) {
  for (const g of globs) {
    if (globToRegex(g).test(relPath)) return true;
  }
  return false;
}

/**
 * Resolve a path safely against a root. Throws if the resolved path
 * escapes the root via .. or absolute traversal.
 */
export function safeResolve(root, candidate) {
  const absRoot = resolve(root);
  const absCandidate = resolve(absRoot, candidate);
  const rel = relative(absRoot, absCandidate);
  if (rel.startsWith('..') || (rel.length > 0 && rel[0] === sep && !rel.startsWith(sep + sep))) {
    throw new Error(`path traversal: ${candidate} resolves outside ${absRoot}`);
  }
  return absCandidate;
}

function toForwardSlash(p) {
  return p.split(sep).join('/');
}

/**
 * Walk a directory and yield relative paths (forward-slash).
 * Skips any directory whose relative path matches a denylist glob.
 */
export function* walkFiles(root, denyGlobs = []) {
  const absRoot = resolve(root);
  const stack = [absRoot];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const abs = resolve(dir, entry.name);
      const relRaw = relative(absRoot, abs);
      if (relRaw === '' || relRaw.startsWith('..')) continue;
      const rel = toForwardSlash(relRaw);
      if (entry.isDirectory()) {
        // If any denylist glob matches this dir prefix (e.g. node_modules/**),
        // skip the whole subtree. We test against `<rel>/x` to give the trailing
        // /** style globs something to anchor on.
        if (matchesAny(rel + '/x', denyGlobs)) continue;
        stack.push(abs);
      } else if (entry.isFile()) {
        yield { rel, abs };
      }
    }
  }
}

/**
 * Find files in `root` matching any allowlist glob, excluding any denylist match.
 *
 * @param {object} args
 * @param {string} args.root - Absolute path to project root.
 * @param {string[]} args.allowlist - Globs (relative, forward slash).
 * @param {string[]} args.denylist - Globs (relative, forward slash). Wins over allowlist.
 * @param {string[]} [args.requestedGlobs] - If provided, file must ALSO match one of these
 *   (lets callers narrow further without bypassing safety).
 * @returns {Array<{ rel: string, abs: string }>}
 */
export function findFiles({ root, allowlist, denylist, requestedGlobs }) {
  const out = [];
  for (const file of walkFiles(root, denylist)) {
    if (matchesAny(file.rel, denylist)) continue;
    if (!matchesAny(file.rel, allowlist)) continue;
    if (requestedGlobs && !matchesAny(file.rel, requestedGlobs)) continue;
    out.push(file);
  }
  return out;
}

/**
 * Verify that requested globs themselves don't try to escape the allowlist
 * (e.g. caller passes "../../etc/passwd"). Each glob is converted to a regex
 * and tested for traversal-like literals; we also refuse absolute paths.
 */
export function validateRequestedGlobs(globs) {
  for (const g of globs) {
    if (typeof g !== 'string' || g.length === 0) {
      throw new Error(`invalid glob: ${JSON.stringify(g)}`);
    }
    if (g.startsWith('/') || /^[A-Za-z]:/.test(g)) {
      throw new Error(`absolute path not allowed in glob: ${g}`);
    }
    if (g.includes('..')) {
      throw new Error(`'..' not allowed in glob: ${g}`);
    }
    if (g.includes('\0')) {
      throw new Error(`null byte not allowed in glob: ${g}`);
    }
  }
}
