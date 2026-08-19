'use strict';

// The Claude Code ACCOUNT (subscription) the machine is signed in to, read from
// `~/.claude.json`'s `oauthAccount` — the only local carrier of it (neither the hook
// payload nor the transcript has it).
//
// Two readers, deliberately:
//   - emit.js, once per SessionStart, capturing the account onto the durable event so a
//     replay reconstructs which account a session ran under.
//   - daemon.js, behind an mtime cache, as the LIVE account: `oauthAccount` is a single
//     global, so a mid-day account switch moves every running session at once and a
//     session's captured label goes stale while it keeps running. Anything that must
//     describe "the account right now" (the usage bars, the auto-pilot, a just-closed
//     turn's attribution) reads this instead of a captured label.
//
// Every failure path returns null — the capture is best-effort and must never throw into
// a hook or the daemon.
//
// PRIVACY: the returned object is ACCOUNT / SUBSCRIPTION METADATA (org or account name +
// rate-limit tier codes). It is explicitly permitted, and is NOT message content.

const fs = require('fs');
const os = require('os');
const path = require('path');

// Never slurp a pathologically huge config file (best-effort guard; the file is a ~200KB
// global state blob in practice, and both callers are off the per-tool hot path anyway).
const MAX_CONFIG_BYTES = 50 * 1024 * 1024;

// Claude Code's global config file, honoring CLAUDE_CONFIG_DIR (else ~/.claude.json).
function claudeConfigPath() {
  const dir = process.env.CLAUDE_CONFIG_DIR;
  return dir ? path.join(dir, '.claude.json') : path.join(os.homedir(), '.claude.json');
}

// Assign only defined, non-null values so absent config fields are omitted.
function setIf(obj, key, val) {
  if (val !== undefined && val !== null) obj[key] = val;
}

// The compact `sub` object the daemon keys/labels on (see aggregate.subBaseName /
// usage.subLabel), or null on ANY failure (missing / unreadable / oversized / garbage
// file, or no oauthAccount).
//
// `orgType` is normalized into the pure core's vocabulary (aggregate.TEAM_ORG_TYPES
// expects bare "team"/"enterprise"/…): Claude Code reports e.g. "claude_team", so we
// lowercase and strip a leading "claude_". Without this a team org would fall through to
// personal labeling. A value that still doesn't match (personal plans) correctly reads as
// personal.
function readSubscription() {
  try {
    const file = claudeConfigPath();
    if (fs.statSync(file).size > MAX_CONFIG_BYTES) return null;
    const acct = JSON.parse(fs.readFileSync(file, 'utf8')).oauthAccount;
    if (!acct || typeof acct !== 'object') return null;
    const sub = {};
    setIf(sub, 'id', acct.organizationUuid);
    if (typeof acct.organizationType === 'string' && acct.organizationType) {
      sub.orgType = acct.organizationType.toLowerCase().replace(/^claude_/, '');
    }
    setIf(sub, 'orgName', acct.organizationName);
    setIf(sub, 'displayName', acct.displayName);
    setIf(sub, 'email', acct.emailAddress);
    setIf(sub, 'seatTier', acct.seatTier);
    setIf(sub, 'userTier', acct.userRateLimitTier);
    setIf(sub, 'orgTier', acct.organizationRateLimitTier);
    return Object.keys(sub).length ? sub : null;
  } catch (_e) {
    return null;
  }
}

module.exports = { claudeConfigPath, readSubscription, MAX_CONFIG_BYTES };
