'use strict';

// OS-notification layer. Two parts:
//   buildNotification() — pure decision: given an event, the session, and the
//     config, return the notification to show (or null if disabled). It only
//     ever names the repo and the event — never any transcript/message content.
//   notify() — fire-and-forget dispatch through node-notifier, run in a
//     DETACHED worker child so notification I/O never blocks the daemon's event
//     loop, and a clean no-op when node-notifier isn't installed.

const { spawn } = require('child_process');

// eventName -> short label + message builder. The message is a single human
// line; it may reference metadata (e.g. an error_type) but NEVER transcript
// content. Keep these terse — they render in an OS banner.
const EVENT_SPECS = {
  sessionFinished: {
    label: 'finished',
    message: () => 'The turn finished — session is now idle.',
  },
  needsInput: {
    label: 'needs input',
    message: () => 'Waiting for your input.',
  },
  longRunning: {
    label: 'running long',
    message: () => 'A prompt has been running past the threshold.',
  },
  turnFailed: {
    label: 'turn failed',
    message: (session) => {
      // errorReason is an error_type (e.g. "rate_limit") — metadata, not content.
      const reason = session && session.errorReason;
      return reason ? `The turn failed (${reason}).` : 'The turn failed.';
    },
  },
  safeToClose: {
    label: 'safe to close',
    message: () => 'All sessions are at rest — safe to close the laptop.',
  },
};

// Decide whether/what to notify. Returns null when notifications are disabled
// (master off, this event off) or the event name is unknown. Pure — no I/O.
function buildNotification(eventName, session, config) {
  if (!config || !config.osNotifications) return null;
  const events = config.events || {};
  if (!events[eventName]) return null;

  const spec = EVENT_SPECS[eventName];
  if (!spec) return null;

  // Session-less GLOBAL events (e.g. safeToClose) have no session at all; fall
  // back to a sensible product name rather than "unknown repo" for those.
  const repoName = (session && session.repoName) || (session ? 'unknown repo' : 'Cockpit');
  return {
    event: eventName,
    title: `${repoName} — ${spec.label}`,
    message: spec.message(session),
    // node-notifier `sound` semantics: true (default sound) | false | named sound.
    sound: config.sound,
  };
}

// Show one notification, then let the process exit once node-notifier's helper
// finishes. Runs ONLY inside the detached worker child. Both the require and
// the call are guarded so a missing module or a platform failure is a no-op.
function runWorker(notification) {
  let notifier;
  try {
    notifier = require('node-notifier');
  } catch {
    return; // node-notifier not installed -> nothing to do
  }
  try {
    notifier.notify(
      {
        title: notification.title,
        message: notification.message,
        sound: notification.sound,
      },
      // Swallow the callback error; the worker exits naturally afterwards.
      () => {}
    );
  } catch {
    // never surface notification I/O errors
  }
}

// Fire-and-forget. Spawns this file as a detached worker so the (potentially
// slow) node-notifier call runs off the daemon's event loop. Never throws.
function notify(notification) {
  if (!notification) return;
  try {
    const child = spawn(
      process.execPath,
      [__filename, '--worker', JSON.stringify(notification)],
      { detached: true, stdio: 'ignore', windowsHide: true }
    );
    child.on('error', () => {}); // swallow spawn errors (e.g. bad execPath)
    child.unref();
  } catch {
    // never throw into the daemon
  }
}

// Worker entry point: `node notify.js --worker <json>`. Argv avoids a shell, so
// there is no escaping concern; a malformed payload is simply ignored.
if (require.main === module && process.argv[2] === '--worker') {
  let notification = null;
  try {
    notification = JSON.parse(process.argv[3] || 'null');
  } catch {
    notification = null;
  }
  if (notification) runWorker(notification);
}

module.exports = { buildNotification, notify };
