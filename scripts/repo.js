'use strict';

// Repository resolution from a cwd: walk up to the nearest `.git` (directory OR
// file — worktrees/submodules use a `.git` FILE holding `gitdir: <path>`), name
// the repo by the directory that contains `.git`, and read the branch from HEAD.
// Pure-ish: only filesystem reads, no subprocess. Never throws — on any error it
// falls back to `{ repo_root: cwd, repo_name: basename(cwd), branch: null }`.

const fs = require('fs');
const path = require('path');

// Memoize per cwd within the process — hooks resolve the same cwd repeatedly.
const cache = new Map();

function fallback(cwd) {
  return { repo_root: cwd, repo_name: path.basename(cwd), branch: null };
}

// Parse a HEAD file's contents into a branch name.
// "ref: refs/heads/<branch>" -> "<branch>" (may contain slashes, e.g. feature/x);
// a detached HEAD (a raw commit sha) -> null.
function parseBranch(headContent) {
  const m = /^ref:\s*refs\/heads\/(.+)$/.exec(headContent.trim());
  return m ? m[1].trim() : null;
}

// Resolve the directory that actually holds HEAD for a given `.git` entry.
// A `.git` directory holds HEAD directly; a `.git` FILE points elsewhere via a
// `gitdir:` line (git worktrees/submodules), possibly with a relative path.
function gitDirFor(dotGitPath, containingDir) {
  if (fs.statSync(dotGitPath).isDirectory()) return dotGitPath;
  const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGitPath, 'utf8'));
  if (!m) return null;
  const pointer = m[1].trim();
  return path.isAbsolute(pointer) ? pointer : path.resolve(containingDir, pointer);
}

function readBranch(dotGitPath, containingDir) {
  const gitDir = gitDirFor(dotGitPath, containingDir);
  if (!gitDir) return null;
  return parseBranch(fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8'));
}

function resolveUncached(cwd) {
  let dir = path.resolve(cwd);
  // Walk up to the filesystem root looking for a `.git` entry.
  for (;;) {
    const dotGit = path.join(dir, '.git');
    if (fs.existsSync(dotGit)) {
      let branch = null;
      // An unreadable/odd HEAD leaves branch null but the repo root is still valid.
      try {
        branch = readBranch(dotGit, dir);
      } catch (_err) {
        branch = null;
      }
      return { repo_root: dir, repo_name: path.basename(dir), branch };
    }
    const parent = path.dirname(dir);
    if (parent === dir) return fallback(cwd); // reached filesystem root
    dir = parent;
  }
}

function resolveRepo(cwd) {
  // Return a shallow copy (not the cached object itself) so a caller that mutates
  // a field can't silently corrupt the cache for every later caller of this cwd.
  if (cache.has(cwd)) return { ...cache.get(cwd) };
  let result;
  try {
    result = resolveUncached(cwd);
  } catch (_err) {
    result = fallback(cwd);
  }
  cache.set(cwd, result);
  return { ...result };
}

module.exports = { resolveRepo };
