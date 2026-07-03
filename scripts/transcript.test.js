'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readUsage, parseUsageLine } = require('./transcript');

// Write the given JSONL lines to a fresh temp transcript file and return its path.
function writeFixture(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-transcript-'));
  const file = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(file, lines.join('\n'));
  return file;
}

// --- parseUsageLine (pure line parser) ---------------------------------------

test('parseUsageLine: flat usage shape maps every field', () => {
  const out = parseUsageLine({
    uuid: 'a1',
    model: 'claude-sonnet-5',
    usage: {
      input_tokens: 10,
      output_tokens: 20,
      cache_creation_input_tokens: 5,
      cache_read_input_tokens: 3,
    },
  });
  assert.deepStrictEqual(out, {
    id: 'a1',
    model: 'claude-sonnet-5',
    input: 10,
    output: 20,
    cacheRead: 3,
    cacheWrite: 5,
  });
});

test('parseUsageLine: nested message.usage shape', () => {
  const out = parseUsageLine({
    message: {
      id: 'm1',
      model: 'claude-opus-4-8',
      usage: { input_tokens: 1, output_tokens: 2 },
    },
  });
  assert.strictEqual(out.id, 'm1');
  assert.strictEqual(out.model, 'claude-opus-4-8');
  assert.strictEqual(out.input, 1);
  assert.strictEqual(out.output, 2);
  assert.strictEqual(out.cacheRead, 0); // missing -> 0
  assert.strictEqual(out.cacheWrite, 0);
});

test('parseUsageLine: id fallback chain (uuid > message.id > requestId)', () => {
  assert.strictEqual(parseUsageLine({ requestId: 'r1', usage: { input_tokens: 3 } }).id, 'r1');
  assert.strictEqual(
    parseUsageLine({ uuid: 'u', message: { id: 'm' }, usage: { input_tokens: 1 } }).id,
    'u',
  );
});

test('parseUsageLine: no usage -> null; bad input -> null', () => {
  assert.strictEqual(parseUsageLine({ type: 'user', message: { role: 'user' } }), null);
  assert.strictEqual(parseUsageLine(null), null);
  assert.strictEqual(parseUsageLine('nope'), null);
});

test('parseUsageLine: missing token fields default to 0, missing model -> null', () => {
  const out = parseUsageLine({ uuid: 'x', usage: { input_tokens: 7 } });
  assert.deepStrictEqual(out, {
    id: 'x',
    model: null,
    input: 7,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  });
});

// --- readUsage (whole file) --------------------------------------------------

test('readUsage: parses mixed transcript, skipping malformed and no-usage lines', () => {
  const file = writeFixture([
    JSON.stringify({ type: 'user', message: { role: 'user' } }), // no usage -> skip
    JSON.stringify({
      uuid: 'a',
      model: 'claude-sonnet-5',
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 10,
        cache_read_input_tokens: 5,
      },
    }),
    '{ this is : not json', // malformed -> skip
    JSON.stringify({
      message: { id: 'b', model: 'claude-opus-4-8', usage: { input_tokens: 200, output_tokens: 80 } },
    }),
    '', // blank -> skip
  ]);

  const r = readUsage(file);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.messages.length, 2);
  assert.deepStrictEqual(r.totals, { input: 300, output: 130, cacheRead: 5, cacheWrite: 10 });
  assert.strictEqual(r.byModel['claude-sonnet-5'].input, 100);
  assert.strictEqual(r.byModel['claude-sonnet-5'].cacheWrite, 10);
  assert.strictEqual(r.byModel['claude-opus-4-8'].input, 200);
});

test('readUsage: duplicate message id counted once', () => {
  const dup = JSON.stringify({
    uuid: 'same',
    model: 'claude-sonnet-5',
    usage: { input_tokens: 10, output_tokens: 1 },
  });
  const r = readUsage(writeFixture([dup, dup]));
  assert.strictEqual(r.messages.length, 1);
  assert.strictEqual(r.totals.input, 10);
});

test('readUsage: id-less lines get distinct synthetic ids (not merged)', () => {
  const file = writeFixture([
    JSON.stringify({ model: 'm', usage: { input_tokens: 1 } }),
    JSON.stringify({ model: 'm', usage: { input_tokens: 2 } }),
  ]);
  const r = readUsage(file);
  assert.strictEqual(r.messages.length, 2);
  assert.strictEqual(r.totals.input, 3);
});

test('readUsage: missing file -> ok:false with empty totals', () => {
  const missing = path.join(os.tmpdir(), `cockpit-nope-${Date.now()}.jsonl`);
  const r = readUsage(missing);
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(r.messages, []);
  assert.deepStrictEqual(r.byModel, {});
  assert.deepStrictEqual(r.totals, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
});

test('readUsage: empty / whitespace-only file -> ok:false', () => {
  const r = readUsage(writeFixture(['', '   ']));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.messages.length, 0);
});
