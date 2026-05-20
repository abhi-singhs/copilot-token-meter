"use strict";

const fs   = require("fs");
const path = require("path");

// Robust streaming JSONL reader. Tolerates partial last lines (common when
// the producer is mid-write) and silently skips malformed JSON so one bad
// record doesn't abort the whole scan.
function readJsonl(filePath) {
  const fd = fs.openSync(filePath, "r");
  const buf = Buffer.alloc(64 * 1024);
  let leftover = "";
  const events = [];
  try {
    let bytes;
    while ((bytes = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      const chunk = leftover + buf.slice(0, bytes).toString("utf8");
      const lines = chunk.split("\n");
      leftover = lines.pop();
      for (const line of lines) {
        if (!line) continue;
        try { events.push(JSON.parse(line)); } catch (_) {}
      }
    }
    if (leftover.trim()) {
      try { events.push(JSON.parse(leftover)); } catch (_) {}
    }
  } finally {
    fs.closeSync(fd);
  }
  return events;
}

// Atomic file write via tempfile + rename. The temp name is pid-suffixed so
// concurrent processes don't collide. Caller is responsible for taking any
// higher-level lock if it needs read-modify-write atomicity.
function writeAtomic(filePath, content) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = filePath + ".tmp." + process.pid;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, filePath);
}

// OSC 2 title-bar write. Many terminals (iTerm2, Kitty, Alacritty, WezTerm,
// Terminal.app, gnome-terminal, Windows Terminal) honour this even while
// another full-screen app owns the alt screen. We bypass stdout (which the
// host process may capture) by writing to /dev/tty directly; on Windows we
// fall back to stdout (Windows Terminal still parses OSC 2 from stdout).
function writeTitleBar(text) {
  if (process.env.TERM === "dumb" || process.env.NO_TITLE === "1") return;
  // Strip embedded control bytes (the title is logged by some terminals into
  // their command history — prevent escape injection — and clamp the length
  // so we don't blow past terminal title buffers).
  const safe = String(text).replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 160);
  const seq = `\x1b]2;${safe}\x07`;
  try {
    if (process.platform === "win32") {
      // Windows has no /dev/tty; Windows Terminal honours OSC 2 on stdout.
      if (process.stdout && process.stdout.isTTY) {
        process.stdout.write(seq);
      }
    } else {
      fs.writeFileSync("/dev/tty", seq);
    }
  } catch (_) {
    // No TTY available (CI / log capture): silently ignore.
  }
}

module.exports = { readJsonl, writeAtomic, writeTitleBar };
