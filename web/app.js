// app.js — the cockpit dashboard SPA (buildless ES module, served by the daemon).
// Loads /api/state, subscribes to /api/stream (SSE), renders the four views, and
// edits config via PUT /api/config. All fetches carry the bearer token; the SSE
// URL carries it as ?token= (EventSource can't set headers).

import { barChart, lineChart, stacked, punch, calendar } from "./charts.js";

// ---- app state -------------------------------------------------------------

const App = {
  token: window.__COCKPIT_TOKEN__ || "",
  state: null, // last /api/state snapshot { now, sessions, repos, config, daemon }
  cfg: null, // current config (from state.config / config SSE / PUT response)
  clockOffset: 0, // serverNow - clientNow, for drift-corrected timers
  view: "live",
  repoRange: "all",
  histRange: "7d",
  histData: null, // last /api/history payload — the pivot re-slices this with no refetch
  histBuilt: false, // History view scaffolding (family cards + pivot toolbar) built once
  liveSort: "status", // "status" (server waiting-first) | "name" (alpha); set from localStorage in init
  repoRows: [], // normalized rows currently shown in the per-repo table
  repoSort: { key: "activeMs", dir: -1 }, // dir: 1 asc, -1 desc
  sessionsPage: 0, // current 0-based page of the Sessions view
  sessionsPageSize: 50, // page size sent to GET /api/sessions (server clamps to [1,100])
  sessionsTotal: 0, // total session count reported by the last /api/sessions fetch
  sessionsRows: [], // rows from the last /api/sessions fetch (re-rendered with a fresh live overlay)
  storage: null, // last GET /api/storage snapshot (Settings > Data), for the cleanup preview
  prevStatus: {}, // sessionId -> last status, for sound-cue transition detection
  soundsPrimed: false, // suppress cues on first snapshot / after a reconnect gap
  flash: {}, // sessionId -> { until: epoch ms window ends, cls: variant class } for the status-change pulse
  longFired: {}, // sessionId -> promptStartMs already alerted for longRunning
  timers: [], // [{ el, start, kind }] updated once per second
  usageRender: null, // { updatedAt, bars:[{kind, win, windowMs, state, els}] } — live-ticked usage bars
  settingsRendered: false,
  es: null,
  failures: 0,
  reconnectTimer: null,
};

const LOST_AFTER = 4; // consecutive SSE failures before showing the lost banner
const FLASH_MS = 800; // window for a single short pulse (~0.7s cardPulse + margin)
const FLASH_LONG_MS = 3700; // window for the important transitions (5 pulses ≈ 3.5s + margin)
const REPO_REFRESH_MS = 2000; // throttle for live-refreshing a historical per-repo range on SSE frames

// ---- tiny helpers ----------------------------------------------------------

const $ = (id) => document.getElementById(id);

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

function num(v) {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function sumTokens(t) {
  if (t == null) return 0;
  if (typeof t === "number") return num(t);
  return num(t.input) + num(t.output) + num(t.cacheRead) + num(t.cacheWrite);
}

function basename(p) {
  if (!p) return "";
  const parts = String(p).split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : String(p);
}

function estNow() {
  return Date.now() + App.clockOffset;
}

function costEnabled() {
  return !!(App.cfg && App.cfg.cost && App.cfg.cost.enabled);
}

// ---- formatting ------------------------------------------------------------

function fmtDuration(ms) {
  ms = num(ms);
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m) return `${m}m ${String(sec).padStart(2, "0")}s`;
  return `${sec}s`;
}

function fmtAge(ms) {
  ms = num(ms);
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d) return d + "d";
  if (h) return h + "h";
  if (m) return m + "m";
  return s + "s";
}

function fmtTokens(n) {
  n = num(n);
  if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return String(Math.round(n));
}

// Human-readable file size (binary units). Used by the Data section + delete toasts.
function fmtBytes(n) {
  n = num(n);
  if (n < 1024) return Math.round(n) + " B";
  const units = ["KB", "MB", "GB", "TB"];
  let i = -1;
  do {
    n /= 1024;
    i++;
  } while (n >= 1024 && i < units.length - 1);
  return (n >= 100 ? n.toFixed(0) : n.toFixed(1)) + " " + units[i];
}

// Local YYYY-MM-DD for a Date (matches the daemon's per-day file naming, which is local).
function ymd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Whole days from date string a to date string b (b - a); negative if b precedes a.
function daysBetween(a, b) {
  const ta = Date.parse(a + "T00:00:00");
  const tb = Date.parse(b + "T00:00:00");
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return 0;
  return Math.round((tb - ta) / 86400000);
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

const CURRENCY_SYM = { USD: "$", EUR: "€", GBP: "£", JPY: "¥", CAD: "$", AUD: "$" };
// Currencies with no minor unit — render whole numbers, no fractional digits.
const ZERO_DECIMAL_CUR = new Set(["JPY", "KRW", "VND", "CLP", "ISK", "HUF"]);

function fmtCost(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  const cur = (App.cfg && App.cfg.cost && App.cfg.cost.currency) || "USD";
  const sym = CURRENCY_SYM[cur];
  const s = ZERO_DECIMAL_CUR.has(cur) ? String(Math.round(n)) : n >= 1 ? n.toFixed(2) : n.toFixed(3);
  return sym ? sym + s : s + " " + cur;
}

function relTime(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const d = estNow() - t;
  if (d < 0) return "just now";
  const m = Math.floor(d / 60000);
  const h = Math.floor(m / 60);
  const day = Math.floor(h / 24);
  if (day > 0) return day + "d ago";
  if (h > 0) return h + "h ago";
  if (m > 0) return m + "m ago";
  return "just now";
}

function dayShort(date) {
  return typeof date === "string" ? date.slice(5) : "";
}

function shortModel(m) {
  return String(m || "").replace(/^claude-/, "");
}

// Tooltip for the card's model chip. With more than one model seen this session
// (a mid-session /model switch), list them in first-seen order with the current
// one marked; capped at 5 shown + "+N more". A single model → just its name.
function modelsTooltip(s) {
  const used = Array.isArray(s.modelsUsed) ? s.modelsUsed : [];
  if (used.length <= 1) return shortModel(s.model);
  const CAP = 5;
  let shown = used.slice(0, CAP);
  // Always surface the current model, even if it sorts beyond the cap — the tooltip's
  // whole purpose is to reveal the current one, so it must never be the omitted item.
  if (s.model && used.includes(s.model) && !shown.includes(s.model)) {
    shown = shown.slice(0, CAP - 1).concat(s.model);
  }
  const more = used.length - shown.length;
  const label = shown.map((m) => shortModel(m) + (m === s.model ? " (current)" : ""));
  return "Models this session: " + label.join(", ") + (more > 0 ? " +" + more + " more" : "");
}

// Tooltip for the card's Subagents cell: per-type breakdown plus the active count.
function subagentsTitle(sa) {
  const parts = [];
  const bt = sa && sa.byType && typeof sa.byType === "object" ? sa.byType : {};
  for (const k of Object.keys(bt)) parts.push(k + " ×" + num(bt[k]));
  const active = num(sa && sa.active);
  if (active > 0) parts.push(active + " active");
  return parts.length ? parts.join(" · ") : "Agents spawned this session";
}

// ---- HTTP ------------------------------------------------------------------

async function api(path, opts) {
  const o = opts || {};
  const headers = Object.assign({ Authorization: "Bearer " + App.token }, o.headers || {});
  const res = await fetch(path, Object.assign({}, o, { headers }));
  const ct = res.headers.get("content-type") || "";
  const data = ct.includes("json") ? await res.json().catch(() => null) : null;
  if (!res.ok) {
    const err = new Error("HTTP " + res.status);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

async function refreshState() {
  applyState(await api("/api/state"));
}

// ---- Web Audio cues --------------------------------------------------------

let audioCtx;
function ensureAudio() {
  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) audioCtx = new AC();
  }
  if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
  return audioCtx;
}

// Play a short sequence of sine tones (freqs stepped in time).
function tone(freqs, dur) {
  const ctx = ensureAudio();
  if (!ctx) return;
  const now = ctx.currentTime;
  freqs.forEach((f, i) => {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = "sine";
    o.frequency.value = f;
    const start = now + i * 0.09;
    g.gain.setValueAtTime(0, start);
    g.gain.linearRampToValueAtTime(0.16, start + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    o.connect(g).connect(ctx.destination);
    o.start(start);
    o.stop(start + dur + 0.05);
  });
}

const CUES = {
  sessionFinished: () => tone([660, 880], 0.25), // pleasant rise
  needsInput: () => tone([880, 660], 0.22), // attention
  turnFailed: () => tone([300, 200], 0.4), // low error
  longRunning: () => tone([520], 0.32),
};

function evOn(name) {
  return !!(App.cfg && App.cfg.events && App.cfg.events[name]);
}

// Compare each session's new status against the last snapshot and play a cue on
// notification-worthy transitions (only when browserSounds + that event is on).
function detectSoundCues(sessions) {
  const next = {};
  const soundsOn = App.soundsPrimed && App.cfg && App.cfg.browserSounds;
  const now = Date.now();
  // Single pass over the transition (prev status -> current) for BOTH the pulse and
  // the sound cue. On a change we open a flash window (App.flash[sid] = {until, cls}),
  // so the card keeps its pulse class across the frequent SSE re-renders that rebuild
  // the card grid. The two most important transitions get a longer window + a distinct
  // variant: running→idle ("done", accent blue) and running→waiting ("needs you",
  // amber) both pulse for FLASH_LONG_MS; every other change is one short pulse in the
  // new status's colour. Gated on soundsPrimed (NOT browserSounds) so the pulse is
  // visual regardless of the sound setting, while the first primed snapshot and
  // post-reconnect resyncs don't flash the whole grid. A brand-new session (no prior
  // status) counts as a transition.
  for (const s of sessions) {
    // Transitions key off effectiveStatus, not raw status: a background workflow holds it at
    // "running" across the launching Stop and the idle gaps between subagent bursts, so the
    // "done" pulse + sessionFinished cue fire only on the real engaged→idle transition (when
    // background_tasks empties), never the premature handoff Stop.
    const eff = effectiveStatus(s);
    next[s.sessionId] = eff;
    const prev = App.prevStatus[s.sessionId];
    if (eff === prev || !App.soundsPrimed) continue;
    let cls, dur;
    if (prev === "running" && eff === "idle") { cls = "card--flash-done"; dur = FLASH_LONG_MS; }
    else if (prev === "running" && eff === "waiting") { cls = "card--flash-waiting"; dur = FLASH_LONG_MS; }
    else { cls = "card--flash-" + eff; dur = FLASH_MS; }
    App.flash[s.sessionId] = { until: now + dur, cls };
    if (soundsOn) {
      if (eff === "waiting" && evOn("needsInput")) CUES.needsInput();
      else if (eff === "error" && evOn("turnFailed")) CUES.turnFailed();
      else if (eff === "idle" && prev === "running" && evOn("sessionFinished")) CUES.sessionFinished();
    }
  }
  // Drop expired / departed sessions so the map can't grow unbounded.
  for (const sid of Object.keys(App.flash)) {
    if (App.flash[sid].until <= now || !(sid in next)) delete App.flash[sid];
  }
  App.prevStatus = next;
  App.soundsPrimed = true;
}

function checkLongRunning(now) {
  if (!App.cfg || !App.cfg.browserSounds || !evOn("longRunning")) return;
  // While globally paused, a mid-prompt session's timer is frozen and it is deliberately
  // frozen by the gate — don't fire a "long-running" chime for a session the user paused
  // (its raw status is still "running" and currentPromptStartedAt keeps aging).
  if (App.state && App.state.paused && App.state.paused.active) return;
  const th = num(App.cfg.longRunningThresholdMs);
  if (!(th > 0)) return;
  const sessions = (App.state && App.state.sessions) || [];
  for (const s of sessions) {
    if (s.status !== "running" || !s.currentPromptStartedAt) continue;
    const start = Date.parse(s.currentPromptStartedAt);
    if (!Number.isFinite(start)) continue;
    if (now - start >= th && App.longFired[s.sessionId] !== start) {
      App.longFired[s.sessionId] = start;
      CUES.longRunning();
    }
  }
}

// ---- live timers -----------------------------------------------------------

// Rebuild the ticking-timer registry from the [data-timer] elements in the ACTIVE view
// only. Both the Live cards and the Sessions rows carry live timers; scoping to the
// visible view means a hidden view's stale timers aren't re-painted every second (the
// Live cards are rebuilt every frame even while hidden, so a document-wide scan would tick
// invisible elements forever). Both renderLive and renderSessions call this after
// replacing their markup.
function collectTimers() {
  App.timers = [];
  const active = document.querySelector(".view.is-active");
  if (!active) return;
  active.querySelectorAll("[data-timer]").forEach((el) => {
    const start = Number(el.dataset.start);
    if (!Number.isFinite(start) || start <= 0) return;
    App.timers.push({ el, start, kind: el.dataset.timer });
  });
}

function tick() {
  const now = estNow();
  for (const t of App.timers) {
    const ms = now - t.start;
    t.el.textContent = t.kind === "age" ? fmtAge(ms) : fmtDuration(ms);
  }
  tickUsage(now); // advance the usage bars' reset countdown + pace cue on the same loop
  tickPauseBanner(now); // advance the paused-duration banner on the same loop
  checkLongRunning(now);
}

// ---- Live view -------------------------------------------------------------

const BRANCH_SVG =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4">' +
  '<circle cx="4" cy="3.5" r="1.6"/><circle cx="4" cy="12.5" r="1.6"/><circle cx="12" cy="3.5" r="1.6"/>' +
  '<path d="M4 5v6M12 5v1.5a3 3 0 0 1-3 3H4"/></svg>';
const COPY_SVG =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3">' +
  '<rect x="5" y="5" width="8" height="9" rx="1.5"/><path d="M3 11V3a1 1 0 0 1 1-1h6"/></svg>';

const STATUS_LABEL = {
  running: "Running",
  waiting: "Waiting",
  idle: "Idle",
  error: "Error",
  ended: "Ended",
  paused: "Paused",
};

// The card's effective status — the RELIABLE work signal, and deliberately pause-UNAWARE.
// A session with background work still in flight (bgTasks — Claude Code's authoritative
// background_tasks count) reads as "running": it IS working after its turn's Stop, so the
// badge, colour, big timer and pulse should all say so. A permission prompt or error takes
// precedence (they need attention / are terminal). Derived from the reliable count, never the
// ±unreliable subagent counter — so the timer can't disagree with the colour, and the "done"
// pulse fires only on the real engaged→idle transition. This is what sound cues, long-running,
// and sort key off; the GLOBAL pause is a DISPLAY-only overlay applied separately (displayStatus)
// so pausing/resuming can't manufacture phantom status transitions here.
function effectiveStatus(s) {
  const raw = s.status || "idle";
  if (raw === "waiting" || raw === "error") return raw;
  return raw === "running" || num(s.bgTasks) > 0 ? "running" : "idle";
}

// Rendering-only status: overlays the GLOBAL pause (docs/specs/2026-07-09-pause-gate.md —
// App.state.paused.active) on top of effectiveStatus. A pause only freezes a running/idle
// session once it has actually come to rest at the gate (s.atRest, from the server — see
// docs/specs/2026-07-11-pause-safe-to-close.md); a session still finishing a tool call that
// passed the gate before the pause was clicked keeps its real "running" badge and ticking
// timer (activityText adds a "pausing…" hint) instead of a misleading instant "Paused". A
// session WAITING on a permission prompt or one that ended on an ERROR keeps that status —
// those need attention / are terminal and must not be masked by the global freeze (the PAUSED
// banner already conveys the cockpit-wide state). Used ONLY for the card/row display; cues,
// long-running, and sort use effectiveStatus so the overlay never creates a phantom transition.
function displayStatus(s) {
  const eff = effectiveStatus(s);
  if ((eff === "running" || eff === "idle") && App.state && App.state.paused && App.state.paused.active && s.atRest) {
    return "paused";
  }
  return eff;
}

function activityText(s) {
  const status = displayStatus(s);
  switch (status) {
    case "running": {
      const base = s.currentActivity ? "Running " + s.currentActivity : "Working…";
      // Still finishing a tool that passed the gate before the pause was clicked — not yet
      // parked (s.atRest false). A subtle hint distinguishes "pausing" from ordinary running.
      const pausing = App.state && App.state.paused && App.state.paused.active && !s.atRest;
      return pausing ? base + " · pausing…" : base;
    }
    case "waiting":
      return "Waiting for your input";
    case "error":
      return "Turn failed" + (s.errorReason ? " · " + s.errorReason : "");
    case "ended":
      return "Session ended";
    case "paused":
      return "Paused — parked";
    default:
      return s.currentActivity || "Idle";
  }
}

function chip(text, mono) {
  return `<span class="chip ${mono ? "chip--mono" : ""}">${esc(text)}</span>`;
}

function cardHTML(s) {
  const status = displayStatus(s); // display overlay: a global pause shows "Paused" + freezes the timer
  const waiting = status === "waiting";
  const promptStart = s.currentPromptStartedAt;
  const promptStartMs = promptStart ? Date.parse(promptStart) : 0;
  // The big timer TICKS live only while `running`: from the open prompt's start (label
  // "elapsed") or — so it keeps counting while a background workflow runs after the launching
  // turn's Stop — from when the session became engaged (engagedStartedAt, label "working").
  // Ticking is gated on the RELIABLE status (the signal that drives the card colour), NOT
  // subagents.active, whose dropped SubagentStops once left an idle card ticking a phantom
  // timer. While `waiting` on a permission prompt the timer is FROZEN (label "paused"), not
  // ticking, so you don't watch it climb while YOU are the holdup: it shows how long the prompt
  // ran before it blocked (promptStart .. waitingSince, a stable server anchor a benign mid-wait
  // event can't move). The Active stat is the true wait-excluding metric; on approval the ticking
  // "elapsed" resumes from real prompt wall-clock. Idle/error: no timer.
  const running = status === "running";
  const engagedMs = running && s.engagedStartedAt ? Date.parse(s.engagedStartedAt) : 0;
  const tickMs = running ? promptStartMs || engagedMs : 0; // anchor for the live ticking timer
  // Frozen prompt-elapsed while waiting, from the stable waitingSince anchor. Clamp a negative
  // delta (an out-of-order/resumed ts where waitingSince precedes promptStart) to 0 rather than
  // rendering a misleading value; a missing anchor just means no frozen figure.
  const waitStartMs = waiting ? Date.parse(s.waitingSince) : NaN;
  const hasFrozen = waiting && promptStartMs > 0 && Number.isFinite(waitStartMs);
  const waitFrozenMs = hasFrozen ? Math.max(0, waitStartMs - promptStartMs) : 0;
  // A running card always gets a label even with no anchor yet (tickMs 0 — e.g. a snapshot-
  // restored session engaged via bgTasks before engagedStartedAt is stamped), so it reads
  // "— working" rather than a bare, broken-looking "—".
  const timerLabel = tickMs ? (promptStartMs ? "elapsed" : "working") : running ? "working" : hasFrozen ? "paused" : "";
  const tokensTotal = s.tokens == null ? null : sumTokens(s.tokens);

  const chips = [];
  // Live in-flight indicator: how many background tasks (workflow subagents / background
  // shells) are running RIGHT NOW, from Claude Code's authoritative background_tasks count
  // (bgTasks) — NOT subagents.active, whose dropped-SubagentStop drift would over-report.
  // Restores the old subagent pill (dropped when the cumulative Agents stat landed) so a
  // running workflow is visible at a glance next to the model/effort chips. Shown only on a
  // RUNNING card: on a waiting/error card the amber/red state + frozen timer already own the
  // story and a pulsing green pill there would falsely read as "work progressing". Labelled
  // "in flight" (not "subagents") because bgTasks also counts run_in_background shells — the
  // tooltip spells out the scope. The green pulsing dot marks it live, distinct from the muted
  // cumulative "Agents" stat below. Placed first so it leads the row when a workflow kicks off.
  const inFlight = num(s.bgTasks);
  if (running && inFlight > 0)
    chips.push(
      `<span class="chip chip--live" title="${inFlight} background task${inFlight === 1 ? "" : "s"} in flight — workflow subagents / background shells">${inFlight} in flight</span>`
    );
  if (s.permissionMode) chips.push(chip(s.permissionMode));
  if (s.effortLevel) chips.push(chip("effort: " + s.effortLevel));
  // The model chip shows the current model; its tooltip reveals every model this
  // session has used (marking the current one) when a /model switch has occurred.
  if (s.model)
    chips.push(`<span class="chip chip--mono" title="${esc(modelsTooltip(s))}">${esc(shortModel(s.model))}</span>`);

  const sa = s.subagents || {};
  // Column order: Tokens | Cost | Chats | Tools | Agents | Active. Cost drops out when
  // disabled, shifting the rest left one column; the repo-total row below mirrors the
  // same order so the two rows stay aligned straight down.
  const stats = [
    `<div class="stat"><span class="stat__k">Tokens</span><span class="stat__v">${tokensTotal == null ? "—" : esc(fmtTokens(tokensTotal))}</span></div>`,
  ];
  if (costEnabled())
    stats.push(`<div class="stat"><span class="stat__k">Cost</span><span class="stat__v">${esc(fmtCost(s.cost))}</span></div>`);
  stats.push(`<div class="stat"><span class="stat__k">Chats</span><span class="stat__v">${num(s.promptCount)}</span></div>`);
  // Tools (all tool invocations this session, incl. those inside subagents) and Agents
  // (subagents spawned; tooltip breaks down by type + active count).
  stats.push(`<div class="stat"><span class="stat__k">Tools</span><span class="stat__v">${num(s.toolCount)}</span></div>`);
  stats.push(`<div class="stat" title="${esc(subagentsTitle(sa))}"><span class="stat__k">Agents</span><span class="stat__v">${num(sa.total)}</span></div>`);
  // Active = this session's cumulative working time (sum of closed turns). Uses
  // fmtDuration to match the Per-repo table and History, which render the same metric.
  stats.push(`<div class="stat"><span class="stat__k">Active</span><span class="stat__v">${esc(fmtDuration(num(s.activeMs)))}</span></div>`);

  // Repo-wide cumulative total (all sessions, all time), rendered as a second row
  // that shares the stat grid's columns — prompts/tokens/cost each land under the
  // matching per-session value so the two rows compare straight down. It carries no
  // text label: the muted colour + the dashed divider mark it as the repo total; the
  // tooltip explains it. Cells auto-flow in the same column order as the stats row.
  const rt = App.state && App.state.repoTotals && s.repoRoot ? App.state.repoTotals[s.repoRoot] : null;
  const repoTok = rt && rt.tokens != null ? sumTokens(rt.tokens) : null;
  const atTitle = "This repo's cumulative total across every session on record (all time), including backfilled sessions. Chats, active time, agents and tools come from live sessions only — backfilled history contributes tokens/cost but not those.";
  const rtCells = [
    `<span class="card__at-v" title="${atTitle}">${repoTok == null ? "—" : esc(fmtTokens(repoTok))}</span>`,
  ];
  if (costEnabled()) rtCells.push(`<span class="card__at-v" title="${atTitle}">${esc(fmtCost(rt ? rt.cost : null))}</span>`);
  // Chats, then Tools, then Agents, then Active — pushed in this order (after the optional
  // cost) so the repo-total cells land under the matching stats-row columns in both layouts.
  rtCells.push(`<span class="card__at-v" title="${atTitle}">${rt && rt.prompts != null ? num(rt.prompts) : "—"}</span>`);
  rtCells.push(`<span class="card__at-v" title="${atTitle}">${rt && rt.tools != null ? num(rt.tools) : "—"}</span>`);
  rtCells.push(`<span class="card__at-v" title="${atTitle}">${rt && rt.subagents != null ? num(rt.subagents) : "—"}</span>`);
  rtCells.push(`<span class="card__at-v" title="${atTitle}">${rt && rt.activeMs != null ? esc(fmtDuration(num(rt.activeMs))) : "—"}</span>`);

  // Pulse while this session's status-change window is open (see detectSoundCues).
  // The window (a timestamp) keeps the class across the frequent card-grid re-renders;
  // detectSoundCues chose the variant class per transition (a distinct/longer pulse for
  // the important running→idle and running→waiting changes). Once the window lapses the
  // class is gone, so a later re-render can't replay it.
  const f = App.flash[s.sessionId];
  const flash = f && f.until > Date.now() ? " card--flash " + f.cls : "";

  return `
  <article class="card ${waiting ? "card--waiting" : ""}${flash}" data-status="${esc(status)}">
    <div class="card__rail"></div>
    <div class="card__body">
      <div class="card__head">
        <span class="card__repo" title="${esc(s.repoName || "")}">${esc(s.repoName || "(unknown)")}</span>
        <span class="badge">${esc(STATUS_LABEL[status] || status)}</span>
      </div>
      <div class="card__where">
        ${s.branch ? `<span class="branch">${BRANCH_SVG}<span>${esc(s.branch)}</span></span>` : ""}
        ${s.cwd ? `<button class="path" type="button" data-path="${esc(s.cwd)}" title="Copy path">${COPY_SVG}<span>${esc(s.cwd)}</span></button>` : ""}
      </div>
      <div class="card__activity"><span class="spark"></span><span>${esc(activityText(s))}</span></div>
      <div class="telemetry">
        <span class="telemetry__value" ${tickMs ? `data-timer="dur" data-start="${tickMs}"` : ""}>${tickMs ? "0s" : hasFrozen ? esc(fmtDuration(waitFrozenMs)) : "—"}</span>
        <span class="telemetry__label">${timerLabel}</span>
      </div>
      ${chips.length ? `<div class="chips">${chips.join("")}</div>` : ""}
      <div class="card__stats" style="grid-template-columns: repeat(${stats.length}, minmax(0, 1fr))">
        ${stats.join("")}
        <div class="card__stats-div"></div>
        ${rtCells.join("")}
      </div>
    </div>
  </article>`;
}

function tile(label, value, alert) {
  return `<div class="tile ${alert ? "tile--alert" : ""}"><div class="tile__label">${esc(label)}</div><div class="tile__value">${esc(String(value))}</div></div>`;
}

// ---- Global pause (pause gate) ----------------------------------------------
// A daemon-wide freeze (docs/specs/2026-07-09-pause-gate.md) blocks every session's next
// tool call until the control file flips back. There is no per-session paused state —
// App.state.paused is ONE global record the daemon folds from the event log and pushes on
// /api/state + SSE. Drives three things: effectiveStatus() above (every card/row reads
// "paused"), a dedicated global banner shown on every view (kept separate from the
// connection-lost #banner — the two can be true independently and would otherwise fight over
// one element's text), and a Pause/Resume button near the Live ribbon.

// The CURRENT pause span's elapsed time (now − since) — what "⏸ Paused · Xm" means: how long
// THIS freeze has been on, ticking up from 0 and resetting on each new pause. Deliberately does
// NOT add p.pausedMs: that is the daemon's cumulative total of ALL prior closed spans (across
// restarts and days), so folding it in made a fresh 1-minute pause read as many minutes. Total-
// paused accounting is a separate concern, not this live banner's number.
function pauseDurationMs(p, now) {
  const since = Date.parse(p.since);
  return Number.isFinite(since) ? Math.max(0, now - since) : 0;
}

// The "safe to close" note: once every live session has parked, a green "all at rest" line;
// otherwise, while there are live sessions, an "N of M at rest" progress line; with no live
// sessions (M === 0), no count at all — an empty M/M would be a meaningless "0 of 0".
function pauseAtRestNote(p) {
  const total = num(p.total);
  if (p.allAtRest) return " · ✓ all sessions at rest — safe to close or switch subscription";
  if (total > 0) return " · " + num(p.atRestCount) + " of " + total + " at rest";
  return "";
}

// Show/hide the banner and (re)write its mostly-static note on a state change; the ticking
// duration itself is advanced every second by tickPauseBanner via the shared tick() loop, so
// this doesn't need to run more than once per snapshot/SSE frame.
function updatePauseBanner() {
  const el = $("pauseBanner");
  if (!el) return;
  const p = App.state && App.state.paused;
  const active = !!(p && p.active);
  el.classList.toggle("is-shown", active);
  if (!active) return;
  el.classList.toggle("banner--safe", !!p.allAtRest);
  const reasonNote = p.reason === "usage" ? " · auto (5h usage ≥ limit)" : "";
  $("pauseBannerNote").textContent = reasonNote + pauseAtRestNote(p);
  $("pauseBannerDuration").textContent = " · " + fmtDuration(pauseDurationMs(p, estNow()));
}

// Advance the banner's live duration each second; a no-op while it's hidden. The at-rest
// count/safe class are NOT re-derived here — updatePauseBanner (driven by state changes) owns
// them, and they don't change on a bare per-second tick.
function tickPauseBanner(now) {
  const p = App.state && App.state.paused;
  if (!p || !p.active) return;
  const el = $("pauseBannerDuration");
  if (el) el.textContent = " · " + fmtDuration(pauseDurationMs(p, now));
}

// Global Pause/Resume switch in the topbar — one control for every session, not per-session.
// Like the ⋯ repo-delete menu, it POSTs then refreshState() rather than trusting an optimistic
// local flip, so it always reflects the daemon's reconciled state. HIDDEN entirely when the
// feature is off in Settings: the topbar is persistent across every view, so a permanently
// disabled control there would be clutter on each page — the feature is opt-in and discoverable
// in Settings, so it only appears once armed.
function updatePauseButton() {
  const btn = $("pauseBtn");
  if (!btn) return;
  const enabled = !!(App.cfg && App.cfg.pauseGateEnabled);
  btn.hidden = !enabled;
  if (!enabled) return;
  const active = !!(App.state && App.state.paused && App.state.paused.active);
  btn.textContent = active ? "Resume" : "Pause";
  btn.title = active
    ? "Resume every session's next tool call"
    : "Pause every session's next tool call";
  btn.classList.toggle("btn--paused", active);
}

async function onPauseClick() {
  const btn = $("pauseBtn");
  if (!btn || btn.disabled) return;
  const active = !!(App.state && App.state.paused && App.state.paused.active);
  try {
    await api("/api/pause", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paused: !active }),
    });
    await refreshState();
    toast(active ? "Resumed" : "Paused — every session's next tool call will block");
  } catch (_e) {
    toast(active ? "Could not resume" : "Could not pause", true);
  }
}

// Refresh both pause-driven UI pieces together — called wherever App.state.paused or
// App.cfg.pauseGateEnabled might have just changed (a fresh snapshot, an SSE config frame).
function syncPauseUI() {
  updatePauseBanner();
  updatePauseButton();
}

// ---- Live usage bars (session 5h + weekly, from the statusline) -------------
// Anthropic's real rate-limit usage, forwarded by the cockpit statusline and served on
// /api/state as `usage`. Two bars — the session (5h) and weekly (7d) windows — both carrying
// the same pace cue (governed by the `usagePace` setting): a tick (on-pace mark), a delta
// (how far off an even burn), and a "time left" ETA that projects the burn rate to exhaustion.
// `usedPct` only changes when a new snapshot arrives; the reset countdown and the pace tick/delta/
// ETA advance every second via the shared tick() loop (elapsed-time only moves, the % holds).
// Never fabricates a 0 — see states.

const FIVE_HOUR_MS = 5 * 3600 * 1000;
const SEVEN_DAY_MS = 7 * 24 * 3600 * 1000;
const USAGE_STALE_MS = 10 * 60 * 1000; // snapshot older than this -> dim + "updated Xm ago"

function clamp01(x) {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

// Fraction of a fixed-length rolling window already elapsed at `now`, measured back from
// its end (resetsAt). On-pace usage equals this fraction (payload carries no window length,
// so windowMs is a named constant, not derived).
function elapsedFrac(resetsAt, windowMs, now) {
  return clamp01((now - (resetsAt - windowMs)) / windowMs);
}

// Fill colour by the statusline convention: green < 50, amber < 80, red >= 80.
function usageColor(pct) {
  return pct >= 80 ? "var(--st-error)" : pct >= 50 ? "var(--st-waiting)" : "var(--st-running)";
}

// The active config's pace mode, defaulting unknown/missing to "both".
function usagePaceMode() {
  const p = App.cfg && App.cfg.usagePace;
  return p === "tick" || p === "delta" || p === "off" ? p : "both";
}

// Per-window display state, in precedence order: `reset` (resetsAt already passed — the % is
// known-stale, overrides age) > `stale` (snapshot older than 10 min) > `live`; a window absent
// from the snapshot is `nodata`. Rate limits don't move without usage, so only clearly-old
// snapshots are flagged.
function usageWindowState(w, now, updatedAt) {
  if (!w) return "nodata";
  const hasReset = Number.isFinite(w.resetsAt) && w.resetsAt > 0;
  if (hasReset && w.resetsAt <= now) return "reset";
  if (Number.isFinite(updatedAt) && now - updatedAt > USAGE_STALE_MS) return "stale";
  return "live";
}

// Floor-decompose a duration into days/hours/minutes/seconds (negative/NaN clamp to 0) — shared
// by the reset countdown (fmtResetIn) and the pace-gap chip (fmtPaceGap) so their tiering can't drift.
function splitDuration(ms) {
  const s = Math.floor((ms > 0 ? ms : 0) / 1000);
  return { d: Math.floor(s / 86400), h: Math.floor((s % 86400) / 3600), m: Math.floor((s % 3600) / 60), s: s % 60 };
}

// Countdown text: "6d 5h" / "4h 32m" / "12m 30s" / "45s"; clamps negative to 0.
function fmtResetIn(ms) {
  const t = splitDuration(ms);
  if (t.d) return `${t.d}d ${t.h}h`;
  if (t.h) return `${t.h}h ${String(t.m).padStart(2, "0")}m`;
  if (t.m) return `${t.m}m ${String(t.s).padStart(2, "0")}s`;
  return `${t.s}s`;
}

const RESET_WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const RESET_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// True when two epoch-ms instants fall on the same local calendar day.
function sameLocalDay(a, b) {
  const x = new Date(a);
  const y = new Date(b);
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}

// Absolute reset moment in the viewer's local zone, 24-hour clock. The weekly window (`withDate`)
// always shows the full date ("Mon 13 Jul, 14:32"). The 5h window shows a bare time ("14:32"),
// but a rolling 5h window entered in the evening resets after midnight — so when the reset lands
// on another local day than `now`, a weekday is prefixed ("Thu 03:00") to keep it unambiguous.
function fmtResetAt(resetsAt, now, withDate) {
  const dt = new Date(resetsAt);
  const time = `${String(dt.getHours()).padStart(2, "0")}:${String(dt.getMinutes()).padStart(2, "0")}`;
  if (withDate) return `${RESET_WEEKDAYS[dt.getDay()]} ${dt.getDate()} ${RESET_MONTHS[dt.getMonth()]}, ${time}`;
  return sameLocalDay(resetsAt, now) ? time : `${RESET_WEEKDAYS[dt.getDay()]} ${time}`;
}

// The full reset line: the live countdown plus the absolute reset moment ("resets in 4h 32m ·
// 14:32"). Shared by render (usageBarHTML) and tick (advanceUsageBars) so both stay in sync.
function fmtResetLine(resetsAt, now, withDate) {
  return `resets in ${fmtResetIn(resetsAt - now)} · ${fmtResetAt(resetsAt, now, withDate)}`;
}

// On-pace dead zone: a RELATIVE band (~0.5% of the window, matching the old integer-percentage
// rounding), floored at 60s so the minute-resolution figure never shows "0m". Relative is the
// point — a fixed 60s is ~0.01% of the 7d window, so the weekly bar would essentially never read
// "on pace" and would show minute-scale noise; ~0.5% keeps a proportionate ~50min band there.
const PACE_ONPACE_FRAC = 0.005;
const PACE_ONPACE_FLOOR_MS = 60 * 1000;
function paceTolerance(windowMs) {
  return Math.max(PACE_ONPACE_FLOOR_MS, windowMs * PACE_ONPACE_FRAC);
}

// Compact magnitude for the pace delta: the fill-vs-tick gap rescaled to time (see applyDelta).
// Minute resolution, no seconds — "2d 4h" / "1h 13m" / "24m". Same tiering as fmtResetIn above.
function fmtPaceGap(ms) {
  const t = splitDuration(ms);
  if (t.d) return `${t.d}d ${t.h}h`;
  if (t.h) return `${t.h}h ${String(t.m).padStart(2, "0")}m`;
  return `${t.m}m`;
}

// Signed pace gap: the horizontal fill-vs-tick gap shown as BOTH a percentage and time —
// "▲ 6% · 18m". The % is the gap in percentage points (usedPct − elapsedFrac×100); the time is
// that same gap × windowMs (how much sooner/later than an even burn you hit this usage level).
// Direction is carried by the ▲/▼ arrow + the colour alone — over pace reads as caution (amber),
// under as calm (green), within the per-window on-pace band as neutral "on pace"; the old trailing
// "ahead"/"behind" word was dropped as redundant (it survives only in the hover title). `gapMs` is
// signed (+ ahead, − behind); `windowMs` scales both the band and the % (pct = |gapMs|/windowMs).
// Written into the chip at render and on tick.
function applyDelta(el, gapMs, windowMs) {
  el.classList.remove("usage-bar__delta--over", "usage-bar__delta--under", "usage-bar__delta--on");
  const pct = Math.round((Math.abs(gapMs) / windowMs) * 100);
  const tol = paceTolerance(windowMs);
  const v = gapMs >= tol ? "over" : gapMs <= -tol ? "under" : "on";
  if (v === "over") {
    el.classList.add("usage-bar__delta--over");
    el.textContent = "▲ " + pct + "% · " + fmtPaceGap(gapMs);
    el.title = pct + "% ahead of an even burn rate";
  } else if (v === "under") {
    el.classList.add("usage-bar__delta--under");
    el.textContent = "▼ " + pct + "% · " + fmtPaceGap(-gapMs);
    el.title = pct + "% behind an even burn rate";
  } else {
    el.classList.add("usage-bar__delta--on");
    el.textContent = "on pace";
    el.title = "usage is tracking the clock";
  }
}

// Burn-rate multiplier — current velocity as a multiple of the even ("normal") rate that would
// land on exactly 100% at reset: m = usedFrac / elapsedFrac, so 1.0× is on pace, 2.5× is 2.5× that
// rate. Rides after the pace delta in the foot — it REPLACED the "time-left" ETA there (the "≈2h
// left" projection): a rate reads as inherently variable, so an early swing looks like "going fast
// now" rather than the ETA's alarming, jumpy-early "you'll run out in 2d" against a small lead.
//
// Coloured by the SAME rounded value it displays (over → amber, under → green, on → muted), so the
// number and its colour can never contradict — a shown "1.0×" is always the muted on-pace colour,
// "1.1×"+ always over, "0.9×"− always under. This is a RATIO verdict, deliberately NOT the delta's
// additive time-gap verdict: near a window's start a small absolute gap is a large ratio, so the
// multiplier can read over/under while the delta still reads on-pace — the ratio is the intended
// earlier signal there. (Colouring by the gap instead would paint a rounded "1.0×" amber/green
// mid-window, or a far-from-1× ratio muted early on — the number fighting its own colour.)
//
// Blank in a jumpy-early guard (window's first 1%, or under 1% used) so a tiny elapsed denominator
// can't flash an absurd "40×". At the cap (pct ≥ 100) it shows "at limit" — with the ETA gone, the
// multiplier is now the sole carrier of the exhausted-state cue (a finite ratio would misread as
// headroom). On a stale bar usedPct is frozen but elapsed grows, so m drifts down over time —
// intended, and flagged old by the age note (like the delta).
function applyMult(el, usedPct, resetsAt, windowMs, now) {
  el.classList.remove(
    "usage-bar__mult--over",
    "usage-bar__mult--under",
    "usage-bar__mult--on",
    "usage-bar__mult--limit",
  );
  const pct = clamp(num(usedPct), 0, 100);
  const ef = elapsedFrac(resetsAt, windowMs, now);
  if (pct < 1 || ef <= 0.01) {
    el.textContent = "";
    el.removeAttribute("title");
    return;
  }
  if (pct >= 100) {
    el.classList.add("usage-bar__mult--limit");
    el.textContent = "at limit";
    el.title = "budget exhausted for this window";
    return;
  }
  // Classify by the string we actually render, so the verdict and the number are the same value.
  const disp = (pct / 100 / ef).toFixed(1);
  const r = parseFloat(disp);
  el.textContent = disp + "×";
  if (r > 1) {
    el.classList.add("usage-bar__mult--over");
    el.title = "burning " + disp + "× the even rate that would last exactly to the reset";
  } else if (r < 1) {
    el.classList.add("usage-bar__mult--under");
    el.title = "burning " + disp + "× the even rate — pacing under the clock";
  } else {
    el.classList.add("usage-bar__mult--on");
    el.title = "burning about the even rate that lasts to the reset";
  }
}

// Empty-state shell (nodata / reset): label + inert track + a note, with NO percentage or
// fill — the honest "no confidently-wrong bar" rule (never a fabricated 0 or a stale high %).
function usageShellHTML(kind, state, label, note) {
  return (
    `<div class="usage-bar" data-kind="${kind}" data-state="${state}">` +
    `<div class="usage-bar__head"><span class="usage-bar__label">${esc(label)}</span></div>` +
    `<div class="usage-bar__track"></div>` +
    `<div class="usage-bar__foot"><span class="usage-bar__note">${esc(note)}</span></div>` +
    `</div>`
  );
}

// One usage bar. `pace` (both|tick|delta|off) enables the pace cue (tick + delta) on the bar.
// `withDate` appends a dated reset moment (weekly) vs. a time-only one (5h) to the countdown.
function usageBarHTML(kind, w, windowMs, label, now, updatedAt, pace, withDate) {
  const state = usageWindowState(w, now, updatedAt);
  if (state === "nodata") return usageShellHTML(kind, state, label, "awaiting data…");
  if (state === "reset") return usageShellHTML(kind, state, label, "reset • awaiting update");
  // live | stale — render the last-known fill + percentage. A stale bar is NOT dimmed; the
  // "updated Xm ago" note (below) carries the "old data" signal instead.
  const pct = clamp(num(w.usedPct), 0, 100);
  const hasReset = Number.isFinite(w.resetsAt) && w.resetsAt > 0;
  // Pace cue on any bar with a real fill + reset (live OR stale). On a stale bar usedPct is frozen
  // but elapsed keeps advancing, so the delta naturally walks down toward/under 0 as the window
  // elapses until reset — intended, and flagged as old by the age note (not hidden).
  const showTick = hasReset && (pace === "both" || pace === "tick");
  const showDelta = hasReset && (pace === "both" || pace === "delta");
  const ef = hasReset ? elapsedFrac(w.resetsAt, windowMs, now) : 0;
  const tickHTML = showTick ? `<div class="usage-bar__tick" style="left:${(ef * 100).toFixed(2)}%"></div>` : "";
  const footInfo =
    (hasReset ? `<span class="usage-bar__reset">${esc(fmtResetLine(w.resetsAt, now, withDate))}</span>` : "") +
    (state === "stale" ? `<span class="usage-bar__age">updated ${esc(fmtAge(now - updatedAt))} ago</span>` : "");
  // The delta chip + the burn-rate multiplier are filled by applyDelta/applyMult so render + tick
  // share one implementation. The multiplier rides after the delta (it replaced the time-left ETA
  // that used to sit here); both are gated on `showDelta` so "off"/tick-only modes stay clean.
  let deltaHTML = "";
  if (showDelta) {
    deltaHTML = `<span class="usage-bar__delta"></span><span class="usage-bar__mult"></span>`;
  }
  const bar =
    `<div class="usage-bar" data-kind="${kind}" data-state="${state}">` +
    `<div class="usage-bar__head">` +
    `<span class="usage-bar__label">${esc(label)}</span>` +
    `<span class="usage-bar__pct">${Math.round(pct)}%</span>` +
    `</div>` +
    `<div class="usage-bar__track">` +
    `<div class="usage-bar__fill" style="width:${pct}%;background:${usageColor(pct)}"></div>` +
    tickHTML +
    `</div>` +
    `<div class="usage-bar__foot"><span class="usage-bar__foot-info">${footInfo}</span>${deltaHTML}</div>` +
    `</div>`;
  return bar;
}

// The whole usage block: the install affordance when no snapshot has ever arrived (NOT a
// fabricated 0), otherwise the two bars. Rendered as a full-width row inside the ribbon grid.
function usageBlockHTML(now) {
  const u = App.state && App.state.usage;
  if (!u)
    return (
      `<div class="usage usage--install">` +
      `<span class="usage-install" title="The cockpit statusline forwards Anthropic's real rate-limit usage to the dashboard. See statusline/README.md to install it.">Install the cockpit statusline to see live usage</span>` +
      `</div>`
    );
  const pace = usagePaceMode();
  const updatedAt = num(u.updatedAt);
  return (
    `<div class="usage">` +
    usageBarHTML("fiveHour", u.fiveHour, FIVE_HOUR_MS, "Session (5h)", now, updatedAt, pace, false) +
    usageBarHTML("sevenDay", u.sevenDay, SEVEN_DAY_MS, "Week", now, updatedAt, pace, true) +
    `</div>`
  );
}

// After the usage block's HTML is in the DOM, capture the window data + element refs the tick
// loop needs. usage == null (install affordance) leaves nothing to tick.
function bindUsage() {
  const u = App.state && App.state.usage;
  const ribbon = $("liveRibbon");
  if (!u || !ribbon) {
    App.usageRender = null;
    return;
  }
  const defs = [
    { kind: "fiveHour", win: u.fiveHour, windowMs: FIVE_HOUR_MS, withDate: false },
    { kind: "sevenDay", win: u.sevenDay, windowMs: SEVEN_DAY_MS, withDate: true },
  ];
  const bars = [];
  for (const d of defs) {
    const elBar = ribbon.querySelector('.usage-bar[data-kind="' + d.kind + '"]');
    if (!elBar) continue;
    bars.push({
      kind: d.kind,
      win: d.win,
      windowMs: d.windowMs,
      withDate: d.withDate,
      state: elBar.dataset.state,
      els: {
        reset: elBar.querySelector(".usage-bar__reset"),
        age: elBar.querySelector(".usage-bar__age"),
        tick: elBar.querySelector(".usage-bar__tick"),
        delta: elBar.querySelector(".usage-bar__delta"),
        mult: elBar.querySelector(".usage-bar__mult"),
      },
    });
  }
  App.usageRender = { updatedAt: num(u.updatedAt), bars };
}

// Rebuild only the usage block (leave the tiles), for a purely time-driven state change
// (resetsAt passing, or a snapshot ageing past 10 min) with no new frame to trigger a render.
function renderUsage() {
  const ribbon = $("liveRibbon");
  if (!ribbon) return;
  const wrap = document.createElement("div");
  wrap.innerHTML = usageBlockHTML(estNow());
  const fresh = wrap.firstElementChild;
  const existing = ribbon.querySelector(".usage");
  if (existing && fresh) existing.replaceWith(fresh);
  else if (fresh) ribbon.appendChild(fresh);
  bindUsage();
}

// Advance the live-moving parts (reset countdown, "updated Xm ago", 5h tick + delta) in place;
// the % / fill only change on a new snapshot.
function advanceUsageBars(now) {
  const r = App.usageRender;
  if (!r) return;
  for (const b of r.bars) {
    const w = b.win;
    if (!w) continue;
    const hasReset = Number.isFinite(w.resetsAt) && w.resetsAt > 0;
    if (b.els.reset && hasReset) b.els.reset.textContent = fmtResetLine(w.resetsAt, now, b.withDate);
    if (b.els.age) b.els.age.textContent = "updated " + fmtAge(now - r.updatedAt) + " ago";
    // Advance the pace cue whenever the bar shows one (live OR stale). On a stale bar usedPct is
    // frozen but elapsed advances, so the delta walks down over time until reset — intended.
    if (hasReset && (b.els.tick || b.els.delta || b.els.mult)) {
      const ef = elapsedFrac(w.resetsAt, b.windowMs, now);
      if (b.els.tick) b.els.tick.style.left = (ef * 100).toFixed(2) + "%";
      // Same gap the tick shows (fill − tick), rescaled from a fraction of the window to time;
      // windowMs also scales the on-pace band so the 7d bar isn't judged against a 5h tolerance.
      if (b.els.delta) applyDelta(b.els.delta, (clamp(num(w.usedPct), 0, 100) / 100 - ef) * b.windowMs, b.windowMs);
      // Burn-rate multiplier riding after the delta (see applyMult) — replaced the time-left ETA.
      if (b.els.mult) applyMult(b.els.mult, w.usedPct, w.resetsAt, b.windowMs, now);
    }
  }
}

// Called each second from tick(): rebuild the block if a window crossed a state threshold
// (reset/stale) since the last snapshot, else just advance the live-moving parts.
function tickUsage(now) {
  const r = App.usageRender;
  if (!r) return;
  for (const b of r.bars) {
    if (usageWindowState(b.win, now, r.updatedAt) !== b.state) {
      renderUsage();
      advanceUsageBars(now); // paint the freshly rebuilt bars immediately
      return;
    }
  }
  advanceUsageBars(now);
}

// The active subscription rendered as a leading ribbon TILE (matching the stat tiles) — it
// identifies whose account the row's totals belong to (server-derived, `App.state.subscription =
// { id, label } | null`). Returns "" when null — no live session has a known subscription
// (API-key / pre-feature) — so the tile just doesn't appear rather than showing a blank. The
// tooltip carries this subscription's ALL-TIME tokens/cost (`App.state.subscriptionTotals[sub.id]`,
// a range-free total distinct from the History chart's range-scoped breakdown), falling back to the
// plain description before totals are available. Its value is a name, not a stat.
function subscriptionTileHTML() {
  const sub = App.state && App.state.subscription;
  if (!sub || !sub.label) return "";
  const totals = App.state && App.state.subscriptionTotals && App.state.subscriptionTotals[sub.id];
  let title = "Active subscription — the newest live session's account";
  if (totals) {
    title += ` · all-time: ${fmtTokens(sumTokens(totals.tokens))} tokens`;
    if (typeof totals.cost === "number" && Number.isFinite(totals.cost)) title += `, ${fmtCost(totals.cost)}`;
  }
  return (
    `<div class="tile tile--sub" title="${esc(title)}">` +
    `<div class="tile__label">Subscription</div>` +
    `<div class="tile__value">${esc(sub.label)}</div>` +
    `</div>`
  );
}

function renderLiveRibbon() {
  // The Live page is the main screen, so its ribbon is a "today at a glance" summary:
  // every tile is TODAY's total across all of today's sessions, read from the today
  // per-repo rollup (App.state.repos) — so a session that already ended today still
  // counts, unlike a sum over only the live sessions. Sessions/Chats/Tools/Agents sum
  // the per-repo counts (a session touching two repos counts once per repo — rare, and
  // matches the Repos table's per-repo figures). The momentary Running/Waiting status
  // tiles were deliberately dropped — the ribbon is now purely today's accounting.
  const repos = (App.state && App.state.repos) || [];
  let sessionsToday = 0;
  let chats = 0;
  let tools = 0;
  let agents = 0;
  let activeMs = 0;
  let tok = 0;
  let cost = 0;
  let hasCost = false;
  for (const r of repos) {
    // r.sessions may arrive as an array (older payloads) or a number (current) — mirror
    // normalizeRepoRow so the ribbon and the Repos table read the field identically.
    sessionsToday += Array.isArray(r.sessions) ? r.sessions.length : num(r.sessions);
    chats += num(r.prompts);
    tools += num(sumTools(r.byTool)); // sumTools -> null when absent; num() folds it to 0
    agents += num(r.subagents);
    activeMs += num(r.activeMs);
    tok += sumTokens(r.tokens);
    if (typeof r.cost === "number" && Number.isFinite(r.cost)) {
      cost += r.cost;
      hasCost = true;
    }
  }
  // Lead with the active-subscription tile (identity for the row's totals; omitted when no live
  // session has a known subscription), then the accounting tiles in the canonical order:
  // Tokens | Cost | Sessions | Chats | Tools | Agents | Active time. Cost sits after Tokens and
  // drops out (leaving the rest in order) when disabled.
  const tiles = [];
  const subTile = subscriptionTileHTML();
  if (subTile) tiles.push(subTile);
  tiles.push(tile("Tokens", fmtTokens(tok)));
  if (costEnabled()) tiles.push(tile("Cost", hasCost ? fmtCost(cost) : "—"));
  tiles.push(tile("Sessions", sessionsToday));
  tiles.push(tile("Chats", chats));
  tiles.push(tile("Tools", tools));
  tiles.push(tile("Agents", agents));
  tiles.push(tile("Active time", fmtDuration(activeMs)));
  // The usage block is a full-width row that flows below the tiles inside the ribbon grid.
  $("liveRibbon").innerHTML = tiles.join("") + usageBlockHTML(estNow());
  bindUsage();
  advanceUsageBars(estNow()); // fill the delta chips (empty in the shell) + paint now
}

function renderLive() {
  // Hide an IDLE session that spent 0 tokens (and so 0 cost) — an opened-but-never-worked
  // session sitting idle. A RUNNING/WAITING/ERROR session is NEVER hidden: pollTokens sets a
  // running first-turn session's tokens to a KNOWN {0,0,0,0} before its first assistant usage
  // flushes, so a bare "known-zero" test would drop actively-running cards (and could show the
  // empty state while a session runs). Gating on effectiveStatus==="idle" keeps active cards
  // visible. tokens===null (transcript not read yet / unavailable) is unknown, not zero -> kept.
  const sessions = ((App.state && App.state.sessions) || []).filter(
    (s) => !(effectiveStatus(s) === "idle" && s.tokens != null && sumTokens(s.tokens) === 0)
  );
  renderLiveRibbon();
  const cards = $("cards");
  if (!sessions.length) {
    cards.innerHTML =
      '<div class="empty"><strong>No active sessions</strong>Start a Claude Code session and it will appear here.</div>';
    App.timers = [];
    return;
  }
  // "status" renders the server order (already waiting-first via compareCards);
  // "name" re-sorts a COPY alphabetically for stable positions (repoName, then
  // cwd, then sessionId as tie-breakers) — waiting is not floated up in this mode.
  let ordered = sessions;
  if (App.liveSort === "name") {
    ordered = sessions.slice().sort((a, b) => {
      const byName = String(a.repoName || "").localeCompare(String(b.repoName || ""));
      if (byName) return byName;
      const byCwd = String(a.cwd || "").localeCompare(String(b.cwd || ""));
      if (byCwd) return byCwd;
      return String(a.sessionId || "").localeCompare(String(b.sessionId || ""));
    });
  }
  cards.innerHTML = ordered.map(cardHTML).join("");
  cards.querySelectorAll(".path").forEach((btn) =>
    btn.addEventListener("click", () => copyPath(btn.dataset.path))
  );
  collectTimers();
  tick(); // paint timers immediately rather than waiting up to a second
}

async function copyPath(path) {
  try {
    await navigator.clipboard.writeText(path);
    toast("Path copied");
  } catch (_e) {
    toast("Copy failed", true);
  }
}

// Live card sort order — a per-browser preference (localStorage), NOT daemon config, so it
// never goes through PUT /api/config. Set from the Settings > Dashboard control. "status" keeps
// the server's waiting-first order; "name" sorts alphabetically for stable positions.
function setLiveSort(value) {
  App.liveSort = value === "name" ? "name" : "status";
  try {
    localStorage.setItem("cockpit.liveSort", App.liveSort);
  } catch (_e) {
    /* persistence best-effort */
  }
  renderLive();
}

// ---- Sessions view ---------------------------------------------------------

// Relative "3h ago" from an epoch-ms timestamp (the transcript file mtime). Reuses
// relTime (which parses an ISO string) after converting; "—" for a missing/invalid ms.
function relTimeMs(ms) {
  const n = num(ms);
  if (n <= 0) return "—";
  return relTime(new Date(n).toISOString());
}

// The anchor for a live session's ticking "elapsed" timer, matching the Live card: the
// open prompt's start, or — while a background workflow runs on after the launching turn's
// Stop — when the session became engaged. 0 when neither is known.
function liveTickAnchor(s) {
  const promptStartMs = s.currentPromptStartedAt ? Date.parse(s.currentPromptStartedAt) : 0;
  const engagedMs = s.engagedStartedAt ? Date.parse(s.engagedStartedAt) : 0;
  const anchor = Number.isFinite(promptStartMs) && promptStartMs > 0 ? promptStartMs : engagedMs;
  return Number.isFinite(anchor) && anchor > 0 ? anchor : 0;
}

// One Sessions-table row. `liveS` is the matching live session from App.state.sessions (or
// undefined for a plain past session). Every string that reaches innerHTML is esc()'d — the
// title is AI-generated text and could otherwise inject markup.
function sessionRowHTML(r, liveS, showCost) {
  const st = liveS ? displayStatus(liveS) : null;
  const statusCell = st
    ? `<td class="col-status"><span class="sbadge" data-status="${esc(st)}">${esc(STATUS_LABEL[st] || st)}</span></td>`
    : `<td class="col-status"></td>`;

  const title = r.title != null && String(r.title).trim() !== "" ? String(r.title) : null;
  const first8 = String(r.sessionId || "").slice(0, 8);
  // Name: the AI title when present; otherwise a muted fallback. NEVER the last-prompt text
  // (it isn't in the payload and would breach the no-message-content boundary).
  const nameCell = title
    ? `<td class="col-name" title="${esc(title)}">${esc(title)}</td>`
    : `<td class="col-name"><span class="session-untitled">Untitled session · ${esc(first8)}</span></td>`;

  const repoCell = r.repoName
    ? `<td class="col-repo"${r.repoRoot ? ` title="${esc(r.repoRoot)}"` : ""}>${esc(r.repoName)}</td>`
    : `<td class="col-repo muted">—</td>`;

  // Last active: a live running/engaged row shows the ticking elapsed timer (reused Live-card
  // mechanism); every other row shows the relative transcript mtime.
  let timeCell;
  const tickMs = liveS && st === "running" ? liveTickAnchor(liveS) : 0;
  if (tickMs) {
    timeCell = `<td class="col-time"><span class="live-elapsed" data-timer="dur" data-start="${tickMs}">0s</span></td>`;
  } else {
    const rel = relTimeMs(r.lastActive);
    timeCell = `<td class="col-time${rel === "—" ? " muted" : ""}">${esc(rel)}</td>`;
  }

  // tokens === null means the transcript couldn't be read/parsed: show it as unavailable,
  // NOT a misleading "0" (which would read as a real zero-cost session).
  let tokCell;
  if (r.tokens == null) {
    tokCell = `<td class="muted" title="token usage unavailable — transcript unreadable">—</td>`;
  } else {
    const tok = sumTokens(r.tokens);
    const tokTitle = typeof r.tokens === "object" ? ` title="${esc(tokensBreakdown(r.tokens))}"` : "";
    tokCell = `<td${tokTitle}>${esc(fmtTokens(tok))}</td>`;
  }

  let costCell = "";
  if (showCost) {
    const c = typeof r.cost === "number" ? r.cost : null;
    costCell = `<td${c == null ? ' class="muted"' : ""}>${esc(fmtCost(c))}</td>`;
  }

  // Chats / Tools / Agents — event-derived per-session counts (matching the Live card and the
  // Repos table, NOT the transcript, whose raw counts diverge). A LIVE session reads its fresh
  // overlay value (identical to its card); a past session uses the fetched event-index value;
  // null (a session the cockpit never observed, so no events) shows a muted "—", never a
  // misleading 0. Each carries a col-* class so refreshLiveStatCells can advance it in place
  // mid-turn (like Active) — else Tools/Agents would freeze at turn-start counts and disagree
  // with the card until the next rebuild. `cnt` renders that shared rule once.
  const cnt = (cls, v) =>
    v == null
      ? `<td class="${cls} muted" title="not recorded — the cockpit didn't observe this session">—</td>`
      : `<td class="${cls}">${esc(String(v))}</td>`;
  const chatsCell = cnt("col-chats", liveS ? num(liveS.promptCount) : r.chats);
  const toolsCell = cnt("col-tools", liveS ? num(liveS.toolCount) : r.tools);
  const agentsCell = cnt("col-agents", liveS ? num(liveS.subagents ? liveS.subagents.total : 0) : r.agents);

  // Active (engaged) time. A LIVE session uses its fresh overlay value (matches the Live
  // card and advances as it works — refreshLiveStatCells keeps it current between
  // rebuilds); a past session uses the fetched index value. null (only for a past session
  // the cockpit never observed) shows "—" rather than a misleading "0s".
  const activeMs = liveS ? num(liveS.activeMs) : r.activeMs;
  const activeCell =
    activeMs == null
      ? `<td class="col-active muted" title="no active time recorded — the cockpit didn't observe this session">—</td>`
      : `<td class="col-active">${esc(fmtDuration(num(activeMs)))}</td>`;

  // Column order matches the header: Tokens · Cost · Chats · Tools · Agents · Active, then Last
  // active (timeCell) last. data-session-id lets refreshLiveStatCells update the live cells
  // (found by their col-* classes, so this reorder is safe) in place each SSE frame.
  return `<tr data-session-id="${esc(r.sessionId)}">${statusCell}${nameCell}${repoCell}${tokCell}${costCell}${chatsCell}${toolsCell}${agentsCell}${activeCell}${timeCell}</tr>`;
}

// Render the Sessions table + pager from the cached rows (App.sessionsRows) and the current
// live overlay (App.state.sessions). Called on fetch and on every SSE frame while the view
// is open — the overlay is what keeps listed rows' badges/timers fresh, so no refetch.
function renderSessions() {
  const panel = $("sessionsPanel");
  if (!panel) return;
  App.sessionsOverlaySig = sessionsOverlaySig(); // seed, so the next SSE frame only rebuilds on a real change
  const rows = App.sessionsRows || [];
  const total = num(App.sessionsTotal);
  if (!rows.length) {
    panel.innerHTML =
      '<div class="empty"><strong>No sessions found</strong>Claude Code has no session transcripts on disk yet.</div>';
    renderSessionsPager(total);
    return;
  }
  const showCost = costEnabled();
  const live = {};
  for (const s of (App.state && App.state.sessions) || []) live[s.sessionId] = s;
  // Column order follows the canonical stat sequence (Tokens · Cost · Sessions · Chats · Tools ·
  // Agents · Active · Last active) shared with the Live ribbon/cards and the Repos table; a
  // session row omits Sessions (a row IS one session, so a session count is meaningless — the
  // Live card omits it for the same reason) and leads with Name · Repo as its label columns.
  const head =
    `<tr><th class="col-status" aria-hidden="true"></th><th class="col-name">Name</th>` +
    `<th class="col-repo">Repo</th><th>Tokens</th>` +
    (showCost ? "<th>Cost</th>" : "") +
    `<th>Chats</th><th>Tools</th><th>Agents</th>` +
    `<th class="col-active">Active</th>` +
    `<th class="col-time">Last active</th>` +
    `</tr>`;
  const body = rows.map((r) => sessionRowHTML(r, live[r.sessionId], showCost)).join("");
  panel.innerHTML = `<table class="table sessions-table"><thead>${head}</thead><tbody>${body}</tbody></table>`;
  renderSessionsPager(total);
  collectTimers(); // register any live ticking timers now in the rows
  tick(); // paint them immediately
}

function renderSessionsPager(total) {
  const pager = $("sessionsPager");
  if (!pager) return;
  const pageCount = Math.max(1, Math.ceil(num(total) / App.sessionsPageSize));
  const page = clamp(num(App.sessionsPage), 0, pageCount - 1);
  if (!total) {
    pager.innerHTML = "";
    return;
  }
  pager.innerHTML =
    `<button class="btn" id="sessPrev" type="button"${page <= 0 ? " disabled" : ""}>Prev</button>` +
    `<span class="pager__label">page ${page + 1} of ${pageCount} · ${total} session${total === 1 ? "" : "s"}</span>` +
    `<button class="btn" id="sessNext" type="button"${page >= pageCount - 1 ? " disabled" : ""}>Next</button>`;
}

// Fetch one page of GET /api/sessions and render it. Called on view (re)open and on
// Prev/Next only — NOT on every SSE frame (the O(total) server sweep must not run per frame).
function loadSessions(page) {
  const p = Math.max(0, Math.floor(num(page)));
  App.sessionsPage = p;
  api("/api/sessions?page=" + p + "&pageSize=" + App.sessionsPageSize)
    .then((data) => {
      App.sessionsTotal = num(data && data.total);
      const rows = data && Array.isArray(data.sessions) ? data.sessions : [];
      if (data && Number.isFinite(data.page)) App.sessionsPage = data.page;
      // Out-of-range page: the server clamps `page` only at 0 (no upper bound), so a
      // stale page beyond the current total returns an empty slice with total>0. Clamp
      // to the last valid page and refetch, so the view can't strand on "No sessions
      // found" with both pager buttons disabled and no in-UI recovery.
      if (!rows.length && App.sessionsTotal > 0) {
        const lastPage = Math.max(0, Math.ceil(App.sessionsTotal / App.sessionsPageSize) - 1);
        if (App.sessionsPage > lastPage) {
          loadSessions(lastPage);
          return;
        }
      }
      App.sessionsRows = rows;
      renderSessions();
    })
    .catch(() => {
      App.sessionsTotal = 0;
      App.sessionsRows = [];
      renderSessions(); // shows the "No sessions found" empty state
    });
}

// A compact signature of the live overlay for the currently-displayed rows —
// sessionId:status:timerAnchor for each. It changes only when a listed session's live
// status or its ticking-timer anchor changes; a plain token/activity update leaves it
// identical.
function sessionsOverlaySig() {
  const live = {};
  for (const s of (App.state && App.state.sessions) || []) live[s.sessionId] = s;
  return (App.sessionsRows || [])
    .map((r) => {
      const s = live[r.sessionId];
      const st = s ? displayStatus(s) : "";
      const anchor = s && st === "running" ? liveTickAnchor(s) : 0;
      return r.sessionId + ":" + st + ":" + anchor;
    })
    .join("|");
}

// SSE-frame refresh of the Sessions view. A full renderSessions() replaces the table's
// innerHTML — which drops the user's text selection and flickers up to ~4x/sec while a
// session is actively working — so only rebuild when a listed session's live status or
// timer anchor ACTUALLY changed (infrequent). Between those, the ticking timers keep
// moving via tick() with no DOM churn, so a title stays selectable.
function refreshSessionsOverlay() {
  refreshLiveStatCells(); // in-place: keep live rows' event-derived stats advancing without a rebuild
  const sig = sessionsOverlaySig();
  if (sig === App.sessionsOverlaySig) return;
  renderSessions(); // re-seeds App.sessionsOverlaySig
}

// Update every EVENT-DERIVED cell of each currently-live row from the fresh live overlay, in
// place (no table rebuild): Active (ticks each second), Chats, Tools, and Agents (rise as the
// turn works). Without this they'd freeze at fetch/rebuild-time values — refreshSessionsOverlay
// rebuilds only on a status/timer-anchor change, and none of these counts move that signature —
// so the row would diverge from the session's Live card mid-turn. Touching just these cells
// keeps the user's text selection (a full innerHTML rebuild would drop it). Past rows are
// static (index values) so are skipped. Tokens/cost aren't here — they're transcript-sourced
// snapshots that only change on a refetch.
function refreshLiveStatCells() {
  const panel = $("sessionsPanel");
  if (!panel) return;
  const live = {};
  for (const s of (App.state && App.state.sessions) || []) live[s.sessionId] = s;
  panel.querySelectorAll("tr[data-session-id]").forEach((tr) => {
    const s = live[tr.dataset.sessionId];
    if (!s) return; // a past row's index values are static — nothing to refresh
    const set = (sel, text) => {
      const cell = tr.querySelector(sel);
      if (!cell) return;
      cell.classList.remove("muted");
      cell.textContent = text;
    };
    set(".col-active", fmtDuration(num(s.activeMs)));
    set(".col-chats", String(num(s.promptCount)));
    set(".col-tools", String(num(s.toolCount)));
    set(".col-agents", String(num(s.subagents ? s.subagents.total : 0)));
  });
}

// ---- Per-repo view ---------------------------------------------------------

// Column order follows the canonical stat sequence (Tokens · Cost · Sessions · Chats · Tools ·
// Agents · Active · Last active) shared with the Live ribbon/cards and the Sessions table, with
// Repository as the leading label column. Reordering these entries reorders the rendered
// columns; sort still resolves by `key`, so the default (activeMs desc) is unaffected.
const REPO_COLS = [
  { key: "repoName", label: "Repository", type: "str", get: (r) => r.repoName },
  { key: "tokensTotal", label: "Tokens", type: "num", get: (r) => r.tokensTotal, fmt: (v) => (v == null ? "—" : fmtTokens(v)) },
  { key: "cost", label: "Cost", type: "num", get: (r) => r.cost, fmt: fmtCost },
  { key: "sessions", label: "Sessions", type: "num", get: (r) => r.sessions, fmt: (v) => (v == null ? "—" : String(v)) },
  { key: "prompts", label: "Chats", type: "num", get: (r) => r.prompts, fmt: (v) => (v == null ? "—" : String(v)) },
  { key: "toolsTotal", label: "Tools", type: "num", get: (r) => r.toolsTotal, fmt: (v) => (v == null ? "—" : String(v)) },
  { key: "agents", label: "Agents", type: "num", get: (r) => r.agents, fmt: (v) => (v == null ? "—" : String(v)) },
  { key: "activeMs", label: "Active", type: "num", get: (r) => r.activeMs, fmt: fmtDuration },
  { key: "lastActive", label: "Last active", type: "time", get: (r) => r.lastActive, fmt: (v) => (v ? relTime(v) : "—") },
];

function tokensBreakdown(t) {
  return `in ${fmtTokens(t.input)} · out ${fmtTokens(t.output)} · cache ${fmtTokens(num(t.cacheRead) + num(t.cacheWrite))}`;
}

// Sum a repo's per-tool counts. Returns null when the field is absent (older data /
// a range that doesn't carry it) so the cell renders "—"; an empty {} sums to 0.
function sumTools(bt) {
  if (!bt || typeof bt !== "object") return null;
  let n = 0;
  for (const k of Object.keys(bt)) n += num(bt[k]);
  return n;
}

function toolsBreakdown(bt) {
  return Object.keys(bt)
    .map((k) => `${k} ×${num(bt[k])}`)
    .join(" · ");
}

function sortRepoRows(rows) {
  const { key, dir } = App.repoSort;
  const col = REPO_COLS.find((c) => c.key === key) || REPO_COLS[1];
  const copy = rows.slice();
  copy.sort((a, b) => {
    const va = col.get(a);
    const vb = col.get(b);
    if (col.type === "str") return String(va || "").localeCompare(String(vb || "")) * dir;
    const na = col.type === "time" ? Date.parse(va) : va;
    const nb = col.type === "time" ? Date.parse(vb) : vb;
    const aNull = na == null || !Number.isFinite(na);
    const bNull = nb == null || !Number.isFinite(nb);
    if (aNull && bNull) return 0;
    if (aNull) return 1; // nulls always sort last, regardless of direction
    if (bNull) return -1;
    return (na - nb) * dir;
  });
  return copy;
}

function renderReposTable(rows) {
  const panel = $("repoPanel");
  closeMenu(); // any open ⋯ menu points at a button this re-render is about to discard
  const cols = REPO_COLS.filter((c) => c.key !== "cost" || costEnabled());
  if (!rows.length) {
    panel.innerHTML =
      '<div class="empty"><strong>No repository activity</strong>Nothing recorded for this range yet.</div>';
    return;
  }
  const sorted = sortRepoRows(rows);
  const head = cols
    .map((c) => {
      const active = App.repoSort.key === c.key;
      const arrow = active ? (App.repoSort.dir < 0 ? "▼" : "▲") : "";
      const sortAttr = active ? ` aria-sort="${App.repoSort.dir < 0 ? "descending" : "ascending"}"` : "";
      return `<th data-key="${c.key}"${sortAttr}>${esc(c.label)}<span class="arrow">${arrow}</span></th>`;
    })
    .join("");
  const body = sorted
    .map((r) => {
      const cells = cols
        .map((c) => {
          const raw = c.get(r);
          const val = c.fmt ? c.fmt(raw) : raw == null ? "—" : String(raw);
          const muted = val === "—" ? ' class="muted"' : "";
          let title = "";
          if (c.key === "tokensTotal" && r.tokensObj) title = ` title="${esc(tokensBreakdown(r.tokensObj))}"`;
          else if (c.key === "toolsTotal" && r.byTool && Object.keys(r.byTool).length)
            title = ` title="${esc(toolsBreakdown(r.byTool))}"`;
          return `<td${muted}${title}>${esc(val)}</td>`;
        })
        .join("");
      // Trailing action cell: a ⋯ button opening the per-repo menu (Delete repo data…).
      // Only rendered when we have a repoRoot to target the delete at.
      const canDelete = r.repoRoot != null && r.repoRoot !== "";
      const action = `<td class="col-action">${
        canDelete
          ? `<button class="repo-menu-btn" type="button" data-repo-root="${esc(r.repoRoot)}" data-repo-name="${esc(
              r.repoName || basename(r.repoRoot)
            )}" title="Actions" aria-label="Repository actions">⋯</button>`
          : ""
      }</td>`;
      return `<tr>${cells}${action}</tr>`;
    })
    .join("");
  panel.innerHTML = `<table class="table"><thead><tr>${head}<th class="col-action" aria-hidden="true"></th></tr></thead><tbody>${body}</tbody></table>`;
}

function setRepoSort(key) {
  if (App.repoSort.key === key) App.repoSort.dir *= -1;
  else App.repoSort = { key, dir: key === "repoName" ? 1 : -1 };
  renderReposTable(App.repoRows);
}

// Normalize one repo record into the row shape the Per-repo table renders. Both
// sources — /api/state repos ("today") and /api/history topRepos (other ranges) —
// carry the same fields, so a single normalizer keeps the two range paths from
// drifting: a column added here reaches every range at once, instead of showing a
// value in "today" and "—" in the rest. `sessions` may arrive as an array (older
// state payloads) or a number (current); both collapse to a count.
function normalizeRepoRow(r) {
  return {
    repoRoot: r.repoRoot,
    repoName: r.repoName || basename(r.repoRoot),
    activeMs: num(r.activeMs),
    prompts: r.prompts == null ? null : num(r.prompts),
    sessions: Array.isArray(r.sessions) ? r.sessions.length : typeof r.sessions === "number" ? r.sessions : null,
    tokensObj: r.tokens && typeof r.tokens === "object" ? r.tokens : null,
    tokensTotal: r.tokens == null ? null : sumTokens(r.tokens),
    agents: r.subagents == null ? null : num(r.subagents),
    byTool: r.byTool && typeof r.byTool === "object" ? r.byTool : null,
    toolsTotal: sumTools(r.byTool),
    cost: typeof r.cost === "number" ? r.cost : null,
    lastActive: r.lastActive || null,
  };
}

// Today uses live per-repo totals from /api/state; other ranges use the
// pre-bucketed rollups exposed by /api/history. Both paths feed normalizeRepoRow.
function renderReposFromState() {
  const repos = (App.state && App.state.repos) || [];
  App.repoRows = repos.map(normalizeRepoRow);
  renderReposTable(App.repoRows);
}

function loadRepos() {
  if (App.repoRange === "today") {
    renderReposFromState();
    return;
  }
  api("/api/history?range=" + encodeURIComponent(App.repoRange))
    .then((h) => {
      App.repoRows = ((h && h.topRepos) || []).map(normalizeRepoRow);
      renderReposTable(App.repoRows);
    })
    .catch(() => {
      App.repoRows = [];
      renderReposTable([]);
    });
}

// ---- Data management (⋯ menu · confirm modal · storage) --------------------

// A single floating ⋯ menu at a time; positioned fixed against the clicked button
// (so the panel's overflow can't clip it). Closed on outside click, scroll, resize,
// or any table re-render (renderReposTable calls closeMenu).
let activeMenu = null;

function onDocClickForMenu(e) {
  if (activeMenu && !activeMenu.contains(e.target) && !e.target.closest(".repo-menu-btn")) closeMenu();
}

function closeMenu() {
  if (!activeMenu) return;
  activeMenu.remove();
  activeMenu = null;
  document.removeEventListener("click", onDocClickForMenu);
  window.removeEventListener("resize", closeMenu);
  window.removeEventListener("scroll", closeMenu, true);
}

function openRepoMenu(btn) {
  closeMenu();
  const repoRoot = btn.dataset.repoRoot;
  if (!repoRoot) return;
  const repoName = btn.dataset.repoName || basename(repoRoot);
  const menu = document.createElement("div");
  menu.className = "menu";
  menu.innerHTML = '<button class="menu__item menu__item--danger" type="button">Delete repo data…</button>';
  document.body.appendChild(menu);
  activeMenu = menu;
  // Anchor under the button, right edges aligned, clamped into the viewport.
  const r = btn.getBoundingClientRect();
  const mw = menu.offsetWidth;
  const left = clamp(r.right - mw, 8, Math.max(8, window.innerWidth - mw - 8));
  menu.style.top = Math.round(r.bottom + 4) + "px";
  menu.style.left = Math.round(left) + "px";
  menu.querySelector(".menu__item--danger").addEventListener("click", () => {
    closeMenu();
    confirmDeleteRepo(repoRoot, repoName);
  });
  // Defer so the click that opened the menu doesn't immediately close it.
  setTimeout(() => document.addEventListener("click", onDocClickForMenu), 0);
  window.addEventListener("resize", closeMenu);
  window.addEventListener("scroll", closeMenu, true);
}

// In-app confirm (never a native confirm()). Resolves true on confirm, false on
// cancel / Escape / overlay click. `bodyHTML` is caller-built — escape dynamic parts.
function showConfirm({ title, bodyHTML, confirmLabel = "Delete", cancelLabel = "Cancel", danger = true }) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}">
        <h3 class="modal__title">${esc(title)}</h3>
        <div class="modal__body">${bodyHTML}</div>
        <div class="modal__actions">
          <button class="btn modal__btn-cancel" type="button">${esc(cancelLabel)}</button>
          <button class="btn ${danger ? "btn--danger" : ""} modal__btn-confirm" type="button">${esc(confirmLabel)}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const close = (result) => {
      document.removeEventListener("keydown", onKey);
      overlay.remove();
      resolve(result);
    };
    const onKey = (e) => {
      if (e.key === "Escape") close(false);
    };
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close(false);
    });
    overlay.querySelector(".modal__btn-cancel").addEventListener("click", () => close(false));
    overlay.querySelector(".modal__btn-confirm").addEventListener("click", () => close(true));
    document.addEventListener("keydown", onKey);
    overlay.querySelector(".modal__btn-confirm").focus();
  });
}

async function confirmDeleteRepo(repoRoot, repoName) {
  const ok = await showConfirm({
    title: "Delete repo data",
    bodyHTML:
      `<p>Permanently delete all cockpit accounting for <b>${esc(repoName)}</b>?</p>` +
      `<p class="modal__warn">This removes <b>every</b> token, cost, active-time and history record for this repository from the store. It cannot be undone.</p>`,
    confirmLabel: "Delete repo data",
  });
  if (!ok) return;
  try {
    const res = await api("/api/repos/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repoRoot }),
    });
    toast(`Deleted ${repoName} — freed ${fmtBytes(res && res.freedBytes)}`);
    await refreshState();
    loadRepos(); // reflect the removal in the current range's table (state only covers "today")
    loadStorage();
  } catch (e) {
    // 409 = a live session still owns this repo; the daemon refuses so it can't be re-populated.
    if (e && e.status === 409) toast("Close the session in this repo first", true);
    else toast("Could not delete repo data", true);
  }
}

async function onCleanupClick() {
  const input = $("set-cleanup-days");
  if (!input) return;
  const raw = String(input.value).trim();
  const n = Math.floor(Number(raw));
  if (raw === "" || !Number.isFinite(n) || n < 1) {
    toast("Enter how many days to keep (1 or more)", true);
    return;
  }
  const st = App.storage;
  const days = num(st && st.days);
  // Match the daemon's calendar arithmetic (cutoffDate: setDate(getDate()-n)) rather than
  // fixed-ms subtraction, so the previewed cutoff can't drift a day from what's deleted
  // across a DST transition. Everything strictly before `cutoff` is removed.
  const cd = new Date();
  cd.setDate(cd.getDate() - n);
  const cutoff = ymd(cd);
  // Preview the concrete scope so a mistyped N on an irreversible whole-store delete
  // is catchable. The exact per-day list isn't in /api/storage, so the day/byte counts
  // are an estimate (labelled "about" / "~") scaled from the day span; the daemon is
  // authoritative and the toast reports the actual counts.
  let preview;
  if (!st || !days) {
    preview = "<p>The store has no data to clean up yet.</p>";
  } else {
    // Exact deleted-day count from the day list (the daemon deletes whole day-files
    // strictly before the cutoff; today is never < cutoff so it's never counted). Fall
    // back to a proportional estimate only for an older daemon that omits `dates`.
    let deletedCount;
    let exact = false;
    if (Array.isArray(st.dates)) {
      deletedCount = st.dates.filter((d) => d < cutoff).length;
      exact = true;
    } else {
      const spanDays = st.oldestDate && st.newestDate ? daysBetween(st.oldestDate, st.newestDate) + 1 : days;
      const beforeCutoff = st.oldestDate ? clamp(daysBetween(st.oldestDate, cutoff), 0, spanDays) : 0;
      deletedCount = spanDays > 0 ? clamp(Math.round((days * beforeCutoff) / spanDays), 0, days) : 0;
    }
    // Per-day bytes aren't known, so freed size stays an estimate (average × deleted days).
    const freedEst = days > 0 ? (num(st.bytes) * deletedCount) / days : 0;
    preview =
      `<p>Delete all cockpit data recorded before <b>${esc(cutoff)}</b> (older than <b>${n}</b> day${n === 1 ? "" : "s"}); everything from <b>${esc(cutoff)}</b> onward is kept.</p>` +
      `<p>Store now: <b>${days}</b> day${days === 1 ? "" : "s"}` +
      (st.oldestDate && st.newestDate ? ` (${esc(st.oldestDate)} – ${esc(st.newestDate)})` : "") +
      `, <b>${fmtBytes(num(st.bytes))}</b>. ${exact ? "Removes" : "Estimated to remove about"} <b>${deletedCount}</b> day-file${deletedCount === 1 ? "" : "s"} (~<b>${fmtBytes(freedEst)}</b>).</p>`;
  }
  const ok = await showConfirm({
    title: "Clean up old data",
    bodyHTML:
      preview +
      `<p class="modal__warn">Whole-day files older than the cutoff are permanently removed (today is never touched). This cannot be undone.</p>`,
    confirmLabel: "Clean up",
  });
  if (!ok) return;
  try {
    const res = await api("/api/data/cleanup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ olderThanDays: n }),
    });
    const dd = num(res && res.deletedDays);
    toast(`Cleaned up ${dd} day${dd === 1 ? "" : "s"} — freed ${fmtBytes(res && res.freedBytes)}`);
    loadStorage();
    await refreshState();
  } catch (_e) {
    toast("Could not clean up data", true);
  }
}

// Fill the Data section's size + span from GET /api/storage (Settings-only; safe to
// call when the section isn't mounted — renderStorageInfo no-ops if elements are absent).
function loadStorage() {
  api("/api/storage")
    .then((st) => {
      App.storage = st;
      renderStorageInfo(st);
    })
    .catch(() => {
      App.storage = null;
      renderStorageInfo(null);
    });
}

function renderStorageInfo(st) {
  const sizeEl = $("storage-size");
  const spanEl = $("storage-span");
  if (!sizeEl || !spanEl) return; // Data section not currently rendered
  if (!st) {
    sizeEl.textContent = "—";
    sizeEl.removeAttribute("title");
    spanEl.textContent = "storage unavailable";
    return;
  }
  sizeEl.textContent = fmtBytes(num(st.bytes));
  const d = st.dirs || {};
  sizeEl.title =
    `events ${fmtBytes(num(d.events))} · usage ${fmtBytes(num(d.usage))} · ` +
    `rollups ${fmtBytes(num(d.rollups))} · snapshot ${fmtBytes(num(d.snapshot))}`;
  const days = num(st.days);
  if (!days) {
    spanEl.textContent = "no data yet";
    return;
  }
  const span =
    st.oldestDate && st.newestDate && st.oldestDate !== st.newestDate
      ? `${st.oldestDate} – ${st.newestDate}`
      : st.newestDate || st.oldestDate || "";
  spanEl.textContent = `${days} day${days === 1 ? "" : "s"}${span ? " · " + span : ""}`;
}

// ---- History view ----------------------------------------------------------

// Fixed categorical palette, assigned to stacked/grouped/donut series in order.
// An overflow ("Other") tail slice uses the muted ink so it never cycles a hue.
const SERIES = [
  "var(--series-1)",
  "var(--series-2)",
  "var(--series-3)",
  "var(--series-4)",
  "var(--series-5)",
  "var(--series-6)",
];

// Small formatter used by the History charts.
const intFmt = (n) => String(Math.round(num(n)));

// Some charts.js primitives are ported from the gallery (opts.fmt) while the
// reused barChart/lineChart historically read opts.format; pass both so the
// formatter lands whichever key the primitive reads.
function fo(fmt, extra) {
  return Object.assign({ fmt, format: fmt }, extra || {});
}

// The History view is one flat, full-width list of charts (no grouping/headers).
// Each card's plot host is `#<id>`; drawHistory renders into it, in this order.
const HIST_CARDS = [
  { id: "hc-tokens-cost", title: "Tokens & cost per day" },
  { id: "hc-sub-usage", title: "Cost per subscription" },
  { id: "hc-tokens-cost-hour", title: "Tokens & cost per active hour" },
  { id: "hc-tokens-chat", title: "Tokens per chat" },
  { id: "hc-cost-type", title: "Cost per day, by type" },
  { id: "hc-punch", title: "Day-of-week × hour", sub: "The classic punchcard" },
  { id: "hc-calendar", title: "Calendar heatmap", sub: "Active time per day" },
  { id: "hc-agents-type", title: "Subagents by type" },
  { id: "hc-tool-usage", title: "Tool usage" },
];

// Parse a "YYYY-MM-DD" rollup date as a LOCAL calendar date (not UTC) so the
// calendar heatmap's weekday columns match the daemon's local day boundaries.
function parseLocalDate(s) {
  const p = String(s).split("-");
  return new Date(+p[0], +p[1] - 1, +p[2]);
}

// Avg prompt/context tokens per chat for a day: (input + cacheRead + cacheWrite) / chats
// — the prompt-side tokens (output excluded), a proxy for typical context size per turn.
// An ESTIMATE: a daily average across that day's sessions, not true per-message depth.
function avgContext(d) {
  const t = d.tokens || {};
  const chats = num(d.prompts);
  return chats > 0 ? (num(t.input) + num(t.cacheRead) + num(t.cacheWrite)) / chats : 0;
}

function histCats(perDay) {
  return perDay.map((d) => ({ label: d.date, short: dayShort(d.date) }));
}

// Union of the keys of a per-day sub-map (e.g. d.byModel) across the range.
function unionKeys(perDay, mapFn) {
  const set = new Set();
  perDay.forEach((d) => {
    const m = mapFn(d) || {};
    Object.keys(m).forEach((k) => set.add(k));
  });
  return [...set];
}

// Build the (full-width) chart cards once; drawHistory then fills each plot.
function buildHistoryScaffold() {
  if (App.histBuilt) return;
  const card = (c) =>
    `<div class="card"><div class="card__top"><div class="card__title">${esc(c.title)}</div>` +
    (c.sub ? `<div class="card__sub">${esc(c.sub)}</div>` : "") +
    `</div><div class="plot" id="${c.id}"></div></div>`;
  $("histBody").innerHTML = `<div class="grid">${HIST_CARDS.map(card).join("")}</div>`;
  App.histBuilt = true;
}

// ---- draw all charts -------------------------------------------------------

function drawHistory(h) {
  App.histData = h || { perDay: [], byDowHour: [], topRepos: [] };
  buildHistoryScaffold();
  const perDay = App.histData.perDay || [];
  const cats = histCats(perDay);
  const costOn = costEnabled();
  const COST_OFF = "Cost display is off.";

  // Tokens & cost per day — DUAL-AXIS (tokens left, cost right, each self-scaled), with
  // Chats + Avg context as quiet dotted, axis-less correlation lines. Tooltip shows the
  // real values. (Dual-axis is a deliberate, user-chosen tradeoff.)
  {
    const series = [
      { name: "Tokens", color: "var(--series-1)", fmt: fmtTokens, points: perDay.map((d) => ({ label: d.date, short: dayShort(d.date), value: sumTokens(d.tokens) })) },
    ];
    if (costOn) {
      series.push({ name: "Cost", color: "var(--series-2)", fmt: fmtCost, points: perDay.map((d) => ({ label: d.date, short: dayShort(d.date), value: num(d.cost) })) });
    }
    series.push({ name: "Chats", color: "var(--series-3)", fmt: intFmt, dot: true, noAxis: true, points: perDay.map((d) => ({ label: d.date, short: dayShort(d.date), value: num(d.prompts) })) });
    series.push({ name: "Avg context", color: "var(--series-5)", fmt: fmtTokens, dot: true, noAxis: true, points: perDay.map((d) => ({ label: d.date, short: dayShort(d.date), value: avgContext(d) })) });
    lineChart($("hc-tokens-cost"), series, { height: 360, empty: "No history yet." });
  }

  // Tokens & cost per active hour — same style, each day's totals ÷ that day's ACTIVE
  // time (a per-hour burn rate). Days with 0 active time drop off the x-axis.
  {
    const days = perDay.filter((d) => num(d.activeMs) > 0);
    const perHr = (v, d) => v / (num(d.activeMs) / 3600000);
    const series = [
      { name: "Tokens", color: "var(--series-1)", fmt: fmtTokens, points: days.map((d) => ({ label: d.date, short: dayShort(d.date), value: perHr(sumTokens(d.tokens), d) })) },
    ];
    if (costOn) {
      series.push({ name: "Cost", color: "var(--series-2)", fmt: fmtCost, points: days.map((d) => ({ label: d.date, short: dayShort(d.date), value: perHr(num(d.cost), d) })) });
    }
    series.push({ name: "Chats", color: "var(--series-3)", fmt: intFmt, dot: true, noAxis: true, points: days.map((d) => ({ label: d.date, short: dayShort(d.date), value: num(d.prompts) })) });
    series.push({ name: "Avg context", color: "var(--series-5)", fmt: fmtTokens, dot: true, noAxis: true, points: days.map((d) => ({ label: d.date, short: dayShort(d.date), value: avgContext(d) })) });
    lineChart($("hc-tokens-cost-hour"), series, { height: 360, empty: "No active time yet." });
  }

  // Tokens per chat, with tools & active time per chat as quiet dotted correlation
  // lines. Only days with ≥1 chat contribute (avoids divide-by-zero).
  {
    const days = perDay.filter((d) => num(d.prompts) > 0);
    const per = (v, d) => v / num(d.prompts);
    const series = [
      { name: "Tokens", color: "var(--series-1)", fmt: fmtTokens, points: days.map((d) => ({ label: d.date, short: dayShort(d.date), value: per(sumTokens(d.tokens), d) })) },
      { name: "Tools", color: "var(--series-3)", fmt: intFmt, dot: true, noAxis: true, points: days.map((d) => ({ label: d.date, short: dayShort(d.date), value: per(num(d.tools), d) })) },
      { name: "Active", color: "var(--series-5)", fmt: fmtDuration, dot: true, noAxis: true, points: days.map((d) => ({ label: d.date, short: dayShort(d.date), value: per(num(d.activeMs), d) })) },
    ];
    lineChart($("hc-tokens-chat"), series, { height: 360, empty: "Not enough data yet." });
  }

  // Cost per day, by type — where spend actually lands. Output/input dominate COST even
  // though cache-read dominates token COUNT (cache-read is ~50× cheaper per token).
  if (!costOn) {
    stacked($("hc-cost-type"), cats, [], fo(fmtCost, { height: 360, empty: COST_OFF }));
  } else {
    const classes = [["cacheRead", "Cache read"], ["input", "Input"], ["output", "Output"], ["cacheWrite", "Cache write"]];
    const series = classes.map(([k, name], i) => ({ name, color: SERIES[i], values: perDay.map((d) => num((d.costByType || {})[k])) }));
    stacked($("hc-cost-type"), cats, series, fo(fmtCost, { height: 360, empty: "No cost history yet." }));
  }

  // Day-of-week × hour punchcard
  {
    const raw = App.histData.byDowHour;
    const matrix = Array.isArray(raw) && raw.length === 7 ? raw : Array.from({ length: 7 }, () => new Array(24).fill(0));
    punch($("hc-punch"), matrix, fo(fmtDuration, { empty: "No activity yet." }));
  }

  // Calendar heatmap — charts.calendar lays cells out by sequential index in
  // Monday-start weeks, so it needs a CONTIGUOUS daily series. The range (esp. "all")
  // omits inactive days, so build a full day-by-day series from the first day to the
  // last (missing days = 0), starting from the Monday of the first day's week — else a
  // gap would shift every later day into the wrong weekday/week.
  {
    const dayVals = [];
    if (perDay.length) {
      const byDate = new Map(perDay.map((d) => [d.date, num(d.activeMs)]));
      const first = parseLocalDate(perDay[0].date);
      const last = parseLocalDate(perDay[perDay.length - 1].date);
      const cur = new Date(first);
      cur.setDate(cur.getDate() - ((first.getDay() + 6) % 7)); // back up to Monday
      while (cur <= last) {
        const key = `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, "0")}-${String(cur.getDate()).padStart(2, "0")}`;
        dayVals.push({ date: new Date(cur), value: byDate.get(key) || 0 });
        cur.setDate(cur.getDate() + 1);
      }
    }
    calendar($("hc-calendar"), dayVals, fo(fmtDuration, { empty: "No activity yet." }));
  }

  // Subagents by type (full-width horizontal bars; each bar shows its share of total)
  {
    const types = unionKeys(perDay, (d) => d.byAgentType);
    const data = types
      .map((t) => ({ label: t, value: perDay.reduce((a, d) => a + num((d.byAgentType || {})[t]), 0) }))
      .filter((x) => x.value > 0)
      .sort((a, b) => b.value - a.value);
    barChart($("hc-agents-type"), data, fo(intFmt, { horizontal: true, color: "var(--series-5)", percent: true, empty: "No subagents yet." }));
  }

  // Tool usage (full-width horizontal bars, tall so every tool gets a row)
  {
    const tools = unionKeys(perDay, (d) => d.byTool);
    const data = tools
      .map((t) => ({ label: t, value: perDay.reduce((a, d) => a + num((d.byTool || {})[t]), 0) }))
      .filter((x) => x.value > 0)
      .sort((a, b) => b.value - a.value);
    barChart($("hc-tool-usage"), data, fo(intFmt, { horizontal: true, height: 480, empty: "No tool usage yet." }));
  }

  // Cost per subscription, by day — ONE line per subscription, all on a shared $ axis so
  // the subscriptions compare directly; each point's tokens ride in the tooltip. Sits right
  // under "Tokens & cost per day" and matches its 360px height. Cost-dependent like the other
  // cost charts, so it shows the cost-off empty state when cost display is off.
  // `App.histData.bySubscription` is the TOP-LEVEL range aggregate — { [id]: { label, tokens,
  // cost } } — used here only for the ORDERED set of subscriptions + their labels/colours; each
  // line's daily values come from `perDay[i].bySubscription` (a per-day { [id]: { label, tokens,
  // cost } } map that buildHistory now emits). Overflow past the 6-colour palette folds into a
  // single muted "Other" line.
  {
    const bySub = App.histData.bySubscription || {};
    // Include any subscription with token ACTIVITY in the range (not cost>0): a subscription
    // whose usage is entirely on an unpriced/unlisted model has cost 0, and filtering on cost
    // would silently drop it from the chart though it has real usage everywhere else. It still
    // plots (a flat $0 line) — matching the old bars' tokens>0 filter. Ordered by cost desc
    // (the chart's measure); unpriced subs sort to the end and fold into "Other" first.
    const ids = Object.keys(bySub)
      .filter((id) => sumTokens(bySub[id].tokens) > 0)
      .sort((a, b) => num(bySub[b].cost) - num(bySub[a].cost));
    // Show this card only when the range has MULTIPLE subscriptions with activity — with one,
    // its single line just restates "Tokens & cost per day". When cost display is ON also require
    // at least one nonzero cost: an all-unpriced range has no cost signal, so HIDE it rather than
    // render an empty "no history" chart on a visible card. When cost is OFF still show the card as
    // the standard cost-off placeholder (like the sibling cost charts). Re-evaluated each draw, so
    // switching range reveals/hides it. Toggling display (not an early return from drawHistory)
    // keeps this block self-contained and robust to any chart added after it.
    const hasCost = ids.some((id) => num(bySub[id].cost) > 0);
    const show = ids.length >= 2 && (!costOn || hasCost);
    const card = $("hc-sub-usage").closest(".card");
    if (card) card.style.display = show ? "" : "none";
    if (show && !costOn) {
      lineChart($("hc-sub-usage"), [], { height: 360, empty: COST_OFF });
    } else if (show) {
      const PAL = ["var(--series-1)", "var(--series-2)", "var(--series-3)", "var(--series-4)", "var(--series-5)", "var(--series-6)"];
      // Keep the top (PAL.length − 1) named and fold the rest into "Other"; if they all fit, keep all.
      const named = ids.length > PAL.length ? ids.slice(0, PAL.length - 1) : ids;
      const rest = ids.slice(named.length);
      // A subscription with token activity but no configured rate has cost 0; since some other
      // shown subscription has cost (the `hasCost` gate above), it isn't dropped — it plots as a
      // flat $0 line rather than vanishing.
      const pt = (d, id) => {
        const rec = (d.bySubscription || {})[id];
        return { label: d.date, short: dayShort(d.date), value: rec ? num(rec.cost) : 0, value2: rec ? sumTokens(rec.tokens) : 0 };
      };
      const series = named.map((id, i) => ({
        name: bySub[id].label || id,
        color: PAL[i],
        fmt: fmtCost,
        fmt2: fmtTokens,
        points: perDay.map((d) => pt(d, id)),
      }));
      if (rest.length) {
        series.push({
          name: "Other",
          color: "var(--ink-2)",
          fmt: fmtCost,
          fmt2: fmtTokens,
          // Fold the overflow subscriptions per day via the SAME pt() extraction the named
          // lines use, so the Other line can't diverge from them on a future field change.
          points: perDay.map((d) =>
            rest.reduce((acc, id) => {
              const p = pt(d, id);
              acc.value += p.value;
              acc.value2 += p.value2;
              return acc;
            }, { label: d.date, short: dayShort(d.date), value: 0, value2: 0 })
          ),
        });
      }
      lineChart($("hc-sub-usage"), series, { height: 360, sharedScale: true, empty: "No subscription history yet." });
    }
  }
}

function loadHistory() {
  api("/api/history?range=" + encodeURIComponent(App.histRange))
    .then(drawHistory)
    .catch(() => drawHistory(null));
}

// ---- Settings view ---------------------------------------------------------

function sw(id, checked) {
  return `<label class="switch"><input type="checkbox" id="${id}" ${checked ? "checked" : ""}><span class="switch__track"></span></label>`;
}

function fieldRow(title, sub, control) {
  return `<div class="field"><div class="field__label"><b>${esc(title)}</b>${sub ? `<small>${esc(sub)}</small>` : ""}</div><div class="field__control">${control}</div></div>`;
}

function section(title, hint, inner) {
  return `<section class="card-section"><h3>${esc(title)}</h3>${hint ? `<p class="hint">${esc(hint)}</p>` : ""}${inner}</section>`;
}

function rateRowHTML(model, r) {
  r = r || {};
  return `<tr>
    <td><input class="model r-model" value="${esc(model)}" placeholder="model-id"></td>
    <td><input class="r-input" type="number" min="0" step="0.01" value="${num(r.input)}"></td>
    <td><input class="r-output" type="number" min="0" step="0.01" value="${num(r.output)}"></td>
    <td><input class="r-cacheRead" type="number" min="0" step="0.01" value="${num(r.cacheRead)}"></td>
    <td><input class="r-cacheWrite" type="number" min="0" step="0.01" value="${num(r.cacheWrite)}"></td>
    <td><button class="rm" type="button" title="Remove">×</button></td>
  </tr>`;
}

function ratesTableHTML(rates) {
  const rows = Object.keys(rates || {}).map((m) => rateRowHTML(m, rates[m])).join("");
  return (
    `<table class="rates"><thead><tr><th>Model</th><th>Input</th><th>Output</th><th>Cache read</th><th>Cache write</th><th></th></tr></thead>` +
    `<tbody id="rates-body">${rows}</tbody></table>` +
    `<button class="btn" id="add-rate" type="button">+ Add model</button>`
  );
}

function settingsHTML(cfg) {
  const ev = cfg.events || {};
  const cost = cfg.cost || {};
  const pace = ["both", "tick", "delta", "off"].includes(cfg.usagePace) ? cfg.usagePace : "both";
  const notifications = section(
    "Notifications",
    "OS notifications are emitted by the daemon, so they work whether or not this dashboard is open.",
    fieldRow("OS notifications", "Master toggle for desktop banners", sw("set-osNotifications", cfg.osNotifications)) +
      fieldRow("Notification sound", "Play the OS notification sound", sw("set-sound", cfg.sound)) +
      fieldRow("Session finished", "When a turn completes", sw("set-ev-sessionFinished", ev.sessionFinished)) +
      fieldRow("Needs input", "When a session is waiting on you", sw("set-ev-needsInput", ev.needsInput)) +
      fieldRow("Long-running prompt", "When a prompt exceeds the threshold below", sw("set-ev-longRunning", ev.longRunning)) +
      fieldRow("Turn failed", "When a turn ends on an error", sw("set-ev-turnFailed", ev.turnFailed)) +
      fieldRow("Safe to close", "When every session is parked and it is safe to close the laptop", sw("set-ev-safeToClose", ev.safeToClose))
  );

  const dashboard = section(
    "Dashboard",
    null,
    fieldRow("In-browser sounds", "Play Web Audio cues in this tab", sw("set-browserSounds", cfg.browserSounds)) +
      fieldRow(
        "Live view sort",
        "Order the live session cards (this browser only)",
        `<select class="select" id="set-liveSort">
           <option value="status" ${App.liveSort === "status" ? "selected" : ""}>Status (waiting first)</option>
           <option value="name" ${App.liveSort === "name" ? "selected" : ""}>Repository name</option>
         </select>`
      ) +
      fieldRow(
        "Usage pace cue",
        "Tick and/or over-under delta on the session (5h) and weekly usage bars",
        `<select class="select" id="set-usagePace">
           <option value="both" ${pace === "both" ? "selected" : ""}>Tick + delta</option>
           <option value="tick" ${pace === "tick" ? "selected" : ""}>Tick only</option>
           <option value="delta" ${pace === "delta" ? "selected" : ""}>Delta only</option>
           <option value="off" ${pace === "off" ? "selected" : ""}>Off</option>
         </select>`
      ) +
      fieldRow(
        "Activity detail",
        "Arguments may contain paths/secrets — shown locally only",
        `<select class="select" id="set-activityDetail">
           <option value="tool" ${cfg.activityDetail === "tool" ? "selected" : ""}>Tool name only</option>
           <option value="args" ${cfg.activityDetail === "args" ? "selected" : ""}>Tool name + arguments</option>
         </select>`
      ) +
      // Pause gate: the master switch (below) plus its optional usage-based auto-pilot —
      // mirrors the Notifications section's master-toggle-then-detail pattern above.
      fieldRow(
        "Pause gate",
        "Let /cockpit:pause and this dashboard's Pause button freeze every session's next tool call",
        sw("set-pauseGateEnabled", cfg.pauseGateEnabled)
      ) +
      fieldRow(
        "Auto-pause at 5h usage %",
        "Auto-pause when the 5h usage window crosses this % (needs the statusline installed); 0 = off",
        `<input class="input" id="set-autoPauseFiveHourPct" type="number" min="0" max="100" step="1" value="${num(cfg.autoPauseFiveHourPct)}"><span class="chip">%</span>`
      ) +
      fieldRow(
        "Subscription label pattern",
        "A regex extracting the meaningful part of a verbose subscription name (capture group 1, else the whole match). Default pulls the parenthesized part: \"FOSS Analytical (Lyra)\" → \"Lyra\". Clear to show the raw name unchanged. Applied read-time only — never edits stored data.",
        `<input class="input input--wide" id="set-subscriptionLabelPattern" type="text" placeholder="\\(([^)]+)\\)" value="${esc(cfg.subscriptionLabelPattern != null ? cfg.subscriptionLabelPattern : "")}">`
      )
  );

  const behavior = section(
    "Thresholds",
    null,
    fieldRow(
      "Long-running threshold",
      "Seconds before a prompt counts as long-running",
      `<input class="input" id="set-longRunningSec" type="number" min="0" step="1" value="${Math.round(num(cfg.longRunningThresholdMs) / 1000)}"><span class="chip">sec</span>`
    ) +
      fieldRow(
        "Idle shutdown",
        "Hours idle before the daemon exits (0 = stay resident)",
        `<input class="input" id="set-idleShutdownHours" type="number" min="0" step="1" value="${num(cfg.idleShutdownHours)}"><span class="chip">hrs</span>`
      )
  );

  // Data: on-disk store size + manual cleanup. Size/span are filled from GET /api/storage
  // by loadStorage() after render (and after any mutation) — the markup carries placeholders.
  // Wrapped in #data-section so its controls are excluded from the config auto-save handler.
  const data = section(
    "Data",
    "Cockpit stores its accounting on disk and never deletes it automatically. Clean up old data to reclaim space — deletions are permanent.",
    `<div id="data-section">` +
      `<div class="field"><div class="field__label"><b>Store size</b><small id="storage-span">…</small></div>` +
      `<div class="field__control"><span class="data-size" id="storage-size">…</span></div></div>` +
      fieldRow(
        "Clean up old data",
        "Permanently delete whole days older than the entered age (today is never touched)",
        `<input class="input" id="set-cleanup-days" type="number" min="1" step="1" placeholder="90"><span class="chip">days</span><button class="btn btn--inline" id="btn-cleanup" type="button">Clean up</button>`
      ) +
      `</div>`
  );

  const costSection = section(
    "Cost estimation",
    "Rates are USD-equivalent per 1,000,000 tokens. Estimates only — not authoritative charges.",
    fieldRow("Show cost", "Estimate dollar cost from the rate table", sw("set-cost-enabled", cost.enabled)) +
      fieldRow("Currency", "Display currency code", `<input class="input input--wide" id="set-cost-currency" type="text" value="${esc(cost.currency || "USD")}">`) +
      ratesTableHTML(cost.rates)
  );

  return notifications + dashboard + behavior + costSection + data;
}

function renderSettings() {
  const host = $("settings");
  if (!host) return;
  if (!App.cfg) {
    host.innerHTML = '<div class="empty"><strong>Loading…</strong>Waiting for the daemon.</div>';
    App.settingsRendered = false;
    return;
  }
  host.innerHTML = settingsHTML(App.cfg);
  App.settingsRendered = true;
  loadStorage(); // populate the Data section's size + span (and refresh App.storage for the preview)
}

// Re-render settings on external config change, but never while the user is
// editing a field inside the form (that would clobber their input).
function maybeRenderSettings() {
  const host = $("settings");
  if (host && host.contains(document.activeElement)) return;
  renderSettings();
}

function readSettingsForm() {
  const cb = (id) => $(id).checked;
  const nv = (id, def) => {
    // A cleared/blank field means "use the default", NOT 0 — Number("") === 0,
    // so a blank threshold would otherwise persist 0 instead of its intended default.
    const raw = String($(id).value).trim();
    if (raw === "") return def;
    const n = Number(raw);
    return Number.isFinite(n) ? n : def;
  };
  const rates = {};
  document.querySelectorAll("#rates-body tr").forEach((tr) => {
    const model = tr.querySelector(".r-model").value.trim();
    if (!model) return; // skip blank rows
    rates[model] = {
      input: num(tr.querySelector(".r-input").value),
      output: num(tr.querySelector(".r-output").value),
      cacheRead: num(tr.querySelector(".r-cacheRead").value),
      cacheWrite: num(tr.querySelector(".r-cacheWrite").value),
    };
  });
  // Send the FULL config: config.validateConfig rebuilds from defaults, so a
  // partial PUT would reset everything else. `port` isn't UI-editable — preserve it.
  return {
    port: App.cfg ? App.cfg.port : 4319,
    osNotifications: cb("set-osNotifications"),
    sound: cb("set-sound"),
    browserSounds: cb("set-browserSounds"),
    activityDetail: $("set-activityDetail").value,
    usagePace: $("set-usagePace").value,
    pauseGateEnabled: cb("set-pauseGateEnabled"),
    autoPauseFiveHourPct: nv("set-autoPauseFiveHourPct", 0),
    subscriptionLabelPattern: $("set-subscriptionLabelPattern").value,
    events: {
      sessionFinished: cb("set-ev-sessionFinished"),
      needsInput: cb("set-ev-needsInput"),
      longRunning: cb("set-ev-longRunning"),
      turnFailed: cb("set-ev-turnFailed"),
      safeToClose: cb("set-ev-safeToClose"),
    },
    longRunningThresholdMs: Math.round(nv("set-longRunningSec", 300) * 1000),
    idleShutdownHours: nv("set-idleShutdownHours", 0),
    cost: {
      enabled: cb("set-cost-enabled"),
      currency: $("set-cost-currency").value.trim() || "USD",
      rates,
    },
  };
}

let saveTimer;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveSettings, 250);
}

async function saveSettings() {
  let body;
  try {
    body = readSettingsForm();
  } catch (_e) {
    return; // form not fully rendered
  }
  try {
    const res = await api("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res && res.config) App.cfg = res.config;
    toast("Settings saved");
  } catch (e) {
    const errs = e && e.data && e.data.errors;
    toast(errs && errs.length ? "Invalid: " + errs[0] : "Could not save settings", true);
  }
}

function onSettingsClick(e) {
  if (e.target.closest("#btn-cleanup")) {
    onCleanupClick();
    return;
  }
  const rm = e.target.closest(".rm");
  if (rm) {
    const tr = rm.closest("tr");
    if (tr) {
      tr.remove();
      scheduleSave();
    }
    return;
  }
  if (e.target.closest("#add-rate")) {
    const bodyEl = $("rates-body");
    if (!bodyEl) return;
    const tmp = document.createElement("tbody");
    tmp.innerHTML = rateRowHTML("", { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    bodyEl.appendChild(tmp.firstElementChild); // let the user type before it saves
  }
}

// ---- state application & view switching ------------------------------------

// Refresh the per-repo table from the freshest data for its current range: "today"
// renders straight from the live /api/state snapshot (instant, no fetch); every other
// range re-fetches /api/history. Skipped while a ⋯ menu is open (a re-render closes it).
function refreshReposView() {
  if (App.view !== "repos" || activeMenu) return;
  if (App.repoRange === "today") renderReposFromState();
  else loadRepos();
}

// SSE frames are frequent and a historical range re-fetches /api/history, so coalesce
// bursts into at most one fetch per REPO_REFRESH_MS. "today" reads the in-memory state
// with no fetch, so it refreshes immediately without the throttle.
let repoRefreshTimer = null;
function throttledReposRefresh() {
  if (App.view !== "repos" || activeMenu) return;
  if (App.repoRange === "today") {
    renderReposFromState();
    return;
  }
  if (repoRefreshTimer) return;
  repoRefreshTimer = setTimeout(() => {
    repoRefreshTimer = null;
    refreshReposView();
  }, REPO_REFRESH_MS);
}

function applyState(state) {
  if (!state) return;
  App.state = state;
  if (state.config) App.cfg = state.config;
  if (typeof state.now === "number") App.clockOffset = state.now - Date.now();
  syncPauseUI(); // before renderLive/renderSessions — displayStatus() reads App.state.paused
  detectSoundCues(state.sessions || []);
  renderLive();
  throttledReposRefresh();
  // Sessions view: refresh the live overlay (badges/timers) of the already-fetched rows
  // from the new snapshot — no endpoint refetch (that only happens on view open / Prev-Next),
  // and only a real status/timer change rebuilds the table (else selection would drop).
  if (App.view === "sessions") refreshSessionsOverlay();
  if (App.view === "settings" && !App.settingsRendered) renderSettings();
}

// A config arrived out-of-band (SSE) or a save changed cost display; refresh the
// visible view. Settings is only re-rendered when the user isn't mid-edit.
function onConfigChanged() {
  updatePauseButton(); // pauseGateEnabled may have just flipped (enable/disable+hint)
  renderLive();
  refreshReposView(); // rare, so refresh immediately (cost column may have changed)
  // Refetch (not just re-render): cost is computed server-side per request, so a pricing
  // rate edit or a cost enable/disable only reaches the client's rows by re-fetching.
  if (App.view === "sessions") loadSessions(App.sessionsPage);
  // History cost fields are computed server-side per request, so a cost enable/disable
  // or rate edit only reaches the charts + pivot by refetching.
  if (App.view === "history") loadHistory();
  if (App.view === "settings") maybeRenderSettings();
}

function setView(v) {
  App.view = v;
  document.querySelectorAll(".nav__tab").forEach((t) => t.classList.toggle("is-active", t.dataset.view === v));
  document.querySelectorAll(".view").forEach((sec) => sec.classList.toggle("is-active", sec.id === "view-" + v));
  if (v === "sessions") loadSessions(App.sessionsPage);
  else if (v === "repos") loadRepos();
  else if (v === "history") loadHistory();
  else if (v === "settings") renderSettings();
}

function setActiveRange(containerId, btn) {
  $(containerId)
    .querySelectorAll(".range__btn")
    .forEach((b) => b.classList.toggle("is-active", b === btn));
}

// ---- connection status & SSE -----------------------------------------------

const CONN_TEXT = { live: "live", reconnecting: "reconnecting…", lost: "disconnected", idle: "connecting…" };

function setConn(stateName) {
  const c = $("conn");
  c.dataset.state = stateName;
  $("connText").textContent = CONN_TEXT[stateName] || stateName;
}

function showBanner() {
  $("banner").classList.add("is-shown");
}
function hideBanner() {
  $("banner").classList.remove("is-shown");
}

function clearReconnect() {
  if (App.reconnectTimer) {
    clearTimeout(App.reconnectTimer);
    App.reconnectTimer = null;
  }
}

function scheduleReconnect() {
  if (App.reconnectTimer) return;
  const delay = Math.min(1000 * Math.pow(2, App.failures), 15000);
  App.reconnectTimer = setTimeout(() => {
    App.reconnectTimer = null;
    connect();
  }, delay);
}

function connect() {
  clearReconnect();
  if (App.es) {
    App.es.close();
    App.es = null;
  }
  const es = new EventSource("/api/stream?token=" + encodeURIComponent(App.token));
  App.es = es;

  es.addEventListener("open", () => {
    App.failures = 0;
    hideBanner();
    setConn("live");
    // Full resync on (re)connect rather than assuming we missed nothing.
    refreshState().catch(() => {});
  });

  es.addEventListener("state", (e) => {
    setConn("live");
    try {
      applyState(JSON.parse(e.data));
    } catch (_e) {
      /* ignore malformed frame */
    }
  });

  es.addEventListener("config", (e) => {
    try {
      App.cfg = JSON.parse(e.data);
      onConfigChanged();
    } catch (_e) {
      /* ignore */
    }
  });

  es.addEventListener("error", () => {
    App.failures++;
    App.soundsPrimed = false; // re-prime after a gap so we don't burst cues
    if (App.failures >= LOST_AFTER) {
      setConn("lost");
      showBanner();
    } else {
      setConn("reconnecting");
    }
    // EventSource auto-retries only while CONNECTING; when CLOSED we retry manually.
    if (es.readyState === EventSource.CLOSED) scheduleReconnect();
  });
}

// ---- init ------------------------------------------------------------------

function init() {
  // Per-browser Live sort preference (unknown value → "status"); the Settings > Dashboard
  // control reflects and updates it (see setLiveSort).
  try {
    const ls = localStorage.getItem("cockpit.liveSort");
    if (ls === "name" || ls === "status") App.liveSort = ls;
  } catch (_e) {
    /* localStorage unavailable — keep the default */
  }

  $("nav").addEventListener("click", (e) => {
    const t = e.target.closest(".nav__tab");
    if (t) setView(t.dataset.view);
  });

  $("sessionsPager").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b || b.disabled) return;
    if (b.id === "sessPrev") loadSessions(App.sessionsPage - 1);
    else if (b.id === "sessNext") loadSessions(App.sessionsPage + 1);
  });

  $("pauseBtn").addEventListener("click", onPauseClick);

  $("repoRange").addEventListener("click", (e) => {
    const b = e.target.closest(".range__btn");
    if (!b) return;
    setActiveRange("repoRange", b);
    App.repoRange = b.dataset.range;
    loadRepos();
  });

  $("histRange").addEventListener("click", (e) => {
    const b = e.target.closest(".range__btn");
    if (!b) return;
    setActiveRange("histRange", b);
    App.histRange = b.dataset.range;
    loadHistory();
  });

  $("repoPanel").addEventListener("click", (e) => {
    const menuBtn = e.target.closest(".repo-menu-btn");
    if (menuBtn) {
      openRepoMenu(menuBtn);
      return;
    }
    const th = e.target.closest("th[data-key]");
    if (th) setRepoSort(th.dataset.key);
  });

  // Delegated on the static #settings container so listeners survive innerHTML swaps.
  const sh = $("settings");
  sh.addEventListener("change", (e) => {
    // Live view sort is a per-browser localStorage preference, not daemon config — apply it
    // locally and never PUT it (a config save would also pop a spurious "Settings saved" toast).
    if (e.target.id === "set-liveSort") {
      setLiveSort(e.target.value);
      return;
    }
    // The Data section (store size + cleanup) isn't part of the config, so its inputs
    // must not trigger a config PUT / "Settings saved" toast.
    if (e.target.closest("#data-section")) return;
    scheduleSave();
  });
  sh.addEventListener("click", onSettingsClick);

  // Browsers gate audio until a user gesture; resume the context on interaction.
  window.addEventListener("pointerdown", ensureAudio);

  setInterval(tick, 1000);

  refreshState().catch(() => {}); // fast first paint before the SSE opens
  connect();
}

// Module scripts run after the DOM is parsed, but guard anyway.
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
else init();

// ---- toast -----------------------------------------------------------------

let toastTimer;
function toast(msg, isErr) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.toggle("toast--error", !!isErr);
  t.classList.add("is-shown");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("is-shown"), 2200);
}
