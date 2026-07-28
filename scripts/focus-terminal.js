'use strict';

// Raise the terminal window — and on Windows Terminal, the exact TAB — hosting a
// given Claude Code session.
//
// Four chains behind one interface. Each produces an opaque focus TARGET string
// the daemon stores per session; the browser only ever posts a sessionId.
//
//   macOS      ownerPid -> `ps -o tty=` -> `/dev/ttysNNN` -> the Terminal tab whose
//              `tty` matches -> select the tab, raise its window, activate the app.
//              Terminal.app only; iTerm2, Ghostty and any multiplexer find no match.
//   Windows    session TITLE -> enumerate Windows Terminal tabs via UI Automation ->
//   (WT tab)   the TabItem whose name matches -> SelectionItemPattern.Select() ->
//              raise the window. Tab-exact, INCLUDING a background tab.
//   Windows    ownerPid -> walk `Win32_Process` parents to the first ancestor that
//   (window)   owns a window -> `pid:<n>` -> restore if minimized, then raise.
//              For hosts that ARE in the process tree: a CLASSIC console window
//              (cmd.exe / powershell.exe hosted by conhost, i.e. any machine whose
//              default terminal is the Windows Console Host) and a VS Code integrated
//              terminal. Window-level, not tab-level.
//   Windows    session TITLE -> enumerate visible titled top-level windows -> keep those
//   (by title) owned by a TERMINAL_IMAGES process -> the one whose title matches ->
//              that window's `pid:<n>`. LAST RESORT, for a terminal that offers no other
//              key at all (Tabby: no UIA tabs, no reachable ancestry). Window-level.
//
// Why the Windows path is title-keyed rather than process-keyed: under the Windows 11
// default-terminal handoff the console is reparented to `WindowsTerminal.exe` under
// `svchost.exe`, so the window is NOT in the session's process tree in either
// direction (measured: claude.exe -> cmd.exe -> explorer.exe, every one reporting
// MainWindowHandle = 0). UI Automation is the only interface that both enumerates
// background tabs and can select one. It exposes no link back to the hosted shell
// — every TabItem reports the WindowsTerminal.exe pid — so the tab NAME is the only
// available join key, and Claude Code writes the session name into it.
//
// That is specific to the HANDOFF, not to consoles in general. A classic console window
// is owned by its console CLIENT (measured: cmd.exe reporting a real ConsoleWindowClass
// MainWindowHandle, while its conhost.exe child reports 0), and that client is a plain
// ancestor — so the window walk reaches it and the `pid:` target covers those sessions.
//
// Consequence, deliberate and surfaced to the user rather than guessed around: two
// sessions showing the same tab name (notably two un-renamed sessions, which both
// read "Claude Code") are indistinguishable. That resolves to `ambiguous-tab`, never
// to a coin-flip — raising the wrong terminal is worse than raising none.
//
// Nothing here ever takes a value from the browser. The daemon passes state it
// already holds, and each target is shape-checked before it reaches an OS command:
// the tty travels to osascript through argv, and every Windows script is fixed text
// with integer-validated numbers interpolated in, handed over as base64
// `-EncodedCommand` (no shell, and no command-line quoting to get wrong).

const { execFile } = require('node:child_process');
const winproc = require('./winproc');

// macOS terminal device names: ttys000, ttys004, ... Deliberately strict — anything
// that isn't this shape is treated as "no terminal" rather than passed along.
const TTY_NAME = /^tty[a-z]*[0-9]+$/;
const TTY_DEVICE = /^\/dev\/tty[a-z]*[0-9]+$/;
// Windows window-level targets are the window-owning pid. Bounded length so a junk
// value can't grow unboundedly on its way to Number().
const WINDOW_TARGET = /^pid:([0-9]{1,10})$/;
// Windows Terminal tab targets carry the session title to match on. The title is
// free text, so it is never interpolated into a script — it is compared in JS
// against the enumerated tab names.
const WT_TARGET = /^wt:([\s\S]+)$/;

// UIA class name of a Windows Terminal top-level window.
const WT_WINDOW_CLASS = 'CASCADIA_HOSTING_WINDOW_CLASS';

// Terminal emulators whose top-level window may be matched BY TITLE (see
// terminalWindowPidForTitle). An allowlist, not a denylist, and deliberately so: the
// match key is a session title, and window CLASS cannot vouch for a terminal — Tabby is
// `Chrome_WidgetWin_1`, the same class as every Chrome window. Without this an open
// browser tab or document window sharing the session's name would be raised as if it
// were the terminal. A terminal missing from this list simply gets no button, which is
// the honest failure this project prefers; add to it rather than loosening the rule.
const TERMINAL_IMAGES = new Set([
  'tabby.exe',
  'windowsterminal.exe',
  'cmd.exe',
  'powershell.exe',
  'pwsh.exe',
  'conhost.exe',
  'openconsole.exe',
  'alacritty.exe',
  'wezterm-gui.exe',
  'kitty.exe',
  'conemu.exe',
  'conemu64.exe',
  'mintty.exe',
  'hyper.exe',
]);

// Claude Code prefixes the tab title with a status glyph and a space ("⠂ testing",
// "✳ Claude Code"), and the glyph animates while a turn runs. Strip any leading run
// of non-letter/non-digit characters so a match doesn't depend on which frame of the
// spinner was showing. Applied to BOTH sides of the comparison, so stripping a title
// that genuinely starts with punctuation is harmless — both sides lose it.
const TAB_PREFIX = /^[^\p{L}\p{N}]+/u;

const MAX_HWND = 0x7fffffff;

// Per-call PowerShell budgets. Kept well inside the daemon's overall focus deadline so
// a chain of these still returns an answer to the browser rather than an open fetch.
const LIST_TIMEOUT_MS = 8000;
const SELECT_TIMEOUT_MS = 8000;
const WINDOW_TIMEOUT_MS = 8000;

// The AppleScript is a single `on run argv` handler so the tty arrives as an argument
// rather than interpolated into the source. `tty of tab` reports the full /dev path.
const FOCUS_SCRIPT = `on run argv
  set target to item 1 of argv
  tell application "Terminal"
    repeat with w in windows
      repeat with t in tabs of w
        try
          if (tty of t as text) is target then
            set selected tab of w to t
            set frontmost of w to true
            activate
            return "ok"
          end if
        end try
      end repeat
    end repeat
  end tell
  return "notfound"
end run`;

// Common preamble for the UIA scripts. UTF-8 output matters: tab names carry the
// status glyph and may carry a non-ASCII session name, and the default console
// codepage would mangle both on the way back to Node.
const UIA_PREAMBLE = `$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$tabType = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::TabItem)`;

// Enumerate every Windows Terminal tab as {hwnd, index, name}. Index is the tab's
// position within its window, which is how selectWtTabScript addresses it back.
const LIST_WT_TABS_SCRIPT = `${UIA_PREAMBLE}
$cond = New-Object System.Windows.Automation.PropertyCondition($AE::ClassNameProperty, '${WT_WINDOW_CLASS}')
$wins = $AE::RootElement.FindAll($TS::Children, $cond)
$out = @()
foreach ($w in $wins) {
  $h = [int64]$w.Current.NativeWindowHandle
  if ($h -le 0) { continue }
  $tabs = $w.FindAll($TS::Descendants, $tabType)
  for ($i = 0; $i -lt $tabs.Count; $i++) {
    $out += [pscustomobject]@{ hwnd = $h; index = $i; name = [string]$tabs.Item($i).Current.Name }
  }
}
ConvertTo-Json -Compress -Depth 3 -InputObject @($out)`;

// Select tab `index` of the WT window owning `hwnd`, then bring that window forward.
//
// The selection is CONFIRMED before returning, not fired and forgotten. Windows
// Terminal processes the UIA request on its own UI thread, so a script that called
// Select() and exited immediately could die before the tab actually changed — a miss
// observed once in testing, where the window came forward still showing the previous
// tab. Polling IsSelected (with one re-issue partway) makes it deterministic.
//
// SwitchToThisWindow is the raise fallback rather than WScript.Shell's AppActivate
// because it is addressed by HWND: one WindowsTerminal.exe process owns every WT
// window, so a pid-addressed fallback could raise a different window than the one we
// just selected a tab in.
function selectWtTabScript(hwnd, index) {
  if (!Number.isInteger(hwnd) || hwnd <= 0 || hwnd > MAX_HWND) {
    throw new TypeError('hwnd must be a positive 32-bit integer');
  }
  if (!Number.isInteger(index) || index < 0) throw new TypeError('index must be a non-negative integer');
  return `${UIA_PREAMBLE}
Add-Type -Namespace Cockpit -Name Native -MemberDefinition @"
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
[DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr h, bool alt);
"@
$cond = New-Object System.Windows.Automation.PropertyCondition($AE::NativeWindowHandleProperty, ${hwnd})
$w = $AE::RootElement.FindFirst($TS::Children, $cond)
if (-not $w) { Write-Output 'notfound'; exit 0 }
$tabs = $w.FindAll($TS::Descendants, $tabType)
if (${index} -ge $tabs.Count) { Write-Output 'notfound'; exit 0 }
$tab = $tabs.Item(${index})
# The tab list was enumerated by a SEPARATE earlier invocation, so this index could now
# point at a different session's tab (one closed or reordered in between). Re-check the
# name before selecting — raising the wrong terminal is worse than raising none, the same
# rule that drives the ambiguous-tab refusal. The expected name arrives through the
# ENVIRONMENT, never interpolated: a session title is free text.
# Substring + case-insensitive because the leading status glyph animates between reads.
if ($env:COCKPIT_TAB_NAME) {
  $seen = [string]$tab.Current.Name
  if ($seen.IndexOf($env:COCKPIT_TAB_NAME, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
    Write-Output 'stale'; exit 0
  }
}
$selPattern = [System.Windows.Automation.SelectionItemPattern]::Pattern
$sel = $tab.GetCurrentPattern($selPattern)
if (-not $sel) { Write-Output 'notfound'; exit 0 }
$sel.Select()
$selected = $false
for ($i = 0; $i -lt 20; $i++) {
  if ($tab.GetCurrentPattern($selPattern).Current.IsSelected) { $selected = $true; break }
  Start-Sleep -Milliseconds 50
  if ($i -eq 9) { $sel.Select() }
}
$h = [IntPtr]${hwnd}
if ([Cockpit.Native]::IsIconic($h)) { [void][Cockpit.Native]::ShowWindow($h, 9) }
if (-not [Cockpit.Native]::SetForegroundWindow($h)) { [Cockpit.Native]::SwitchToThisWindow($h, $true) }
if ($selected) { Write-Output 'ok' } else { Write-Output 'notselected' }`;
}

// Enumerate every VISIBLE, TITLED top-level window as {pid, image, class, title}.
//
// This is the last-resort join key on Windows, for a terminal that offers no other: no
// UIA tab list (Tabby exposes a single Pane — Chromium's accessibility tree is absent, so
// there is nothing to select) and no reachable process ancestry. It is window-level only;
// a background tab in such a terminal emits no signal at all and stays unfocusable.
//
// `GetWindowTextW` (not the ANSI entry point) because a session title is free text and
// may be non-ASCII, and the enumeration is UTF-8 on the way back to Node for the same
// reason. Only titled windows are collected: an untitled one can never match.
const LIST_WINDOWS_SCRIPT = `$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -Namespace Cockpit -Name Win -MemberDefinition @"
public delegate bool EnumProc(System.IntPtr h, System.IntPtr p);
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, System.IntPtr p);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr h, out uint pid);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(System.IntPtr h);
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(System.IntPtr h, System.Text.StringBuilder s, int n);
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(System.IntPtr h, System.Text.StringBuilder s, int n);
"@
$out = New-Object System.Collections.ArrayList
$cb = [Cockpit.Win+EnumProc]{
  param($h, $lp)
  if ([Cockpit.Win]::IsWindowVisible($h)) {
    $wt = New-Object System.Text.StringBuilder 512
    if ([Cockpit.Win]::GetWindowTextW($h, $wt, 512) -gt 0) {
      $owner = 0; [void][Cockpit.Win]::GetWindowThreadProcessId($h, [ref]$owner)
      $cn = New-Object System.Text.StringBuilder 128; [void][Cockpit.Win]::GetClassName($h, $cn, 128)
      $p = Get-Process -Id $owner -ErrorAction SilentlyContinue
      [void]$out.Add([pscustomobject]@{
        pid = [int]$owner
        image = if ($p) { $p.ProcessName + '.exe' } else { '' }
        class = $cn.ToString()
        title = $wt.ToString()
      })
    }
  }
  return $true
}
[void][Cockpit.Win]::EnumWindows($cb, [System.IntPtr]::Zero)
ConvertTo-Json -Compress -Depth 3 -InputObject @($out)`;

// Parse the window enumeration's JSON. Same tolerance as parseWtTabs: PowerShell's
// single-element-becomes-an-object quirk, and any malformed entry dropped rather than
// thrown on, so a shape change degrades to "no windows".
function parseWindowList(stdout) {
  if (typeof stdout !== 'string' || !stdout.trim()) return [];
  let data;
  try {
    data = JSON.parse(stdout);
  } catch (_e) {
    return [];
  }
  if (data && !Array.isArray(data)) data = [data];
  if (!Array.isArray(data)) return [];
  const out = [];
  for (const w of data) {
    if (!w || typeof w !== 'object') continue;
    const pid = Number(w.pid);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    out.push({
      pid,
      image: typeof w.image === 'string' ? w.image : '',
      class: typeof w.class === 'string' ? w.class : '',
      title: typeof w.title === 'string' ? w.title : '',
    });
  }
  return out;
}

// Pick the terminal window whose title is `title`. Returns { win } on a unique hit, else
// { reason } — the same vocabulary and the same refusals as matchWtTabs, because it is the
// same gamble: 'no-title', 'no-window', or 'ambiguous-window' when several match and
// guessing between them could raise another session's terminal.
//
// Non-terminal windows are filtered out BEFORE the ambiguity count, so a browser tab
// sharing the session's name neither wins nor blocks a real terminal match.
function matchTerminalWindow(windows, title) {
  const want = normalizeTabName(title);
  if (!want) return { reason: 'no-title' };
  const hits = (Array.isArray(windows) ? windows : []).filter(
    (w) =>
      w &&
      TERMINAL_IMAGES.has(String(w.image).toLowerCase()) &&
      normalizeTabName(w.title) === want,
  );
  if (hits.length === 0) return { reason: 'no-window' };
  if (hits.length > 1) return { reason: 'ambiguous-window', count: hits.length };
  return { win: hits[0] };
}

// Enumerate titled top-level windows. Resolves null when the probe itself failed, kept
// distinct from an empty array ("nothing is titled / no terminal is up") — the same
// contract as listWtTabs, so a failed probe is never cached as a definite absence.
function listWindows() {
  if (process.platform !== 'win32') return Promise.resolve([]);
  return winproc
    .runPowerShell(LIST_WINDOWS_SCRIPT, LIST_TIMEOUT_MS)
    .then((stdout) => (stdout == null ? null : parseWindowList(stdout)));
}

// Resolve the pid owning the terminal window titled `title`, or null.
//
// The answer is a PID on purpose, not an hwnd: it feeds the existing `pid:` target, so
// the raise, its confirmation and its tests are all the already-proven ones, and this
// adds a resolution step rather than a fourth target shape. Windows recycles hwnds as
// readily as pids, so caching one would buy no safety — and the `pid:` target's reuse
// window is already a documented, bounded limit.
function terminalWindowPidForTitle(title) {
  return listWindows().then((windows) => {
    if (windows == null) return null;
    const m = matchTerminalWindow(windows, title);
    return m.win ? m.win.pid : null;
  });
}

// Parse `ps -o tty= -p <pid>` output into a /dev path, or null when the process has no
// controlling terminal. ps prints `??` for that case and pads the column with spaces.
function parseTtyDevice(stdout) {
  if (typeof stdout !== 'string') return null;
  const first = stdout.split('\n')[0].trim();
  if (!first || first === '??') return null;
  if (!TTY_NAME.test(first)) return null;
  return '/dev/' + first;
}

// Parse the ancestor walk's output into a pid, or null for `none` / anything unexpected.
const parseWindowPid = winproc.parsePidOutput;

// Parse the tab enumeration's JSON into a clean array. Tolerates PowerShell's
// single-element-becomes-an-object quirk and drops any malformed entry, so a shape
// change in a future WT/UIA release degrades to "no tabs", never a throw.
function parseWtTabs(stdout) {
  if (typeof stdout !== 'string' || !stdout.trim()) return [];
  let data;
  try {
    data = JSON.parse(stdout);
  } catch (_e) {
    return [];
  }
  if (data && !Array.isArray(data)) data = [data];
  if (!Array.isArray(data)) return [];
  const out = [];
  for (const t of data) {
    if (!t || typeof t !== 'object') continue;
    const hwnd = Number(t.hwnd);
    const index = Number(t.index);
    if (!Number.isInteger(hwnd) || hwnd <= 0 || hwnd > MAX_HWND) continue;
    if (!Number.isInteger(index) || index < 0) continue;
    out.push({ hwnd, index, name: typeof t.name === 'string' ? t.name : '' });
  }
  return out;
}

// Normalize a tab name or session title for comparison: drop the leading status
// glyph, collapse whitespace, casefold.
function normalizeTabName(name) {
  if (typeof name !== 'string') return '';
  return name.replace(TAB_PREFIX, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

// Pick the tab matching `title`. Returns { tab } on a unique hit, else
// { reason } — 'no-title' (nothing to match on), 'no-window' (no tab by that
// name), or 'ambiguous-tab' (several, so the caller must not guess).
function matchWtTabs(tabs, title) {
  const want = normalizeTabName(title);
  if (!want) return { reason: 'no-title' };
  const hits = (Array.isArray(tabs) ? tabs : []).filter(
    (t) => normalizeTabName(t && t.name) === want,
  );
  if (hits.length === 0) return { reason: 'no-window' };
  if (hits.length > 1) return { reason: 'ambiguous-tab', count: hits.length };
  return { tab: hits[0] };
}

// Resolve a pid's controlling terminal. Never rejects — an unknown pid, a dead process,
// or a missing `ps` are all just "no terminal", which the caller renders as not-focusable.
function ttyForPid(pid) {
  return new Promise((resolve) => {
    if (!Number.isInteger(pid) || pid <= 0) return resolve(null);
    execFile('ps', ['-o', 'tty=', '-p', String(pid)], (err, stdout) => {
      if (err) return resolve(null);
      resolve(parseTtyDevice(stdout));
    });
  });
}

// Resolve the pid of the first ancestor owning a window, or null (a service, a session
// under a windowless host). Never rejects, for the same reason as ttyForPid.
function windowPidForPid(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve(null);
  return winproc
    .runPowerShell(winproc.ancestorWalkScript(pid), 10000)
    .then(parseWindowPid);
}

// Enumerate Windows Terminal tabs. Resolves null when the probe itself failed
// (no PowerShell, no UIA assemblies) — kept distinct from an empty array, which
// honestly means "WT is running no tabs / isn't running".
function listWtTabs() {
  if (process.platform !== 'win32') return Promise.resolve([]);
  return winproc
    .runPowerShell(LIST_WT_TABS_SCRIPT, LIST_TIMEOUT_MS)
    .then((stdout) => (stdout == null ? null : parseWtTabs(stdout)));
}

// Bring the Terminal window owning `device` to the front. Resolves
// { ok } or { ok:false, reason } — never rejects.
function focusTty(device) {
  return new Promise((resolve) => {
    if (typeof device !== 'string' || !TTY_DEVICE.test(device)) {
      return resolve({ ok: false, reason: 'invalid-tty' });
    }
    if (process.platform !== 'darwin') {
      return resolve({ ok: false, reason: 'unsupported-platform' });
    }
    execFile('osascript', ['-e', FOCUS_SCRIPT, device], (err, stdout) => {
      if (err) return resolve({ ok: false, reason: 'osascript-failed' });
      if (String(stdout).trim() === 'ok') return resolve({ ok: true });
      resolve({ ok: false, reason: 'no-window' });
    });
  });
}

// Raise the window owned by `pid`, and CONFIRM it actually came forward.
//
// A detached daemon has no foreground rights, so `SetForegroundWindow` alone cannot
// raise anything — Windows returns false and silently does nothing. Measured cold (the
// user's terminal in front, the daemon raising a classic console window): plain
// SetForegroundWindow -> false, `SwitchToThisWindow` -> no effect, and
// `AttachThreadInput` to the foreground thread -> attach succeeds, SetForegroundWindow
// still false. The ONE thing that works is synthesising an input event first: after a
// key press Windows treats this process as having received the last input and grants it
// the rights, so the very next SetForegroundWindow succeeds.
//
// The cost is that the synthetic ALT tap lands on whatever is in front at that instant,
// where a lone ALT can pop a menu bar. Accepted: press and release are back to back, and
// there is no non-synthetic alternative that works (all three were measured failing).
//
// The result is CONFIRMED against GetForegroundWindow rather than trusting a return
// value — the same rule as the WT tab path, and the reason the old code reported `ok` for
// raises that never happened.
const FOCUS_WINDOW_NATIVE = `Add-Type -Namespace Cockpit -Name Native -MemberDefinition @"
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
[DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr h, bool alt);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, IntPtr extra);
"@`;

function focusWindowScript(pid) {
  if (!Number.isInteger(pid) || pid <= 0) throw new TypeError('pid must be a positive integer');
  return `$ErrorActionPreference = 'SilentlyContinue'
$id = ${pid}
$p = Get-Process -Id $id
# A ConPTY client (any session hosted by Windows Terminal, VS Code, Tabby, ...) reports 0
# here: its only window is an invisible PseudoConsoleWindow, which .NET does not surface
# as a MainWindowHandle. That is what keeps this path honest rather than raising a shim.
if (-not $p -or $p.MainWindowHandle -eq 0) { Write-Output 'notfound'; exit 0 }
$h = $p.MainWindowHandle
${FOCUS_WINDOW_NATIVE}
function Test-Fg {
  for ($i = 0; $i -lt 8; $i++) {
    if ([int64][Cockpit.Native]::GetForegroundWindow() -eq [int64]$h) { return $true }
    Start-Sleep -Milliseconds 50
  }
  return $false
}
if ([Cockpit.Native]::IsIconic($h)) { [void][Cockpit.Native]::ShowWindow($h, 9) }
# 0xA4 = VK_LMENU; 2 = KEYEVENTF_KEYUP. This is the foreground-rights step, not a keystroke
# meant for anyone — see the comment above.
[Cockpit.Native]::keybd_event(0xA4, 0, 0, [IntPtr]::Zero)
[Cockpit.Native]::keybd_event(0xA4, 0, 2, [IntPtr]::Zero)
[void][Cockpit.Native]::SetForegroundWindow($h)
$ok = Test-Fg
if (-not $ok) { [Cockpit.Native]::SwitchToThisWindow($h, $true); $ok = Test-Fg }
if (-not $ok) {
  try { [void](New-Object -ComObject WScript.Shell).AppActivate($id) } catch { }
  $ok = Test-Fg
}
if ($ok) { Write-Output 'ok' } else { Write-Output 'failed' }`;
}

// Map the raise script's output to the shared { ok } / { ok:false, reason } shape.
// `focus-refused` is kept distinct from `no-window`: the window exists, Windows just
// would not bring it forward.
function parseFocusWindowResult(stdout) {
  if (stdout == null) return { ok: false, reason: 'powershell-failed' };
  const out = String(stdout).trim();
  if (out === 'ok') return { ok: true };
  if (out === 'notfound') return { ok: false, reason: 'no-window' };
  return { ok: false, reason: 'focus-refused' };
}

// Bring `pid`'s window to the front. Same contract as focusTty.
function focusWindowPid(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return Promise.resolve({ ok: false, reason: 'invalid-target' });
  }
  if (process.platform !== 'win32') {
    return Promise.resolve({ ok: false, reason: 'unsupported-platform' });
  }
  return winproc
    .runPowerShell(focusWindowScript(pid), WINDOW_TIMEOUT_MS)
    .then(parseFocusWindowResult);
}

// Select and raise the Windows Terminal tab whose name matches `title`. Same
// contract as focusTty.
function focusWtTab(title, attemptsLeft) {
  if (process.platform !== 'win32') {
    return Promise.resolve({ ok: false, reason: 'unsupported-platform' });
  }
  const retries = attemptsLeft == null ? 1 : attemptsLeft;
  return listWtTabs().then((tabs) => {
    if (tabs == null) return { ok: false, reason: 'powershell-failed' };
    const m = matchWtTabs(tabs, title);
    if (m.reason) {
      const out = { ok: false, reason: m.reason };
      if (m.count) out.count = m.count;
      return out;
    }
    const vars = { COCKPIT_TAB_NAME: normalizeTabName(title) };
    return winproc
      .runPowerShell(selectWtTabScript(m.tab.hwnd, m.tab.index), SELECT_TIMEOUT_MS, vars)
      .then((stdout) => {
        if (stdout == null) return { ok: false, reason: 'powershell-failed' };
        const out = stdout.trim();
        if (out === 'ok') return { ok: true };
        // The tab list moved between enumerating and selecting, so the index no longer
        // names this session's tab. Nothing was selected — re-enumerate and try once more
        // rather than raising whatever now sits at that position.
        if (out === 'stale' && retries > 0) return focusWtTab(title, retries - 1);
        if (out === 'stale') return { ok: false, reason: 'no-window' };
        // The window was raised but Windows Terminal never applied the tab change. Kept
        // distinct from no-window so the user is told what they're looking at rather than
        // being told nothing was found when a window did in fact come forward.
        if (out === 'notselected') return { ok: false, reason: 'tab-not-selected' };
        return { ok: false, reason: 'no-window' };
      });
  });
}

// Resolve the focus target the daemon stores for a session, or null when this session
// can't be focused (no terminal, no window, or an unsupported platform). The target is
// opaque to the caller — its shape is what routes focusTarget below.
//
// The Windows TAB target is deliberately NOT resolved here: it is keyed on the session
// title, which arrives later (and changes on /rename), so the daemon derives `wt:` from
// live state instead of caching it once.
function resolveFocusTarget(pid) {
  if (process.platform === 'darwin') return ttyForPid(pid);
  if (process.platform === 'win32') {
    return windowPidForPid(pid).then((wp) => (wp == null ? null : 'pid:' + wp));
  }
  return Promise.resolve(null);
}

// Focus whatever a stored target names. Routing on the target's SHAPE (not the current
// platform) means a target carried over in a snapshot from another OS can't be handed to
// the wrong OS command — it fails the shape check instead.
function focusTarget(target) {
  if (typeof target === 'string') {
    if (TTY_DEVICE.test(target)) return focusTty(target);
    const w = WINDOW_TARGET.exec(target);
    if (w) return focusWindowPid(Number(w[1]));
    const t = WT_TARGET.exec(target);
    if (t) return focusWtTab(t[1]);
  }
  return Promise.resolve({ ok: false, reason: 'invalid-target' });
}

module.exports = {
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
  listWtTabs,
  listWindows,
  terminalWindowPidForTitle,
  focusTty,
  focusWindowPid,
  focusWtTab,
  resolveFocusTarget,
  focusTarget,
};
