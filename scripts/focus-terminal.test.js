'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  TERMINAL_IMAGES,
  parseTtyDevice,
  parseWindowPid,
  parseWtTabs,
  parseWindowList,
  parseFocusWindowResult,
  normalizeTabName,
  matchWtTabs,
  matchTerminalWindow,
  focusWindowScript,
  ttyForPid,
  windowPidForPid,
  focusTty,
  focusWindowPid,
  focusWtTab,
  resolveFocusTarget,
  focusTarget,
} = require('./focus-terminal');

// --- parseTtyDevice (pure `ps -o tty=` output parser) -------------------------

test('parseTtyDevice: a real terminal becomes its /dev path', () => {
  assert.strictEqual(parseTtyDevice('ttys004\n'), '/dev/ttys004');
});

test('parseTtyDevice: trailing whitespace from ps is tolerated', () => {
  // `ps -o tty= -p <pid>` pads its column — real observed output.
  assert.strictEqual(parseTtyDevice('ttys004 \n'), '/dev/ttys004');
});

test('parseTtyDevice: "??" (no controlling terminal) -> null', () => {
  // What a daemon or launchd agent reports — these sessions can never be focused.
  assert.strictEqual(parseTtyDevice('??\n'), null);
});

test('parseTtyDevice: empty / whitespace-only output -> null', () => {
  assert.strictEqual(parseTtyDevice(''), null);
  assert.strictEqual(parseTtyDevice('   \n'), null);
});

test('parseTtyDevice: output that is not a tty name -> null', () => {
  assert.strictEqual(parseTtyDevice('not a tty\n'), null);
});

test('parseTtyDevice: shell metacharacters are rejected, not passed through', () => {
  // Defence in depth: the value reaches osascript via argv (never a shell), but a
  // strict shape check means junk can't travel that far in the first place.
  assert.strictEqual(parseTtyDevice('ttys004; rm -rf /\n'), null);
  assert.strictEqual(parseTtyDevice('$(whoami)\n'), null);
});

test('parseTtyDevice: reads only the first line', () => {
  assert.strictEqual(parseTtyDevice('ttys004\nttys009\n'), '/dev/ttys004');
});

// --- ttyForPid (real `ps`, no mocks) -----------------------------------------

test('ttyForPid: a process with no controlling terminal resolves to null', async () => {
  // The test runner itself is not attached to a tty, so this exercises the real
  // `??` path end-to-end through an actual ps spawn.
  assert.strictEqual(await ttyForPid(process.pid), null);
});

test('ttyForPid: a pid that does not exist resolves to null', async () => {
  assert.strictEqual(await ttyForPid(0x7ffffff), null);
});

test('ttyForPid: a non-numeric pid resolves to null without spawning', async () => {
  assert.strictEqual(await ttyForPid('123; echo hi'), null);
  assert.strictEqual(await ttyForPid(null), null);
});

// --- focusTty (guards; the AppleScript itself is verified manually) ----------

test('focusTty: a malformed tty is refused before anything is spawned', async () => {
  const r = await focusTty('bogus');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'invalid-tty');
});

// --- parseWindowPid (pure ancestor-walk output parser) -----------------------

test('parseWindowPid: a window owner becomes its pid', () => {
  assert.strictEqual(parseWindowPid('pid=4242\n'), 4242);
});

test('parseWindowPid: trailing whitespace is tolerated', () => {
  assert.strictEqual(parseWindowPid('pid=4242 \r\n'), 4242);
});

test('parseWindowPid: "none" (no ancestor owns a window) -> null', () => {
  // A Windows service or any windowless host — these sessions can never be focused.
  assert.strictEqual(parseWindowPid('none\n'), null);
});

test('parseWindowPid: empty / non-matching output -> null', () => {
  assert.strictEqual(parseWindowPid(''), null);
  assert.strictEqual(parseWindowPid('   \n'), null);
  assert.strictEqual(parseWindowPid('Get-CimInstance : Access denied\n'), null);
});

test('parseWindowPid: pid 0 (the idle process) -> null', () => {
  assert.strictEqual(parseWindowPid('pid=0\n'), null);
});

test('parseWindowPid: a pid with anything appended is rejected, not truncated', () => {
  // Defence in depth: the value is re-validated before it reaches PowerShell, but a
  // strict shape check means junk can't travel that far in the first place.
  assert.strictEqual(parseWindowPid('pid=4242; calc.exe\n'), null);
  assert.strictEqual(parseWindowPid('pid=$(whoami)\n'), null);
});

test('parseWindowPid: reads only the first line', () => {
  assert.strictEqual(parseWindowPid('pid=4242\npid=9\n'), 4242);
});

// --- windowPidForPid / focusWindowPid (guards; PowerShell verified on Windows) ---

test('windowPidForPid: a non-numeric pid resolves to null without spawning', async () => {
  assert.strictEqual(await windowPidForPid('123; calc.exe'), null);
  assert.strictEqual(await windowPidForPid(null), null);
  assert.strictEqual(await windowPidForPid(0), null);
});

test('windowPidForPid: no powershell.exe on this platform resolves to null', async (t) => {
  if (process.platform === 'win32') return t.skip('powershell.exe exists here');
  // Exercises the real spawn-failure path: a missing binary is just "no window".
  assert.strictEqual(await windowPidForPid(process.pid), null);
});

test('focusWindowPid: an invalid pid is refused before anything is spawned', async () => {
  const r = await focusWindowPid(0);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'invalid-target');
});

test('parseFocusWindowResult: the raise script\'s three answers stay distinct', () => {
  // 'notfound' means the ancestor owns no window at all (a ConPTY client reports
  // MainWindowHandle = 0); 'failed' means the window exists and Windows would not raise
  // it. Collapsing them would tell a user "no terminal found" about a window they can see.
  assert.deepStrictEqual(parseFocusWindowResult('ok\n'), { ok: true });
  assert.deepStrictEqual(parseFocusWindowResult('notfound\n'), { ok: false, reason: 'no-window' });
  assert.deepStrictEqual(parseFocusWindowResult('failed\n'), {
    ok: false,
    reason: 'focus-refused',
  });
});

test('parseFocusWindowResult: a failed PowerShell run is not read as a refusal', () => {
  // runPowerShell resolves null when the spawn itself failed — distinct from a script
  // that ran and reported it could not raise the window.
  assert.deepStrictEqual(parseFocusWindowResult(null), {
    ok: false,
    reason: 'powershell-failed',
  });
  assert.deepStrictEqual(parseFocusWindowResult('unexpected garbage'), {
    ok: false,
    reason: 'focus-refused',
  });
});

test('focusWindowScript: only an integer pid is ever interpolated', () => {
  for (const bad of ['4242; calc.exe', 4242.5, -1, 0, null, undefined, '4242']) {
    assert.throws(() => focusWindowScript(bad), TypeError, String(bad));
  }
  assert.match(focusWindowScript(4242), /\$id = 4242\b/);
});

test('focusWindowScript: acquires foreground rights and CONFIRMS the raise', () => {
  // Both steps are load-bearing, and both were missing. A detached daemon has no
  // foreground rights, so SetForegroundWindow alone silently does nothing (measured:
  // returns false, window stays back) — the synthetic VK_LMENU tap is what grants them.
  // And the answer must come from GetForegroundWindow, not from a return value, or the
  // endpoint reports ok for a raise that never happened. Asserted here because a
  // "simplification" that drops either one restores a bug that looks like a dead button.
  const script = focusWindowScript(4242);
  assert.match(script, /keybd_event\(0xA4, 0, 0/);
  assert.match(script, /keybd_event\(0xA4, 0, 2/);
  assert.match(script, /GetForegroundWindow\(\) -eq \[int64\]\$h/);
});

// --- resolveFocusTarget / focusTarget (platform routing) ---------------------

test('resolveFocusTarget: a bogus pid resolves to null on every platform', async () => {
  assert.strictEqual(await resolveFocusTarget('123; calc.exe'), null);
  assert.strictEqual(await resolveFocusTarget(null), null);
});

test('focusTarget: a target of no known shape is refused', async () => {
  for (const bad of ['bogus', '', null, undefined, 42, 'pid:', 'pid:4242; calc.exe']) {
    const r = await focusTarget(bad);
    assert.strictEqual(r.ok, false, String(bad));
    assert.strictEqual(r.reason, 'invalid-target', String(bad));
  }
});

// --- matchTerminalWindow / parseWindowList (title -> terminal window) --------

const WINDOWS = [
  { pid: 32152, image: 'Tabby.exe', class: 'Chrome_WidgetWin_1', title: '✳ scrape naics data' },
  { pid: 40016, image: 'cmd.exe', class: 'ConsoleWindowClass', title: 'COCKPIT_TEST' },
  { pid: 36624, image: 'chrome.exe', class: 'Chrome_WidgetWin_1', title: '✳ scrape naics data' },
];

test('matchTerminalWindow: a uniquely titled terminal window matches, glyph notwithstanding', () => {
  const m = matchTerminalWindow(WINDOWS, '⠂ Scrape NAICS data');
  assert.strictEqual(m.reason, undefined);
  assert.strictEqual(m.win.pid, 32152);
});

test('matchTerminalWindow: a non-terminal window with the same title is NEVER the match', () => {
  // The whole reason the image allowlist exists: Tabby's window class is
  // Chrome_WidgetWin_1, identical to Chrome's, so class cannot tell them apart. A browser
  // tab named after the session must not be raised as if it were the terminal — and must
  // not make the real terminal look ambiguous either, which is why it is filtered first.
  const m = matchTerminalWindow(WINDOWS, '✳ scrape naics data');
  assert.strictEqual(m.reason, undefined);
  assert.strictEqual(m.win.image, 'Tabby.exe');

  const onlyBrowser = [WINDOWS[2]];
  assert.strictEqual(matchTerminalWindow(onlyBrowser, '✳ scrape naics data').reason, 'no-window');
});

test('matchTerminalWindow: two terminals with one title REFUSE rather than guess', () => {
  const twins = [
    { pid: 1, image: 'Tabby.exe', class: 'Chrome_WidgetWin_1', title: '✳ Claude Code' },
    { pid: 2, image: 'cmd.exe', class: 'ConsoleWindowClass', title: '✳ Claude Code' },
  ];
  const m = matchTerminalWindow(twins, '✳ Claude Code');
  assert.strictEqual(m.reason, 'ambiguous-window');
  assert.strictEqual(m.count, 2);
  assert.strictEqual(m.win, undefined);
});

test('matchTerminalWindow: the image test is case-insensitive', () => {
  // Get-Process reports ProcessName with the OS's casing, which varies by image.
  const win = [{ pid: 9, image: 'TABBY.EXE', class: 'X', title: 'work' }];
  assert.strictEqual(matchTerminalWindow(win, 'work').win.pid, 9);
});

test('matchTerminalWindow: an empty title reports no-title, never a match', () => {
  for (const bad of ['', '   ', null, undefined]) {
    assert.strictEqual(matchTerminalWindow(WINDOWS, bad).reason, 'no-title');
  }
});

test('matchTerminalWindow: a non-array window list is tolerated', () => {
  assert.strictEqual(matchTerminalWindow(null, 'work').reason, 'no-window');
  assert.strictEqual(matchTerminalWindow(undefined, 'work').reason, 'no-window');
});

test('parseWindowList: reads the enumeration JSON', () => {
  const out = parseWindowList('[{"pid":32152,"image":"Tabby.exe","class":"Chrome_WidgetWin_1","title":"x"}]');
  assert.deepStrictEqual(out, [
    { pid: 32152, image: 'Tabby.exe', class: 'Chrome_WidgetWin_1', title: 'x' },
  ]);
});

test('parseWindowList: a lone object (PowerShell drops the array) still reads as one window', () => {
  assert.strictEqual(parseWindowList('{"pid":7,"image":"cmd.exe","class":"c","title":"t"}').length, 1);
});

test('parseWindowList: malformed entries are dropped, not thrown on', () => {
  const out = parseWindowList('[{"pid":0},{"pid":-1},{"pid":"x"},null,7,{"pid":5}]');
  assert.deepStrictEqual(out, [{ pid: 5, image: '', class: '', title: '' }]);
});

test('parseWindowList: unparseable or empty output is an empty list', () => {
  for (const bad of ['', '   ', 'not json', null, undefined]) {
    assert.deepStrictEqual(parseWindowList(bad), []);
  }
});

test('TERMINAL_IMAGES: browsers and editors are not on the allowlist', () => {
  // A regression guard on the rule, not the list: adding a general-purpose app here would
  // let any window titled like the session be raised as the terminal.
  for (const img of ['chrome.exe', 'msedge.exe', 'firefox.exe', 'code.exe', 'explorer.exe']) {
    assert.ok(!TERMINAL_IMAGES.has(img), img);
  }
  assert.ok(TERMINAL_IMAGES.has('tabby.exe'));
});

test('focusTarget: routes on the target SHAPE, not the running platform', async () => {
  // A snapshot carried between machines must not hand a tty to the Windows path (or a
  // window pid to osascript) — the off-platform branch reports unsupported-platform,
  // which also proves the routing without raising a real window on the dev machine.
  const foreign = process.platform === 'darwin' ? 'pid:4242' : '/dev/ttys004';
  const r = await focusTarget(foreign);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'unsupported-platform');
});

// --- normalizeTabName (pure) --------------------------------------------------

test('normalizeTabName: strips the animated status glyph Claude Code prefixes', () => {
  // The spinner frame differs between reads of the same tab, so it must not affect a match.
  assert.strictEqual(normalizeTabName('⠂ testing'), 'testing');
  assert.strictEqual(normalizeTabName('⠐ testing'), 'testing');
  assert.strictEqual(normalizeTabName('✳ Claude Code'), 'claude code');
});

test('normalizeTabName: casefolds and collapses whitespace', () => {
  assert.strictEqual(normalizeTabName('  My   Session  '), 'my session');
});

test('normalizeTabName: a non-string is empty, never a throw', () => {
  for (const bad of [null, undefined, 42, {}]) assert.strictEqual(normalizeTabName(bad), '');
});

test('normalizeTabName: leading punctuation is stripped from BOTH sides, so it still matches', () => {
  // Stripping is lossy, but it is applied to the tab name and the session title alike,
  // so a title that genuinely starts with punctuation still compares equal to its tab.
  assert.strictEqual(normalizeTabName('[wip] fix'), normalizeTabName('⠂ [wip] fix'));
});

// --- matchWtTabs (pure) -------------------------------------------------------

const TABS = [
  { hwnd: 263814, index: 0, name: '⠂ testing' },
  { hwnd: 263814, index: 1, name: '✳ Claude Code' },
  { hwnd: 2032158, index: 0, name: '✳ Claude Code' },
];

test('matchWtTabs: a uniquely named tab matches, spinner frame notwithstanding', () => {
  const r = matchWtTabs(TABS, 'testing');
  assert.deepStrictEqual(r.tab, { hwnd: 263814, index: 0, name: '⠂ testing' });
  assert.strictEqual(r.reason, undefined);
});

test('matchWtTabs: duplicate names REFUSE rather than guess', () => {
  // Two un-renamed sessions both read "Claude Code". Raising either would be a coin
  // flip, and raising the wrong terminal is worse than raising none.
  const r = matchWtTabs(TABS, 'Claude Code');
  assert.strictEqual(r.tab, undefined);
  assert.strictEqual(r.reason, 'ambiguous-tab');
  assert.strictEqual(r.count, 2);
});

test('matchWtTabs: no tab by that name reports no-window', () => {
  assert.strictEqual(matchWtTabs(TABS, 'nothing-here').reason, 'no-window');
});

test('matchWtTabs: an empty or missing title reports no-title, not a match', () => {
  for (const bad of ['', '   ', null, undefined]) {
    assert.strictEqual(matchWtTabs(TABS, bad).reason, 'no-title', String(bad));
  }
});

test('matchWtTabs: a non-array tab list is tolerated', () => {
  assert.strictEqual(matchWtTabs(null, 'testing').reason, 'no-window');
});

// --- parseWtTabs (pure) -------------------------------------------------------

test('parseWtTabs: reads the enumeration JSON', () => {
  const out = parseWtTabs('[{"hwnd":263814,"index":0,"name":"⠂ testing"}]');
  assert.deepStrictEqual(out, [{ hwnd: 263814, index: 0, name: '⠂ testing' }]);
});

test('parseWtTabs: a lone object (PowerShell drops the array) still reads as one tab', () => {
  const out = parseWtTabs('{"hwnd":263814,"index":0,"name":"x"}');
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].hwnd, 263814);
});

test('parseWtTabs: malformed entries are dropped, not thrown on', () => {
  const out = parseWtTabs(
    '[{"hwnd":0,"index":0,"name":"bad hwnd"},{"hwnd":5,"index":-1,"name":"bad index"},' +
      '{"hwnd":5,"index":0,"name":"good"},null,7]',
  );
  assert.deepStrictEqual(out, [{ hwnd: 5, index: 0, name: 'good' }]);
});

test('parseWtTabs: unparseable or empty output is an empty list', () => {
  for (const bad of ['', '   ', 'not json', null, undefined]) {
    assert.deepStrictEqual(parseWtTabs(bad), [], String(bad));
  }
});

// --- wt: target routing -------------------------------------------------------

test('focusTarget: a wt: target routes to the Windows Terminal tab path', async (t) => {
  if (process.platform === 'win32') {
    return t.skip('would enumerate (and possibly raise) real tabs on this machine');
  }
  const r = await focusTarget('wt:some session');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'unsupported-platform');
});

test('focusTarget: an empty wt: target is not a valid shape', async () => {
  const r = await focusTarget('wt:');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'invalid-target');
});

test('focusWtTab: off-Windows reports unsupported-platform without enumerating', async (t) => {
  if (process.platform === 'win32') return t.skip('would enumerate real tabs here');
  const r = await focusWtTab('anything');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'unsupported-platform');
});
