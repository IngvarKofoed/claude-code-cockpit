'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ff = require('./feature-flow.js');

const NOW = Date.parse('2026-11-24T12:00:00Z');
const SID = '0b5e7c1a-1111-4c2d-9e3f-aaaaaaaaaaaa';
const SID2 = '0b5e7c1a-2222-4c2d-9e3f-bbbbbbbbbbbb';

// A fixed instant `ms` before NOW, in the skill's RFC 3339 UTC form.
function ago(ms) {
  return new Date(NOW - ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}
const MIN = 60 * 1000;
const HOUR = 60 * MIN;

function tmpBase(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-ff-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return base;
}

function write(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof contents === 'string' ? contents : JSON.stringify(contents, null, 2));
}

// A state file as state.py writes it (version 2), with overrides.
function stateFile(over = {}) {
  return {
    pending: false,
    version: 2,
    title: 'Tower stills',
    phase: 'design',
    step: '1/10 Design',
    step_name: 'Research',
    phase_label: 'Design',
    doing: 'reading the code',
    step_number: 1,
    step_total: 10,
    round: null,
    session_id: SID,
    waiting_for_user: false,
    waiting_for: null,
    updated_at: ago(5 * MIN),
    started_at: ago(40 * MIN),
    repo: '/Users/someone/code/acme',
    worktree: '/Users/someone/code/acme/.claude/worktrees/tower-stills',
    branch: 'worktree-tower-stills',
    spec: 'docs/specs/2026-11-24-tower-stills.md',
    progress_log: '/Users/someone/code/acme/.git/worktrees/tower-stills/feature-flow-progress.log',
    waiting_since: null,
    ...over,
  };
}

// A main checkout with a real `.git` dir. Returns { repo, common }.
function mainRepo(base, name = 'acme') {
  const repo = path.join(base, name);
  const common = path.join(repo, '.git');
  write(path.join(common, 'HEAD'), 'ref: refs/heads/main\n');
  return { repo, common };
}

// A linked worktree of `common`: its admin dir under common/worktrees/<name>, and a checkout
// whose `.git` FILE points at it. Returns { checkout, adminDir }.
function linkedWorktree(base, common, name, { relative = false } = {}) {
  const adminDir = path.join(common, 'worktrees', name);
  write(path.join(adminDir, 'HEAD'), `ref: refs/heads/worktree-${name}\n`);
  const checkout = path.join(base, 'wt', name);
  const pointer = relative ? path.relative(checkout, adminDir) : adminDir;
  write(path.join(checkout, '.git'), `gitdir: ${pointer}\n`);
  return { checkout, adminDir };
}

function lookupOne(sid, repoRoot, now = NOW) {
  return ff.lookupFlows([{ sessionId: sid, repoRoot }], now).get(sid) || null;
}

// ---- common git dir ---------------------------------------------------------

test('commonGitDir: a .git directory is the common dir', (t) => {
  const { repo, common } = mainRepo(tmpBase(t));
  assert.equal(ff.commonGitDir(repo), common);
});

test('commonGitDir: a linked worktree .git file resolves two levels up (absolute and relative)', (t) => {
  const base = tmpBase(t);
  const { common } = mainRepo(base);
  const abs = linkedWorktree(base, common, 'feat-a');
  const rel = linkedWorktree(base, common, 'feat-b', { relative: true });
  assert.equal(ff.commonGitDir(abs.checkout), common);
  assert.equal(ff.commonGitDir(rel.checkout), common);
});

test('commonGitDir: a submodule .git file is its own common dir', (t) => {
  const base = tmpBase(t);
  const { repo, common } = mainRepo(base);
  const modDir = path.join(common, 'modules', 'vendor-lib');
  write(path.join(modDir, 'HEAD'), 'ref: refs/heads/main\n');
  const sub = path.join(repo, 'vendor', 'lib');
  write(path.join(sub, '.git'), `gitdir: ${modDir}\n`);
  assert.equal(ff.commonGitDir(sub), modDir);
  // ...and a superproject's feature flow is not found from inside the submodule.
  write(path.join(common, ff.PENDING_DIR, `${SID}.json`), stateFile({ pending: true }));
  assert.equal(lookupOne(SID, sub), null);
  assert.notEqual(lookupOne(SID, repo), null);
});

test('commonGitDir: never throws on odd input', (t) => {
  const base = tmpBase(t);
  const noGit = path.join(base, 'plain');
  fs.mkdirSync(noGit);
  const badFile = path.join(base, 'bad');
  write(path.join(badFile, '.git'), 'not a pointer\n');
  for (const r of [null, undefined, '', 42, noGit, badFile, path.join(base, 'missing')]) {
    assert.equal(ff.commonGitDir(r), null);
  }
});

// ---- lookup -----------------------------------------------------------------

test('pending lookup: a design before its worktree is found by session id', (t) => {
  const base = tmpBase(t);
  const { repo, common } = mainRepo(base);
  write(path.join(common, ff.PENDING_DIR, `${SID}.json`), stateFile({ pending: true }));
  const p = lookupOne(SID, repo);
  assert.equal(p.stepLabel, 'Design');
  assert.equal(p.subStep, 'Research');
  assert.equal(p.doing, 'reading the code');
  assert.equal(lookupOne(SID2, repo), null, 'another session has no pending file');
});

test('worktree lookup: found from the feature worktree AND from the main checkout', (t) => {
  const base = tmpBase(t);
  const { repo, common } = mainRepo(base);
  const { checkout, adminDir } = linkedWorktree(base, common, 'tower-stills');
  write(path.join(adminDir, ff.STATE_NAME), stateFile({ step: '4/10 Building', step_name: 'Building', step_number: 4 }));
  // Another worktree, another session: never matched to SID.
  const other = linkedWorktree(base, common, 'other');
  write(path.join(other.adminDir, ff.STATE_NAME), stateFile({ session_id: SID2, step: '9/10 Feedback' }));
  for (const root of [checkout, repo]) {
    const p = lookupOne(SID, root);
    assert.equal(p.stepLabel, 'Building');
    assert.equal(p.stepNumber, 4);
  }
  assert.equal(lookupOne(SID2, repo).stepLabel, 'Feedback');
});

test('newest updated_at wins between a pending file and a worktree file, either way round', (t) => {
  const base = tmpBase(t);
  const { repo, common } = mainRepo(base);
  const { adminDir } = linkedWorktree(base, common, 'resumed');
  const pendingFile = path.join(common, ff.PENDING_DIR, `${SID}.json`);
  const wtFile = path.join(adminDir, ff.STATE_NAME);

  write(pendingFile, stateFile({ pending: true, title: 'Abandoned', updated_at: ago(3 * HOUR) }));
  write(wtFile, stateFile({ title: 'Resumed', updated_at: ago(2 * MIN) }));
  assert.equal(lookupOne(SID, repo).title, 'Resumed');

  write(pendingFile, stateFile({ pending: true, title: 'New design', updated_at: ago(1 * MIN) }));
  write(wtFile, stateFile({ title: 'Left waiting', updated_at: ago(30 * MIN) }));
  assert.equal(lookupOne(SID, repo).title, 'New design');
});

test('newest updated_at wins between two worktree files of one session', (t) => {
  const base = tmpBase(t);
  const { repo, common } = mainRepo(base);
  const a = linkedWorktree(base, common, 'aaa');
  const b = linkedWorktree(base, common, 'bbb');
  write(path.join(a.adminDir, ff.STATE_NAME), stateFile({ title: 'Older', updated_at: ago(10 * MIN) }));
  write(path.join(b.adminDir, ff.STATE_NAME), stateFile({ title: 'Newer', updated_at: ago(1 * MIN) }));
  assert.equal(lookupOne(SID, repo).title, 'Newer');
  write(path.join(a.adminDir, ff.STATE_NAME), stateFile({ title: 'Older', updated_at: ago(0) }));
  assert.equal(lookupOne(SID, repo).title, 'Older');
});

test('sessions of one repo share one scan; each gets only its own file', (t) => {
  const base = tmpBase(t);
  const { repo, common } = mainRepo(base);
  const a = linkedWorktree(base, common, 'aaa');
  write(path.join(a.adminDir, ff.STATE_NAME), stateFile({ title: 'Mine' }));
  write(path.join(common, ff.PENDING_DIR, `${SID2}.json`), stateFile({ pending: true, session_id: SID2, title: 'Theirs' }));
  const m = ff.lookupFlows(
    [
      { sessionId: SID, repoRoot: a.checkout },
      { sessionId: SID2, repoRoot: repo },
      { sessionId: 'no-flow-here', repoRoot: repo },
    ],
    NOW,
  );
  assert.equal(m.size, 2);
  assert.equal(m.get(SID).title, 'Mine');
  assert.equal(m.get(SID2).title, 'Theirs');
});

test('sid shape check: an id that is not an opaque token never reaches a path', (t) => {
  const base = tmpBase(t);
  const { repo, common } = mainRepo(base);
  // A file a traversal id would reach if it were used in a path: <common>/evil.json.
  const evil = '../evil';
  write(path.join(common, 'evil.json'), stateFile({ session_id: evil }));
  // And a worktree file claiming that id: also never matched, since the id is never looked up.
  const a = linkedWorktree(base, common, 'aaa');
  write(path.join(a.adminDir, ff.STATE_NAME), stateFile({ session_id: evil }));
  for (const sid of [evil, 'a/b', 'a b', '', 'x'.repeat(129), null, 7]) {
    assert.equal(ff.lookupFlows([{ sessionId: sid, repoRoot: repo }], NOW).size, 0, String(sid));
  }
  assert.equal(ff.isSessionId(SID), true);
  assert.equal(ff.isSessionId('abc_DEF-123'), true);
});

test('a pending file whose session_id does not match its file name is ignored', (t) => {
  const base = tmpBase(t);
  const { repo, common } = mainRepo(base);
  write(path.join(common, ff.PENDING_DIR, `${SID}.json`), stateFile({ pending: true, session_id: SID2 }));
  assert.equal(lookupOne(SID, repo), null);
  write(path.join(common, ff.PENDING_DIR, `${SID}.json`), stateFile({ pending: true, session_id: undefined }));
  assert.equal(lookupOne(SID, repo), null);
});

test('version missing or below 2 is ignored; 2 and above are read', (t) => {
  const base = tmpBase(t);
  const { repo, common } = mainRepo(base);
  const file = path.join(common, ff.PENDING_DIR, `${SID}.json`);
  for (const v of [undefined, null, 1, 1.9, '2', '3']) {
    write(file, stateFile({ pending: true, version: v }));
    assert.equal(lookupOne(SID, repo), null, `version ${JSON.stringify(v)}`);
  }
  for (const v of [2, 3]) {
    write(file, stateFile({ pending: true, version: v }));
    assert.notEqual(lookupOne(SID, repo), null, `version ${v}`);
  }
});

test('an unparseable, empty, non-object or oversized file is skipped and another candidate still wins', (t) => {
  const base = tmpBase(t);
  const { repo, common } = mainRepo(base);
  const a = linkedWorktree(base, common, 'aaa');
  const file = path.join(common, ff.PENDING_DIR, `${SID}.json`);
  write(path.join(a.adminDir, ff.STATE_NAME), stateFile({ title: 'Good', updated_at: ago(50 * MIN) }));
  for (const bad of ['{ "version": 2, "session_id": "', '', '[]', 'null', '"text"', ' '.repeat(70 * 1024)]) {
    write(file, bad);
    assert.equal(lookupOne(SID, repo).title, 'Good');
  }
  assert.equal(ff.readStateFile(path.join(base, 'nope.json')), null);
  assert.equal(ff.readStateFile(common), null, 'a directory is not a state file');
});

test('missing or unparseable updated_at: updatedAt null, never quiet, loses any tie', (t) => {
  const base = tmpBase(t);
  const { repo, common } = mainRepo(base);
  const a = linkedWorktree(base, common, 'aaa');
  const b = linkedWorktree(base, common, 'bbb');
  write(path.join(a.adminDir, ff.STATE_NAME), stateFile({ title: 'No time', updated_at: undefined }));
  let p = lookupOne(SID, repo);
  assert.equal(p.title, 'No time', 'alone, a file with no updated_at is still shown');
  assert.equal(p.updatedAt, null);
  assert.equal(p.quiet, false);
  write(path.join(a.adminDir, ff.STATE_NAME), stateFile({ title: 'Garbled', updated_at: 'yesterday-ish' }));
  write(path.join(b.adminDir, ff.STATE_NAME), stateFile({ title: 'Ancient', updated_at: ago(400 * 24 * HOUR) }));
  p = lookupOne(SID, repo);
  assert.equal(p.title, 'Ancient', 'any real timestamp beats a missing one');
});

// ---- staleness --------------------------------------------------------------

test('pending files over 24h old are dropped; worktree files are not', (t) => {
  const base = tmpBase(t);
  const { repo, common } = mainRepo(base);
  const file = path.join(common, ff.PENDING_DIR, `${SID}.json`);
  write(file, stateFile({ pending: true, updated_at: ago(24 * HOUR + MIN) }));
  assert.equal(lookupOne(SID, repo), null);
  write(file, stateFile({ pending: true, updated_at: ago(23 * HOUR) }));
  assert.equal(lookupOne(SID, repo).quiet, true);
  // A pending file with no updated_at can't be aged, so it is kept.
  write(file, stateFile({ pending: true, updated_at: undefined }));
  assert.notEqual(lookupOne(SID, repo), null);
  fs.rmSync(file);
  const a = linkedWorktree(base, common, 'aaa');
  write(path.join(a.adminDir, ff.STATE_NAME), stateFile({ updated_at: ago(72 * HOUR) }));
  const p = lookupOne(SID, repo);
  assert.equal(p.quiet, true);
});

test('quiet after an hour without an update, but never while waiting for the user', (t) => {
  const base = tmpBase(t);
  const { repo, common } = mainRepo(base);
  const file = path.join(common, ff.PENDING_DIR, `${SID}.json`);
  write(file, stateFile({ pending: true, updated_at: ago(59 * MIN) }));
  assert.equal(lookupOne(SID, repo).quiet, false);
  write(file, stateFile({ pending: true, updated_at: ago(61 * MIN) }));
  assert.equal(lookupOne(SID, repo).quiet, true);
  // The same file flips at the hour as the clock moves — what drives the daemon's re-broadcast.
  write(file, stateFile({ pending: true, updated_at: ago(30 * MIN) }));
  assert.equal(lookupOne(SID, repo, NOW).quiet, false);
  assert.equal(lookupOne(SID, repo, NOW + 31 * MIN).quiet, true);
  write(file, stateFile({ pending: true, updated_at: ago(5 * HOUR), waiting_for_user: true, waiting_for: 'answer my questions' }));
  const p = lookupOne(SID, repo);
  assert.equal(p.quiet, false);
  assert.equal(p.waitingForUser, true);
  assert.equal(p.waitingFor, 'answer my questions');
});

// ---- projection -------------------------------------------------------------

test('projection: exactly the allowlisted fields, never a path, timestamps in epoch ms', () => {
  const raw = stateFile({ waiting_for_user: true, waiting_for: 'approve the spec', waiting_since: ago(MIN) });
  const p = ff.project(raw, NOW);
  assert.deepEqual(Object.keys(p).sort(), [
    'doing', 'quiet', 'startedAt', 'stepLabel', 'stepNumber', 'stepTotal', 'subStep',
    'title', 'updatedAt', 'waitingFor', 'waitingForUser',
  ]);
  const text = JSON.stringify(p);
  for (const leak of ['/Users/', 'progress', '.md', 'worktree-tower']) assert.ok(!text.includes(leak), leak);
  assert.equal(p.updatedAt, NOW - 5 * MIN);
  assert.equal(p.startedAt, NOW - 40 * MIN);
  assert.equal(p.stepNumber, 1);
  assert.equal(p.stepTotal, 10);
});

test('stepLabel strips the N/M counter; subStep is step_name only when it differs', () => {
  const cases = [
    [{ step: '1/10 Design', step_name: 'Research' }, 'Design', 'Research'],
    [{ step: '4/10 Building', step_name: 'Building' }, 'Building', null],
    [{ step: '9/10 Feedback round 2', step_name: 'Fixing' }, 'Feedback round 2', 'Fixing'],
    [{ step: '10/10 Ship', step_name: 'Push' }, 'Ship', 'Push'],
    [{ step: 'Design', step_name: 'Draft' }, 'Design', 'Draft'], // no counter in step
    [{ step: undefined, step_name: 'Draft' }, null, 'Draft'], // a field it can't find drops a line
    [{ step: '4/10 Building', step_name: undefined }, 'Building', null],
    [{ step: 42, step_name: ['x'] }, null, null],
    [{ step: '4/10', step_name: 'Building' }, null, 'Building'], // a bare counter is no label
    [{ step: '4/10 ', step_name: undefined }, null, null],
  ];
  for (const [over, label, sub] of cases) {
    const p = ff.project(stateFile(over), NOW);
    assert.equal(p.stepLabel, label, JSON.stringify(over));
    assert.equal(p.subStep, sub, JSON.stringify(over));
  }
});

test('counts and flags tolerate missing or odd values', () => {
  const p = ff.project(stateFile({ step_number: null, step_total: '10', waiting_for_user: 'yes', waiting_for: 'ignored' }), NOW);
  assert.equal(p.stepNumber, null);
  assert.equal(p.stepTotal, null);
  assert.equal(p.waitingForUser, false, 'only a real true is waiting');
  assert.equal(p.waitingFor, null, 'waitingFor is only carried while waiting');
});

test('strings are clamped to 160 characters, single-lined, and empty strings are null', () => {
  const long = 'z'.repeat(400);
  const p = ff.project(stateFile({ doing: long, title: '  two\n  lines\tof   text ', step_name: '   ' }), NOW);
  assert.equal(Array.from(p.doing).length, ff.MAX_STR);
  assert.ok(p.doing.endsWith('…'));
  assert.equal(p.title, 'two lines of text');
  assert.equal(p.subStep, null);
  // Code points, not UTF-16 units: an emoji at the cut is never split.
  const emoji = ff.clampText('😀'.repeat(200));
  assert.equal(Array.from(emoji).length, ff.MAX_STR);
  assert.ok(!/[\uD800-\uDBFF]…$/.test(emoji));
  assert.equal(ff.clampText('x'.repeat(160)), 'x'.repeat(160), 'exactly at the limit is untouched');
  assert.equal(ff.clampText(5), null);
});

test('lookupFlows never throws on junk input', () => {
  assert.equal(ff.lookupFlows(null, NOW).size, 0);
  assert.equal(ff.lookupFlows([null, {}, { sessionId: SID }, { sessionId: SID, repoRoot: 3 }], NOW).size, 0);
});
