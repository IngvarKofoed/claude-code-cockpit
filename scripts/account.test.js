'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// account.js resolves the config path per call from CLAUDE_CONFIG_DIR, so each test can point
// it at a temp dir. It is required once here; nothing in it is cached across calls.
const account = require('./account');

function withConfigDir(contents, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-account-'));
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = dir;
  try {
    if (contents != null) fs.writeFileSync(path.join(dir, '.claude.json'), contents);
    return fn(dir);
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('claudeConfigPath: honors CLAUDE_CONFIG_DIR, else ~/.claude.json', () => {
  withConfigDir(null, (dir) => {
    assert.strictEqual(account.claudeConfigPath(), path.join(dir, '.claude.json'));
  });
  const prev = process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CLAUDE_CONFIG_DIR;
  try {
    assert.strictEqual(account.claudeConfigPath(), path.join(os.homedir(), '.claude.json'));
  } finally {
    if (prev !== undefined) process.env.CLAUDE_CONFIG_DIR = prev;
  }
});

test('readSubscription: maps oauthAccount to the compact sub object', () => {
  const cfg = JSON.stringify({
    oauthAccount: {
      organizationUuid: 'org-1',
      organizationType: 'claude_team',
      organizationName: 'FOSS Analytical (Lyra)',
      displayName: 'Ada',
      emailAddress: 'ada@example.com',
      seatTier: 'max',
      userRateLimitTier: 'u1',
      organizationRateLimitTier: 'o1',
    },
    other: 'ignored',
  });
  withConfigDir(cfg, () => {
    assert.deepStrictEqual(account.readSubscription(), {
      id: 'org-1',
      orgType: 'team', // the "claude_" prefix is stripped so aggregate.TEAM_ORG_TYPES matches
      orgName: 'FOSS Analytical (Lyra)',
      displayName: 'Ada',
      email: 'ada@example.com',
      seatTier: 'max',
      userTier: 'u1',
      orgTier: 'o1',
    });
  });
});

test('readSubscription: omits absent fields rather than writing nulls', () => {
  withConfigDir(JSON.stringify({ oauthAccount: { organizationUuid: 'org-2' } }), () => {
    assert.deepStrictEqual(account.readSubscription(), { id: 'org-2' });
  });
});

test('readSubscription: returns null on every failure path — it must never throw', () => {
  // Missing file.
  withConfigDir(null, () => assert.strictEqual(account.readSubscription(), null));
  // Unparseable JSON.
  withConfigDir('{ not json', () => assert.strictEqual(account.readSubscription(), null));
  // Parseable but no oauthAccount.
  withConfigDir(JSON.stringify({ projects: {} }), () => assert.strictEqual(account.readSubscription(), null));
  // oauthAccount present but carrying none of the fields we read.
  withConfigDir(JSON.stringify({ oauthAccount: { unrelated: 1 } }), () =>
    assert.strictEqual(account.readSubscription(), null)
  );
  // oauthAccount of the wrong shape.
  withConfigDir(JSON.stringify({ oauthAccount: 'nope' }), () => assert.strictEqual(account.readSubscription(), null));
});
