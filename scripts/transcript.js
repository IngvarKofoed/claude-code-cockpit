'use strict';

// Version-tolerant token usage parser for a Claude Code session transcript
// (JSONL). Assistant message lines carry a `usage` object; the transcript
// format is INTERNAL to Claude Code and can change between releases, so this
// module tolerates unknown/missing fields, skips unparseable lines, and NEVER
// throws into the daemon — a missing/empty file just yields `ok: false`.

const fs = require('fs');

// Coerce anything non-finite (undefined, null, NaN, strings) to 0 so bad input
// can never throw or poison a sum.
function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

// The five token classes. cacheWrite is 5-minute-TTL cache writes, cacheWrite1h
// 1-hour-TTL ones — they bill at different rates (1.25x vs 2x input), so they are
// tracked apart. Kept as one list so a class can't be missed by a later edit.
const TOKEN_CLASSES = ['input', 'output', 'cacheRead', 'cacheWrite', 'cacheWrite1h'];

function emptyTokens() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 };
}

// The colour names Claude Code's /color accepts. `/color default` (and its reset
// aliases) records the literal 'default' instead, so anything outside this list —
// a reset, or a colour a later Claude Code adds — resolves to "no colour" rather
// than leaving a stale dot on the card. The dashboard maps these names to CSS, so
// the list also keeps an unexpected transcript value out of a style lookup.
const SESSION_COLORS = ['red', 'blue', 'green', 'yellow', 'purple', 'orange', 'pink', 'cyan'];

// Split cache-creation tokens by TTL. `cache_creation_input_tokens` is the total;
// the `cache_creation` sub-object breaks it into 5m/1h. Verified against real
// transcripts: total === 5m + 1h exactly. Version-tolerant per this module's
// contract — a transcript with no `cache_creation` object (an older Claude Code)
// puts everything in the 5m bucket, which is what the daemon already assumed. Any
// unexplained remainder also lands in 5m, so no token is ever dropped.
function splitCacheWrite(usage) {
  const total = num(usage.cache_creation_input_tokens);
  const cc = usage.cache_creation;
  if (!cc || typeof cc !== 'object') return { cacheWrite: total, cacheWrite1h: 0 };
  const h1 = num(cc.ephemeral_1h_input_tokens);
  const m5 = num(cc.ephemeral_5m_input_tokens);
  // `cache_creation_input_tokens` is authoritative for the SUM, so derive 5m as
  // the remainder: the two buckets then always add back up to it, whatever the
  // sub-object says. If the total is missing but the parts aren't, trust the parts
  // rather than reporting zero (the no-wrong-zero rule).
  if (total <= 0) return { cacheWrite: m5, cacheWrite1h: h1 };
  const capped1h = h1 > total ? total : h1;
  return { cacheWrite: total - capped1h, cacheWrite1h: capped1h };
}

// Parse one already-JSON-decoded transcript line into a usage entry, or null if
// the line carries no usage. Handles both a flat `{ usage, model, id/uuid }`
// shape and the real-transcript nested `{ message: { usage, model, id } }` wrap.
// `id` may come back null here; readUsage assigns a synthetic id in that case.
function parseUsageLine(obj) {
  if (!obj || typeof obj !== 'object') return null;

  const msg = obj.message && typeof obj.message === 'object' ? obj.message : null;
  const usage =
    obj.usage && typeof obj.usage === 'object'
      ? obj.usage
      : msg && msg.usage && typeof msg.usage === 'object'
        ? msg.usage
        : null;
  if (!usage) return null;

  const model = obj.model || (msg && msg.model) || null;
  // id fallback chain (synthetic index-based id is applied by readUsage).
  const id = obj.uuid || (msg && msg.id) || obj.requestId || null;
  // Per-message wall-clock time, so the daemon can attribute a back-read turn's
  // tokens to the day they were actually spent (not the ingest time). May be null.
  const ts = obj.timestamp || (msg && msg.timestamp) || obj.ts || null;
  // Sidechain = a subagent turn recorded in the parent transcript; may run on a
  // different model. Surfaced so the daemon can exclude it when choosing the
  // session's DISPLAYED model (a subagent's model isn't the session's model).
  const sidechain = obj.isSidechain === true;

  const cacheWrites = splitCacheWrite(usage);

  return {
    id,
    ts,
    model,
    sidechain,
    input: num(usage.input_tokens),
    output: num(usage.output_tokens),
    cacheRead: num(usage.cache_read_input_tokens),
    cacheWrite: cacheWrites.cacheWrite,
    cacheWrite1h: cacheWrites.cacheWrite1h,
  };
}

// Parse the whole transcript file, deduping assistant usage by message id so
// re-reads/resumes can't double-count. Returns per-message entries (so the
// daemon can detect NEW ids and write per-turn usage records idempotently),
// plus per-model and grand totals. `ok` is false only when the file is
// unreadable or empty — the daemon then marks tokens unavailable.
function readUsage(transcriptPath) {
  let content;
  try {
    content = fs.readFileSync(transcriptPath, 'utf8');
  } catch (_err) {
    // missing / unreadable -> ok:false
    return {
      messages: [],
      byModel: {},
      totals: emptyTokens(),
      cwd: null,
      title: null,
      color: null,
      ok: false,
    };
  }
  return readUsageContent(content);
}

// Parse already-read transcript CONTENT (the file's text). Split from readUsage so a
// caller that reads the file ASYNCHRONOUSLY — the Sessions list endpoint, which must not
// block the daemon's single event loop on a synchronous readFileSync of up to a page of
// whole transcripts — can reuse the exact same parsing. `ok` is false only for
// empty/whitespace content; the daemon then marks that session's tokens unavailable.
function readUsageContent(content) {
  // `cwd` is the session's working directory, captured from the first entry that
  // carries it — used by backfill to resolve which repo a whole transcript belongs
  // to (transcript filenames only carry the session id, not the cwd).
  const result = {
    messages: [],
    byModel: {},
    totals: emptyTokens(),
    cwd: null,
    title: null,
    color: null,
    ok: false,
  };

  if (!content || !content.trim()) return result; // empty -> ok:false
  result.ok = true;

  // The session name has two independent sources, tracked separately so precedence
  // doesn't depend on which line landed last: `ai-title` (Claude Code's generated
  // name, refined as the session grows) and `custom-title` (what the user set with
  // /rename). The user's name always wins — see the resolve below the loop.
  let aiTitle = null;
  let customTitle = null;
  // The session colour the user picked with /color. Unlike the two names there is
  // only one source, so the LAST line simply wins — including the 'default' a reset
  // writes, which is why this holds the raw value and is validated after the loop.
  let agentColor = null;

  const lines = content.split('\n');
  const seen = new Set();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    let obj;
    try {
      obj = JSON.parse(line);
    } catch (_err) {
      continue; // skip a malformed / torn line
    }

    if (result.cwd == null && typeof obj.cwd === 'string' && obj.cwd) result.cwd = obj.cwd;

    // Both name lines are re-emitted as the session grows, so the LAST one of each
    // kind wins. Blank text is treated as absent so a cleared name falls back to the
    // other source rather than blanking the card.
    if (obj.type === 'ai-title' && typeof obj.aiTitle === 'string' && obj.aiTitle.trim() !== '') {
      aiTitle = obj.aiTitle;
    } else if (
      obj.type === 'custom-title' &&
      typeof obj.customTitle === 'string' &&
      obj.customTitle.trim() !== ''
    ) {
      customTitle = obj.customTitle;
    } else if (
      obj.type === 'agent-color' &&
      typeof obj.agentColor === 'string' &&
      obj.agentColor.trim() !== ''
    ) {
      // Blank/absent is a malformed line, not a reset — ignoring it keeps the colour
      // the user actually chose. A real reset arrives as the literal 'default'.
      agentColor = obj.agentColor;
    }

    const parsed = parseUsageLine(obj);
    if (!parsed) continue; // no usage on this line

    // Synthetic id when the line has none, keyed by index so id-less lines stay
    // distinct rather than collapsing into one.
    const id = parsed.id != null ? String(parsed.id) : `__idx_${i}`;
    if (seen.has(id)) continue; // dedupe: count each id once
    seen.add(id);

    const entry = { ...parsed, id };
    result.messages.push(entry);

    const key = entry.model || 'unknown';
    const bucket = result.byModel[key] || (result.byModel[key] = emptyTokens());
    for (const k of TOKEN_CLASSES) {
      bucket[k] += entry[k];
      result.totals[k] += entry[k];
    }
  }

  // A name the user typed is intentional; the generated one is a guess. Prefer the
  // custom name whenever there is one, and leave title:null when neither source
  // appeared (the Sessions list renders that as "Untitled session").
  result.title = customTitle != null ? customTitle : aiTitle;

  // Only a name the dashboard can actually render becomes a colour; 'default' and
  // anything unrecognised leave it null, so the card shows no dot instead of a
  // stale or unmappable one.
  result.color = SESSION_COLORS.includes(agentColor) ? agentColor : null;

  return result;
}

// __testEmptyTokens is exported so a test can assert this module's token-class list
// still matches pricing.USAGE_KEYS — the lists are separate copies (these pure
// modules don't import pricing), and a drift would silently stop counting a class.
module.exports = { readUsage, readUsageContent, parseUsageLine, __testEmptyTokens: emptyTokens };
