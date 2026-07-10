// Cockpit statusline renderer + usage forwarder.
//
// Reads the Claude Code statusline JSON payload on stdin (see
// https://code.claude.com/docs/en/statusline "Available data") and prints ONE
// colored line:
//   [⏸ PAUSED] · cwd · ctx-bar · 5h-bar · reset · tokens · cost · branch · model
// The leading paused segment only appears when the pause-gate control file
// (scripts/pause.js) is set AND the feature is opted in (pauseGateEnabled).
//
// Then, best-effort and AFTER the line is printed, it POSTs ONLY the payload's
// `rate_limits` to the daemon's `/internal/usage`, which lights up the Live
// page's session-5h and weekly usage bars. Forwarding never delays the printed
// line (print first) and never crashes the bar (all errors swallowed).
//
// PRIVACY: only `rate_limits` is forwarded — never the cwd/cost/model/session_id
// the payload also carries. Nothing is stored locally by this script.
//
// Invoked directly as the statusLine command (`node <root>/statusline-render.js`);
// requires resolve against __dirname, so the working directory is irrelevant.
"use strict";
const fs = require("fs");
const path = require("path");
const http = require("http");

// paths.js locates the daemon's port/token files; repo.js reads the git branch from
// .git/HEAD (a cheap file read, NOT a `git` subprocess). Both are loaded defensively:
// if they can't be resolved (e.g. the renderer was copied out of the repo), the line
// still renders — only the best-effort POST (paths) and the branch segment (repo) drop.
let paths = null;
let repoLib = null;
let pauseLib = null;
try {
  paths = require("../scripts/paths.js");
} catch (_e) {
  paths = null;
}
try {
  repoLib = require("../scripts/repo.js");
} catch (_e) {
  repoLib = null;
}
try {
  pauseLib = require("../scripts/pause.js");
} catch (_e) {
  pauseLib = null;
}

// Best-effort forwarder budget; the printed line has already flushed by then.
const POST_TIMEOUT_MS = 150;
// Hard backstop so a stalled daemon socket can never keep this node process
// alive (one is spawned per render — even more often than a hook).
const EXIT_GUARD_MS = 400;

let exited = false;
function finish() {
  if (exited) return;
  exited = true;
  process.exit(0);
}

const C = {
  reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m",
  cyan: "\x1b[36m", blue: "\x1b[34m", magenta: "\x1b[35m",
  green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", gray: "\x1b[90m",
  white: "\x1b[97m", brightYellow: "\x1b[93m", pink: "\x1b[95m", brightBlue: "\x1b[94m",
};

// green < 50% < yellow < 80% <= red; gray when unknown.
function threshColor(pct) {
  if (pct == null) return C.gray;
  if (pct < 50) return C.green;
  if (pct < 80) return C.yellow;
  return C.red;
}

// A width-char progress bar; unknown percentage renders all-empty in gray.
function bar(pct, width) {
  width = width || 10;
  if (pct == null) return C.gray + "░".repeat(width) + C.reset;
  const p = Math.max(0, Math.min(100, pct));
  const filled = Math.round((p / 100) * width);
  return threshColor(p) + "█".repeat(filled) + C.gray + "░".repeat(width - filled) + C.reset;
}

function pctLabel(pct) {
  return threshColor(pct) + (pct == null ? "—" : Math.round(pct) + "%") + C.reset;
}

// Compact token count: 254214 -> "254k", 1000000 -> "1M".
function fmtTokens(n) {
  if (n == null || isNaN(n)) return null;
  if (n >= 1e6) return (n / 1e6).toFixed(2).replace(/\.?0+$/, "") + "M";
  if (n >= 1e3) return Math.round(n / 1e3) + "k";
  return String(n);
}

// Reset timestamp (Unix seconds) -> local HH:MM.
function clock(unixSec) {
  if (!unixSec) return null;
  const d = new Date(unixSec * 1000);
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}

// Branch isn't in the payload for normal sessions (only worktree.branch /
// workspace.git_worktree during worktree sessions). Fall back to reading .git/HEAD
// via repo.js — a cheap file read, NOT a `git` subprocess spawned on every render.
function branchOf(payload, dir) {
  const wt = payload.worktree && payload.worktree.branch;
  if (wt) return wt;
  const gw = payload.workspace && payload.workspace.git_worktree;
  if (gw) return gw;
  if (repoLib && dir) {
    try {
      const r = repoLib.resolveRepo(dir);
      if (r && r.branch) return r.branch;
    } catch (_e) {
      /* no branch */
    }
  }
  return null;
}

// Build the colored one-liner from the payload. Missing/undefined fields are
// shown as "—" or dropped rather than a wrong 0 — never throws.
function renderLine(data) {
  const seg = [];

  // Order: [paused] · cwd · ctx · usage(5h) · tokens · cost · branch · model.

  // paused = the pause-gate control file (scripts/pause.js), prepended ahead of
  // everything else. Shown only when the control file holds a paused sentinel
  // AND the feature is opted in — mirrors gateDecision's own fail-open rule so
  // a stray/leftover control file never shows PAUSED for a user who hasn't
  // opted in. pauseLib may be null (see the defensive require above); either
  // way a failure here must never break the rest of the line.
  if (pauseLib) {
    try {
      // Use the canonical gateDecision rule (control file + opt-in flag) so the
      // statusline's PAUSED indicator can never diverge from what the gate enforces.
      if (pauseLib.gateDecision(pauseLib.readPauseState(), pauseLib.pauseGateEnabled()) === "wait") {
        seg.push(C.bold + C.red + "⏸ PAUSED" + C.reset);
      }
    } catch (_e) {
      /* no paused segment */
    }
  }

  // cwd = the directory where Claude was STARTED — prefer workspace.project_dir (the original
  // project dir) over current_dir, then cwd; basename only. (They coincide unless the session
  // started in a subdir or a worktree.)
  const startDir =
    (data.workspace && (data.workspace.project_dir || data.workspace.current_dir)) || data.cwd || null;
  if (startDir) seg.push(C.brightYellow + path.basename(startDir) + C.reset);

  // ctx = context-window fill (shared `cw` also feeds the token count below).
  const cw = data.context_window;
  const ctxPct = cw && typeof cw.used_percentage === "number" ? cw.used_percentage : null;
  seg.push(C.white + "ctx" + C.reset + " " + bar(ctxPct) + " " + pctLabel(ctxPct));

  // usage = the 5h rate-limit window (bar + reset time).
  const fh = data.rate_limits && data.rate_limits.five_hour;
  const fhPct = fh && typeof fh.used_percentage === "number" ? fh.used_percentage : null;
  let fhSeg = C.white + "5h" + C.reset + " " + bar(fhPct) + " " + pctLabel(fhPct);
  const reset = fh ? clock(fh.resets_at) : null;
  if (reset) fhSeg += " " + C.white + "↻ " + reset + C.reset;
  seg.push(fhSeg);

  // Tokens currently in the context window (input + output) — the count behind the ctx% bar.
  // The payload carries no cumulative-session token total.
  const tok = cw ? fmtTokens((cw.total_input_tokens || 0) + (cw.total_output_tokens || 0)) : null;
  if (tok) seg.push(C.pink + tok + C.dim + " tok" + C.reset);

  const cost = data.cost && typeof data.cost.total_cost_usd === "number" ? data.cost.total_cost_usd : null;
  if (cost != null) seg.push(C.green + "$" + cost.toFixed(3) + C.reset);

  const branch = branchOf(data, startDir);
  if (branch) seg.push(C.brightBlue + "⎇ " + branch + C.reset);

  const model = (data.model && (data.model.display_name || data.model.id)) || null;
  if (model) seg.push(C.bold + C.cyan + model + C.reset);

  return seg.join(C.dim + " · " + C.reset);
}

// Best-effort push of ONLY `rate_limits` to the daemon (see emit.js's ping for
// the same port/token/timeout/exit discipline). Fired after the line is printed;
// swallows every error and always calls done() so the process exits promptly.
function postUsage(data, done) {
  let called = false;
  const complete = () => {
    if (called) return;
    called = true;
    done();
  };
  try {
    const rateLimits = data && data.rate_limits;
    // Nothing to forward (API-key sessions never carry rate_limits) — skip the
    // request entirely rather than POST an empty body the daemon would drop.
    if (!paths || !rateLimits || typeof rateLimits !== "object") return complete();
    const port = parseInt(fs.readFileSync(paths.portPath(), "utf8").trim(), 10);
    if (!port) return complete();
    let token = "";
    try {
      token = fs.readFileSync(paths.tokenPath(), "utf8").trim();
    } catch (_e) {
      token = "";
    }
    const body = JSON.stringify({ rate_limits: rateLimits }); // strip everything else
    const headers = {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
    };
    if (token) headers.authorization = `Bearer ${token}`;
    const req = http.request(
      { host: "127.0.0.1", port, path: "/internal/usage", method: "POST", timeout: POST_TIMEOUT_MS, headers },
      (res) => {
        res.resume(); // drain so the socket can close
        res.on("end", complete);
        res.on("error", complete);
      }
    );
    req.on("timeout", () => {
      req.destroy();
      complete();
    });
    req.on("error", complete);
    req.write(body);
    req.end();
  } catch (_e) {
    complete();
  }
}

function main() {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
  } catch (_e) {
    return finish(); // unparseable payload -> print nothing rather than crash the bar
  }

  let line = "";
  try {
    line = renderLine(data);
  } catch (_e) {
    line = ""; // rendering failed — the line is best-effort too; still forward usage below.
  }

  // Backstop: exit even if the write callback / POST timeout never fire.
  setTimeout(finish, EXIT_GUARD_MS);
  // Print FIRST, and forward only AFTER stdout has flushed — otherwise a synchronous exit in
  // the no-rate_limits path (complete() -> finish() -> process.exit) could truncate a piped write.
  process.stdout.write(line, () => postUsage(data, finish));
}

try {
  main();
} catch (_e) {
  finish(); // the status line must always exit cleanly
}
