'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { resolveRepo } = require('./repo.js');

// Create a unique temp base dir per test and clean it up afterwards.
function tmpBase(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-repo-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return base;
}

function write(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

test('.git directory: resolves root, name, and branch', (t) => {
  const base = tmpBase(t);
  const repo = path.join(base, 'acme-api');
  write(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');

  assert.deepEqual(resolveRepo(repo), {
    repo_root: repo,
    repo_name: 'acme-api',
    branch: 'main',
  });
});

test('nested subdirectory resolves up to the repo root (notifier bug fix)', (t) => {
  const base = tmpBase(t);
  const repo = path.join(base, 'acme-api');
  write(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  const deep = path.join(repo, 'packages', 'worker', 'src');
  fs.mkdirSync(deep, { recursive: true });

  const r = resolveRepo(deep);
  assert.equal(r.repo_root, repo);
  assert.equal(r.repo_name, 'acme-api'); // not "src" or "worker"
  assert.equal(r.branch, 'main');
});

test('.git FILE (worktree): follows gitdir pointer to read HEAD', (t) => {
  const base = tmpBase(t);
  // Main repo holds the real git dir with a per-worktree HEAD.
  const mainRepo = path.join(base, 'main-repo');
  const wtGitDir = path.join(mainRepo, '.git', 'worktrees', 'wt1');
  write(path.join(wtGitDir, 'HEAD'), 'ref: refs/heads/feature/login\n');

  // The worktree directory's `.git` is a FILE pointing at that git dir.
  const worktree = path.join(base, 'acme-api-wt');
  write(path.join(worktree, '.git'), `gitdir: ${wtGitDir}\n`);

  const r = resolveRepo(worktree);
  assert.equal(r.repo_root, worktree); // dir containing the .git FILE
  assert.equal(r.repo_name, 'acme-api-wt');
  assert.equal(r.branch, 'feature/login'); // multi-segment branch preserved
});

test('.git FILE (worktree) with a RELATIVE gitdir pointer: resolves HEAD', (t) => {
  const base = tmpBase(t);
  // Real git worktree/submodule .git files commonly hold a RELATIVE pointer.
  const mainRepo = path.join(base, 'main-repo');
  const wtGitDir = path.join(mainRepo, '.git', 'worktrees', 'wt2');
  write(path.join(wtGitDir, 'HEAD'), 'ref: refs/heads/dev\n');

  const worktree = path.join(base, 'proj-wt');
  fs.mkdirSync(worktree, { recursive: true });
  const relative = path.relative(worktree, wtGitDir); // e.g. ../main-repo/.git/worktrees/wt2
  write(path.join(worktree, '.git'), `gitdir: ${relative}\n`);

  const r = resolveRepo(worktree);
  assert.equal(r.repo_root, worktree);
  assert.equal(r.repo_name, 'proj-wt');
  assert.equal(r.branch, 'dev'); // relative pointer resolved against the .git-containing dir
});

test('no .git anywhere: falls back to cwd + basename, branch null', (t) => {
  const base = tmpBase(t);
  const plain = path.join(base, 'just-a-folder', 'sub');
  fs.mkdirSync(plain, { recursive: true });

  assert.deepEqual(resolveRepo(plain), {
    repo_root: plain,
    repo_name: 'sub',
    branch: null,
  });
});

test('HEAD branch parse: multi-segment ref name is preserved whole', (t) => {
  const base = tmpBase(t);
  const repo = path.join(base, 'proj');
  write(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/release/2026-07\n');

  assert.equal(resolveRepo(repo).branch, 'release/2026-07');
});

test('detached HEAD (raw sha) yields branch null', (t) => {
  const base = tmpBase(t);
  const repo = path.join(base, 'detached');
  write(path.join(repo, '.git', 'HEAD'), '9fceb02d0ae598e95dc970b74767f19372d61af8\n');

  const r = resolveRepo(repo);
  assert.equal(r.repo_root, repo);
  assert.equal(r.repo_name, 'detached');
  assert.equal(r.branch, null);
});
