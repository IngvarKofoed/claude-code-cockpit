// app.js — the cockpit dashboard SPA (buildless ES module, served by the daemon).
// Loads /api/state, subscribes to /api/stream (SSE), renders the four views, and
// edits config via PUT /api/config. All fetches carry the bearer token; the SSE
// URL carries it as ?token= (EventSource can't set headers).

import { barChart, lineChart, hourHeatmap } from "./charts.js";

// ---- app state -------------------------------------------------------------

const App = {
  token: window.__COCKPIT_TOKEN__ || "",
  state: null, // last /api/state snapshot { now, sessions, repos, config, daemon }
  cfg: null, // current config (from state.config / config SSE / PUT response)
  clockOffset: 0, // serverNow - clientNow, for drift-corrected timers
  view: "live",
  repoRange: "today",
  histRange: "7d",
  liveSort: "status", // "status" (server waiting-first) | "name" (alpha); set from localStorage in init
  repoRows: [], // normalized rows currently shown in the per-repo table
  repoSort: { key: "activeMs", dir: -1 }, // dir: 1 asc, -1 desc
  prevStatus: {}, // sessionId -> last status, for sound-cue transition detection
  soundsPrimed: false, // suppress cues on first snapshot / after a reconnect gap
  flash: {}, // sessionId -> { until: epoch ms window ends, cls: variant class } for the status-change pulse
  longFired: {}, // sessionId -> promptStartMs already alerted for longRunning
  timers: [], // [{ el, start, kind }] updated once per second
  settingsRendered: false,
  es: null,
  failures: 0,
  reconnectTimer: null,
};

const LOST_AFTER = 4; // consecutive SSE failures before showing the lost banner
const FLASH_MS = 800; // window for a single short pulse (~0.7s cardPulse + margin)
const FLASH_LONG_MS = 3700; // window for the important transitions (5 pulses ≈ 3.5s + margin)

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

function collectTimers(root) {
  App.timers = [];
  root.querySelectorAll("[data-timer]").forEach((el) => {
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
};

// The card's effective status. A session with background work still in flight (bgTasks —
// Claude Code's authoritative background_tasks count) reads as "running": it IS working after
// its turn's Stop, so the badge, colour, big timer and pulse should all say so. A permission
// prompt or error takes precedence (they need attention / are terminal). Derived from the
// reliable count, never the ±unreliable subagent counter — so the timer can't disagree with
// the colour, and the "done" pulse fires only on the real engaged→idle transition.
function effectiveStatus(s) {
  const raw = s.status || "idle";
  if (raw === "waiting" || raw === "error") return raw;
  return raw === "running" || num(s.bgTasks) > 0 ? "running" : "idle";
}

function activityText(s) {
  switch (effectiveStatus(s)) {
    case "running":
      return s.currentActivity ? "Running " + s.currentActivity : "Working…";
    case "waiting":
      return "Waiting for your input";
    case "error":
      return "Turn failed" + (s.errorReason ? " · " + s.errorReason : "");
    case "ended":
      return "Session ended";
    default:
      return s.currentActivity || "Idle";
  }
}

function chip(text, mono) {
  return `<span class="chip ${mono ? "chip--mono" : ""}">${esc(text)}</span>`;
}

function cardHTML(s) {
  const status = effectiveStatus(s);
  const waiting = status === "waiting";
  const promptStart = s.currentPromptStartedAt;
  const promptStartMs = promptStart ? Date.parse(promptStart) : 0;
  // The big timer ticks for an open prompt (running/waiting) OR — so it keeps counting
  // while a background workflow runs after the launching turn's Stop — while the session
  // is `running`, measured from when it became engaged (engagedStartedAt).
  // Visibility is gated on the RELIABLE status (the same signal that drives the card
  // colour), NOT on subagents.active: SubagentStart/SubagentStop are not guaranteed 1:1
  // (a dropped/interrupted SubagentStop leaves the counter stuck > 0), so gating on it
  // made an idle/gray card tick a phantom "working" timer forever. During a real
  // background workflow the subagents' own PreToolUse/PostToolUse fire on the parent and
  // hold status at `running`, so the timer keeps counting; the instant the session is
  // idle/waiting/error the timer stops — the timer now always agrees with the colour.
  const running = status === "running";
  const engagedMs = running && s.engagedStartedAt ? Date.parse(s.engagedStartedAt) : 0;
  const timerMs = promptStartMs || engagedMs;
  // Label only when there's an actual timer value; otherwise the "—" would sit under a
  // misleading "working"/"prompt" action word (e.g. running with no engagedStartedAt yet).
  const timerLabel = !timerMs ? "" : running ? (promptStartMs ? "elapsed" : "working") : "prompt";
  const tokensTotal = s.tokens == null ? null : sumTokens(s.tokens);

  const chips = [];
  if (s.permissionMode) chips.push(chip(s.permissionMode));
  if (s.effortLevel) chips.push(chip("effort: " + s.effortLevel));
  // The model chip shows the current model; its tooltip reveals every model this
  // session has used (marking the current one) when a /model switch has occurred.
  if (s.model)
    chips.push(`<span class="chip chip--mono" title="${esc(modelsTooltip(s))}">${esc(shortModel(s.model))}</span>`);

  const sa = s.subagents || {};
  const stats = [
    `<div class="stat"><span class="stat__k">Chats</span><span class="stat__v">${num(s.promptCount)}</span></div>`,
    `<div class="stat"><span class="stat__k">Tokens</span><span class="stat__v">${tokensTotal == null ? "—" : esc(fmtTokens(tokensTotal))}</span></div>`,
  ];
  if (costEnabled())
    stats.push(`<div class="stat"><span class="stat__k">Cost</span><span class="stat__v">${esc(fmtCost(s.cost))}</span></div>`);
  // Active = this session's cumulative working time (sum of closed turns). Uses
  // fmtDuration to match the Per-repo table and History, which render the same metric.
  stats.push(`<div class="stat"><span class="stat__k">Active</span><span class="stat__v">${esc(fmtDuration(num(s.activeMs)))}</span></div>`);
  // Subagents (total spawned; tooltip breaks down by type + active count) and Tools
  // (all tool invocations this session, incl. those inside subagents).
  stats.push(`<div class="stat" title="${esc(subagentsTitle(sa))}"><span class="stat__k">Agents</span><span class="stat__v">${num(sa.total)}</span></div>`);
  stats.push(`<div class="stat"><span class="stat__k">Tools</span><span class="stat__v">${num(s.toolCount)}</span></div>`);

  // Repo-wide cumulative total (all sessions, all time), rendered as a second row
  // that shares the stat grid's columns — prompts/tokens/cost each land under the
  // matching per-session value so the two rows compare straight down. It carries no
  // text label: the muted colour + the dashed divider mark it as the repo total; the
  // tooltip explains it. Cells auto-flow in the same column order as the stats row.
  const rt = App.state && App.state.repoTotals && s.repoRoot ? App.state.repoTotals[s.repoRoot] : null;
  const repoTok = rt && rt.tokens != null ? sumTokens(rt.tokens) : null;
  const atTitle = "This repo's cumulative total across every session in retained history (all time, up to the retention limit), including backfilled sessions. Chats, active time, agents and tools come from live sessions only — backfilled history contributes tokens/cost but not those.";
  const rtCells = [
    `<span class="card__at-v" title="${atTitle}">${rt && rt.prompts != null ? num(rt.prompts) : "—"}</span>`,
    `<span class="card__at-v" title="${atTitle}">${repoTok == null ? "—" : esc(fmtTokens(repoTok))}</span>`,
  ];
  if (costEnabled()) rtCells.push(`<span class="card__at-v" title="${atTitle}">${esc(fmtCost(rt ? rt.cost : null))}</span>`);
  // Active, then Agents, then Tools — pushed in this order (after the optional cost) so
  // the repo-total cells land under the matching stats-row columns in both layouts.
  rtCells.push(`<span class="card__at-v" title="${atTitle}">${rt && rt.activeMs != null ? esc(fmtDuration(num(rt.activeMs))) : "—"}</span>`);
  rtCells.push(`<span class="card__at-v" title="${atTitle}">${rt && rt.subagents != null ? num(rt.subagents) : "—"}</span>`);
  rtCells.push(`<span class="card__at-v" title="${atTitle}">${rt && rt.tools != null ? num(rt.tools) : "—"}</span>`);

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
        <span class="telemetry__value" ${timerMs ? `data-timer="dur" data-start="${timerMs}"` : ""}>${timerMs ? "0s" : "—"}</span>
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

function renderLiveRibbon(sessions) {
  const running = sessions.filter((s) => effectiveStatus(s) === "running").length;
  const waiting = sessions.filter((s) => effectiveStatus(s) === "waiting").length;
  const repos = (App.state && App.state.repos) || [];
  let tok = 0;
  let cost = 0;
  let hasCost = false;
  for (const r of repos) {
    tok += sumTokens(r.tokens);
    if (typeof r.cost === "number" && Number.isFinite(r.cost)) {
      cost += r.cost;
      hasCost = true;
    }
  }
  const tiles = [
    tile("Sessions", sessions.length),
    tile("Running", running),
    tile("Waiting", waiting, waiting > 0),
    tile("Tokens today", fmtTokens(tok)),
  ];
  if (costEnabled()) tiles.push(tile("Cost today", hasCost ? fmtCost(cost) : "—"));
  $("liveRibbon").innerHTML = tiles.join("");
}

function renderLive() {
  const sessions = (App.state && App.state.sessions) || [];
  renderLiveRibbon(sessions);
  $("liveNote").textContent = sessions.length ? `${sessions.length} active` : "";
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
  collectTimers(cards);
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

// ---- Per-repo view ---------------------------------------------------------

const REPO_COLS = [
  { key: "repoName", label: "Repository", type: "str", get: (r) => r.repoName },
  { key: "activeMs", label: "Active", type: "num", get: (r) => r.activeMs, fmt: fmtDuration },
  { key: "prompts", label: "Chats", type: "num", get: (r) => r.prompts, fmt: (v) => (v == null ? "—" : String(v)) },
  { key: "sessions", label: "Sessions", type: "num", get: (r) => r.sessions, fmt: (v) => (v == null ? "—" : String(v)) },
  { key: "tokensTotal", label: "Tokens", type: "num", get: (r) => r.tokensTotal, fmt: (v) => (v == null ? "—" : fmtTokens(v)) },
  { key: "toolsTotal", label: "Tools", type: "num", get: (r) => r.toolsTotal, fmt: (v) => (v == null ? "—" : String(v)) },
  { key: "cost", label: "Cost", type: "num", get: (r) => r.cost, fmt: fmtCost },
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
      return `<tr>${cells}</tr>`;
    })
    .join("");
  panel.innerHTML = `<table class="table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function setRepoSort(key) {
  if (App.repoSort.key === key) App.repoSort.dir *= -1;
  else App.repoSort = { key, dir: key === "repoName" ? 1 : -1 };
  renderReposTable(App.repoRows);
}

// Today uses live per-repo totals from /api/state; other ranges use the
// pre-bucketed rollups exposed by /api/history (fewer columns available).
function renderReposFromState() {
  const repos = (App.state && App.state.repos) || [];
  App.repoRows = repos.map((r) => ({
    repoRoot: r.repoRoot,
    repoName: r.repoName || basename(r.repoRoot),
    activeMs: num(r.activeMs),
    prompts: r.prompts == null ? null : num(r.prompts),
    sessions: Array.isArray(r.sessions) ? r.sessions.length : typeof r.sessions === "number" ? r.sessions : null,
    tokensObj: r.tokens && typeof r.tokens === "object" ? r.tokens : null,
    tokensTotal: r.tokens == null ? null : sumTokens(r.tokens),
    byTool: r.byTool && typeof r.byTool === "object" ? r.byTool : null,
    toolsTotal: sumTools(r.byTool),
    cost: typeof r.cost === "number" ? r.cost : null,
    lastActive: r.lastActive || null,
  }));
  renderReposTable(App.repoRows);
}

function loadRepos() {
  if (App.repoRange === "today") {
    renderReposFromState();
    return;
  }
  api("/api/history?range=" + encodeURIComponent(App.repoRange))
    .then((h) => {
      App.repoRows = ((h && h.topRepos) || []).map((r) => ({
        repoRoot: r.repoRoot,
        repoName: r.repoName || basename(r.repoRoot),
        activeMs: num(r.activeMs),
        prompts: null,
        sessions: null,
        tokensObj: r.tokens && typeof r.tokens === "object" ? r.tokens : null,
        tokensTotal: r.tokens == null ? null : sumTokens(r.tokens),
        byTool: r.byTool && typeof r.byTool === "object" ? r.byTool : null,
        toolsTotal: sumTools(r.byTool),
        cost: typeof r.cost === "number" ? r.cost : null,
        lastActive: null,
      }));
      renderReposTable(App.repoRows);
    })
    .catch(() => {
      App.repoRows = [];
      renderReposTable([]);
    });
}

// ---- History view ----------------------------------------------------------

function drawHistory(h) {
  const perDay = (h && h.perDay) || [];
  const byHour = (h && h.byHour) || [];
  const topRepos = (h && h.topRepos) || [];

  lineChart(
    $("chartTokens"),
    [{ points: perDay.map((d) => ({ label: d.date, short: dayShort(d.date), value: sumTokens(d.tokens) })) }],
    { format: fmtTokens, empty: "No token history yet." }
  );
  barChart(
    $("chartTime"),
    perDay.map((d) => ({ label: d.date, short: dayShort(d.date), value: num(d.activeMs) })),
    { format: fmtDuration, color: "var(--series-2)", empty: "No activity yet." }
  );
  hourHeatmap(
    $("chartHour"),
    byHour.map((x) => ({ hour: x.hour, value: num(x.activeMs) })),
    { format: fmtDuration, empty: "No activity yet." }
  );
  barChart(
    $("chartRepos"),
    topRepos.map((r) => ({ label: r.repoName || basename(r.repoRoot), value: num(r.activeMs) })),
    { horizontal: true, format: fmtDuration, empty: "No repositories yet." }
  );
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
  const notifications = section(
    "Notifications",
    "OS notifications are emitted by the daemon, so they work whether or not this dashboard is open.",
    fieldRow("OS notifications", "Master toggle for desktop banners", sw("set-osNotifications", cfg.osNotifications)) +
      fieldRow("Notification sound", "Play the OS notification sound", sw("set-sound", cfg.sound)) +
      fieldRow("Session finished", "When a turn completes", sw("set-ev-sessionFinished", ev.sessionFinished)) +
      fieldRow("Needs input", "When a session is waiting on you", sw("set-ev-needsInput", ev.needsInput)) +
      fieldRow("Long-running prompt", "When a prompt exceeds the threshold below", sw("set-ev-longRunning", ev.longRunning)) +
      fieldRow("Turn failed", "When a turn ends on an error", sw("set-ev-turnFailed", ev.turnFailed))
  );

  const dashboard = section(
    "Dashboard",
    null,
    fieldRow("In-browser sounds", "Play Web Audio cues in this tab", sw("set-browserSounds", cfg.browserSounds)) +
      fieldRow(
        "Activity detail",
        "Arguments may contain paths/secrets — shown locally only",
        `<select class="select" id="set-activityDetail">
           <option value="tool" ${cfg.activityDetail === "tool" ? "selected" : ""}>Tool name only</option>
           <option value="args" ${cfg.activityDetail === "args" ? "selected" : ""}>Tool name + arguments</option>
         </select>`
      )
  );

  const behavior = section(
    "Thresholds & retention",
    null,
    fieldRow(
      "Long-running threshold",
      "Seconds before a prompt counts as long-running",
      `<input class="input" id="set-longRunningSec" type="number" min="0" step="1" value="${Math.round(num(cfg.longRunningThresholdMs) / 1000)}"><span class="chip">sec</span>`
    ) +
      fieldRow(
        "Retention",
        "Days of history to keep",
        `<input class="input" id="set-retentionDays" type="number" min="0" step="1" value="${num(cfg.retentionDays)}"><span class="chip">days</span>`
      ) +
      fieldRow(
        "Idle shutdown",
        "Hours idle before the daemon exits (0 = stay resident)",
        `<input class="input" id="set-idleShutdownHours" type="number" min="0" step="1" value="${num(cfg.idleShutdownHours)}"><span class="chip">hrs</span>`
      )
  );

  const costSection = section(
    "Cost estimation",
    "Rates are USD-equivalent per 1,000,000 tokens. Estimates only — not authoritative charges.",
    fieldRow("Show cost", "Estimate dollar cost from the rate table", sw("set-cost-enabled", cost.enabled)) +
      fieldRow("Currency", "Display currency code", `<input class="input input--wide" id="set-cost-currency" type="text" value="${esc(cost.currency || "USD")}">`) +
      ratesTableHTML(cost.rates)
  );

  return notifications + dashboard + behavior + costSection;
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
    // and a 0 here would e.g. persist retentionDays=0 and wipe all history.
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
    events: {
      sessionFinished: cb("set-ev-sessionFinished"),
      needsInput: cb("set-ev-needsInput"),
      longRunning: cb("set-ev-longRunning"),
      turnFailed: cb("set-ev-turnFailed"),
    },
    longRunningThresholdMs: Math.round(nv("set-longRunningSec", 300) * 1000),
    retentionDays: Math.round(nv("set-retentionDays", 90)),
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

function applyState(state) {
  if (!state) return;
  App.state = state;
  if (state.config) App.cfg = state.config;
  if (typeof state.now === "number") App.clockOffset = state.now - Date.now();
  detectSoundCues(state.sessions || []);
  renderLive();
  if (App.view === "repos" && App.repoRange === "today") renderReposFromState();
  if (App.view === "settings" && !App.settingsRendered) renderSettings();
}

// A config arrived out-of-band (SSE) or a save changed cost display; refresh the
// visible view. Settings is only re-rendered when the user isn't mid-edit.
function onConfigChanged() {
  renderLive();
  if (App.view === "repos" && App.repoRange === "today") renderReposFromState();
  if (App.view === "settings") maybeRenderSettings();
}

function setView(v) {
  App.view = v;
  document.querySelectorAll(".nav__tab").forEach((t) => t.classList.toggle("is-active", t.dataset.view === v));
  document.querySelectorAll(".view").forEach((sec) => sec.classList.toggle("is-active", sec.id === "view-" + v));
  if (v === "repos") loadRepos();
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
  // Per-browser Live sort preference (unknown value → "status"); reflect it in the toggle.
  try {
    const ls = localStorage.getItem("cockpit.liveSort");
    if (ls === "name" || ls === "status") App.liveSort = ls;
  } catch (_e) {
    /* localStorage unavailable — keep the default */
  }
  const sortBtn = $("liveSort").querySelector(`.range__btn[data-sort="${App.liveSort}"]`);
  if (sortBtn) setActiveRange("liveSort", sortBtn);

  $("nav").addEventListener("click", (e) => {
    const t = e.target.closest(".nav__tab");
    if (t) setView(t.dataset.view);
  });

  $("liveSort").addEventListener("click", (e) => {
    const b = e.target.closest(".range__btn");
    if (!b) return;
    setActiveRange("liveSort", b);
    App.liveSort = b.dataset.sort;
    try {
      localStorage.setItem("cockpit.liveSort", App.liveSort);
    } catch (_e) {
      /* persistence best-effort */
    }
    renderLive();
  });

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
    const th = e.target.closest("th[data-key]");
    if (th) setRepoSort(th.dataset.key);
  });

  // Delegated on the static #settings container so listeners survive innerHTML swaps.
  const sh = $("settings");
  sh.addEventListener("change", scheduleSave);
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
