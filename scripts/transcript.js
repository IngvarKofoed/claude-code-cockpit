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

function emptyTokens() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
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

  return {
    id,
    ts,
    model,
    sidechain,
    input: num(usage.input_tokens),
    output: num(usage.output_tokens),
    cacheRead: num(usage.cache_read_input_tokens),
    cacheWrite: num(usage.cache_creation_input_tokens),
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
    return { messages: [], byModel: {}, totals: emptyTokens(), cwd: null, title: null, ok: false };
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
  const result = { messages: [], byModel: {}, totals: emptyTokens(), cwd: null, title: null, ok: false };

  if (!content || !content.trim()) return result; // empty -> ok:false
  result.ok = true;

  // The session name has two independent sources, tracked separately so precedence
  // doesn't depend on which line landed last: `ai-title` (Claude Code's generated
  // name, refined as the session grows) and `custom-title` (what the user set with
  // /rename). The user's name always wins — see the resolve below the loop.
  let aiTitle = null;
  let customTitle = null;

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
    for (const k of ['input', 'output', 'cacheRead', 'cacheWrite']) {
      bucket[k] += entry[k];
      result.totals[k] += entry[k];
    }
  }

  // A name the user typed is intentional; the generated one is a guess. Prefer the
  // custom name whenever there is one, and leave title:null when neither source
  // appeared (the Sessions list renders that as "Untitled session").
  result.title = customTitle != null ? customTitle : aiTitle;

  return result;
}

module.exports = { readUsage, readUsageContent, parseUsageLine };
