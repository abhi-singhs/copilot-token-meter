#!/usr/bin/env node
// copilot-token-meter: live token/cost meter for GitHub Copilot CLI sessions.
//
// Reads the per-session `events.jsonl` file (whose location is provided to
// every hook invocation via stdin as JSON `{ sessionId, ... }`), computes
// running totals of input / output / cache / reasoning tokens, cost,
// per-model breakdown, and turn / tool-call counts, then:
//
//   1. Writes the summary to ~/.copilot/state/token-meter/<sessionId>.json
//      (atomic write) so external tools (tmux, iTerm, kitty, polybar, the
//      `copilot-tokens` CLI) can read it.
//   2. Emits an OSC 2 escape sequence to /dev/tty so the host terminal's
//      title bar shows the live totals — this gives us a true always-visible
//      "footer" without needing a hook into Copilot's built-in status line.
//   3. Maintains a tiny rolling activity log so the watcher CLI can render
//      a sparkline / per-turn diff.
//
// The script is intentionally dependency-free and side-effect-safe: if
// anything goes wrong it exits 0 so a hook failure never blocks the agent.

"use strict";

const fs   = require("fs");
const path = require("path");
const os   = require("os");

const HOME       = process.env.COPILOT_HOME || path.join(os.homedir(), ".copilot");
const STATE_DIR  = path.join(HOME, "state", "token-meter");
const SESSIONS   = path.join(HOME, "session-state");

function safeMain() {
  let hookName = "?";
  try {
    for (const a of process.argv.slice(2)) {
      if (a.startsWith("--hook=")) { hookName = a.slice(7); break; }
    }
  } catch (_) {}
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.appendFileSync(
      path.join(STATE_DIR, "hooks.log"),
      `[${new Date().toISOString()}] hook=${hookName} pid=${process.pid} cwd=${process.cwd()}\n`
    );
  } catch (_) {}
  try { main(); }
  catch (err) {
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      fs.appendFileSync(
        path.join(STATE_DIR, "errors.log"),
        `[${new Date().toISOString()}] hook=${hookName} ${err.stack || err}\n`
      );
    } catch (_) {}
    process.exit(0);
  }
}

function parseArgs(argv) {
  const out = { hook: null, sessionId: null, eventsPath: null };
  for (const a of argv.slice(2)) {
    if (a.startsWith("--hook="))      out.hook       = a.slice(7);
    else if (a.startsWith("--session="))   out.sessionId  = a.slice(10);
    else if (a.startsWith("--events="))    out.eventsPath = a.slice(9);
    else if (a === "--print")              out.print      = true;
  }
  return out;
}

function readStdinSyncIfAny() {
  try {
    if (process.stdin.isTTY) return "";
    return fs.readFileSync(0, "utf8");
  } catch (_) {
    return "";
  }
}

function discoverSessionId(args) {
  if (args.sessionId) return args.sessionId;
  // Hooks pass JSON on stdin: { sessionId, cwd, timestamp, ... }.
  const raw = readStdinSyncIfAny();
  if (raw && raw.trim().startsWith("{")) {
    try {
      const obj = JSON.parse(raw);
      if (obj && obj.sessionId) return obj.sessionId;
      if (obj && obj.input && obj.input.sessionId) return obj.input.sessionId;
    } catch (_) {}
  }
  // Fallbacks for manual invocation.
  if (process.env.COPILOT_SESSION_ID) return process.env.COPILOT_SESSION_ID;
  return discoverMostRecentSession();
}

function discoverMostRecentSession() {
  if (!fs.existsSync(SESSIONS)) return null;
  let best = null, bestMtime = 0;
  for (const id of fs.readdirSync(SESSIONS)) {
    const ev = path.join(SESSIONS, id, "events.jsonl");
    try {
      const s = fs.statSync(ev);
      if (s.mtimeMs > bestMtime) { bestMtime = s.mtimeMs; best = id; }
    } catch (_) {}
  }
  return best;
}

function resolveEventsPath(args, sessionId) {
  if (args.eventsPath) return args.eventsPath;
  if (!sessionId) return null;
  return path.join(SESSIONS, sessionId, "events.jsonl");
}

// Robust streaming JSONL reader.
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

function n(v) { return typeof v === "number" && isFinite(v) ? v : 0; }

function aggregate(events) {
  const totals = {
    inputTokens:        0,
    outputTokens:       0,
    cacheReadTokens:    0,
    cacheWriteTokens:   0,
    reasoningTokens:    0, // derived from message.outputTokens when no usage event
    cost:               0,
    apiCalls:           0,
    turns:              0,
    toolCalls:          0,
    userMessages:       0,
    assistantMessages:  0,
  };
  const perModel = Object.create(null);
  const perTurn  = []; // { turnId, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, cost, durationMs, toolCalls, model }
  const turnIdx  = Object.create(null);
  let currentTurnId = null;
  let lastModel = null;
  let firstTs = null, lastTs = null;

  function ensureTurn(turnId, model) {
    if (turnId == null) return null;
    if (turnIdx[turnId] == null) {
      turnIdx[turnId] = perTurn.length;
      perTurn.push({
        turnId, model: model || lastModel || "unknown",
        inputTokens: 0, outputTokens: 0,
        cacheReadTokens: 0, cacheWriteTokens: 0,
        cost: 0, durationMs: 0,
        toolCalls: 0, apiCalls: 0,
        startedAt: null, endedAt: null,
      });
    }
    return perTurn[turnIdx[turnId]];
  }

  for (const ev of events) {
    if (!ev || typeof ev !== "object") continue;
    const ts = ev.timestamp ? Date.parse(ev.timestamp) : null;
    if (ts) { if (!firstTs) firstTs = ts; lastTs = ts; }
    const t = ev.type;
    const d = ev.data || {};

    switch (t) {
      case "session.model_change":
        if (d.model) lastModel = d.model;
        break;

      case "user.message":
        totals.userMessages++;
        break;

      case "assistant.turn_start":
        currentTurnId = d.turnId != null ? String(d.turnId) : null;
        const ts0 = ensureTurn(currentTurnId, lastModel);
        if (ts0) ts0.startedAt = ts;
        break;

      case "assistant.turn_end":
        const te = ensureTurn(d.turnId != null ? String(d.turnId) : currentTurnId, lastModel);
        if (te) {
          te.endedAt = ts;
          if (te.startedAt && ts) te.durationMs = ts - te.startedAt;
        }
        totals.turns++;
        break;

      case "tool.execution_start":
        totals.toolCalls++;
        const tt = ensureTurn(currentTurnId, lastModel);
        if (tt) tt.toolCalls++;
        break;

      case "assistant.message": {
        totals.assistantMessages++;
        if (d.model) lastModel = d.model;
        // Pre-usage fallback: only `outputTokens` is on the message itself,
        // and even that can be null while a stream is in flight.
        const turn = ensureTurn(d.turnId != null ? String(d.turnId) : currentTurnId, d.model);
        const m = d.model || lastModel || "unknown";
        const bucket = perModel[m] || (perModel[m] = bucketInit());
        // Only count the message-level outputTokens when no assistant.usage
        // event has provided it (we de-dup below by messageId/apiCallId).
        if (n(d.outputTokens) > 0 && !d.__usageAccountedFor) {
          // Tag the event in-memory so a later usage event can override.
          d.__messageOutputTokens = n(d.outputTokens);
        }
        break;
      }

      case "assistant.usage": {
        if (d.model) lastModel = d.model;
        const m = d.model || lastModel || "unknown";
        const bucket = perModel[m] || (perModel[m] = bucketInit());
        bucket.inputTokens      += n(d.inputTokens);
        bucket.outputTokens     += n(d.outputTokens);
        bucket.cacheReadTokens  += n(d.cacheReadTokens);
        bucket.cacheWriteTokens += n(d.cacheWriteTokens);
        bucket.cost             += n(d.cost);
        bucket.apiCalls         += 1;
        bucket.durationMs       += n(d.duration);

        totals.inputTokens      += n(d.inputTokens);
        totals.outputTokens     += n(d.outputTokens);
        totals.cacheReadTokens  += n(d.cacheReadTokens);
        totals.cacheWriteTokens += n(d.cacheWriteTokens);
        totals.cost             += n(d.cost);
        totals.apiCalls         += 1;

        const turn = ensureTurn(currentTurnId, m);
        if (turn) {
          turn.inputTokens      += n(d.inputTokens);
          turn.outputTokens     += n(d.outputTokens);
          turn.cacheReadTokens  += n(d.cacheReadTokens);
          turn.cacheWriteTokens += n(d.cacheWriteTokens);
          turn.cost             += n(d.cost);
          turn.apiCalls         += 1;
          turn.model = m;
        }

        // Capture latest quota snapshot so external dashboards can show it.
        if (d.quotaSnapshots && typeof d.quotaSnapshots === "object") {
          bucket.latestQuota = d.quotaSnapshots;
        }
        break;
      }
    }
  }

  // For sessions that don't emit assistant.usage (e.g., older CLI versions or
  // BYOK providers), fall back to message-level outputTokens. Populate both
  // session totals and per-turn buckets so the dashboard stays useful.
  if (totals.outputTokens === 0) {
    let fallbackTurn = null;
    for (const ev of events) {
      if (!ev) continue;
      if (ev.type === "assistant.turn_start" && ev.data) {
        fallbackTurn = ev.data.turnId != null ? String(ev.data.turnId) : null;
      } else if (ev.type === "assistant.message" && ev.data) {
        const out = n(ev.data.outputTokens);
        if (out > 0) {
          totals.outputTokens += out;
          const m = ev.data.model || lastModel || "unknown";
          const b = perModel[m] || (perModel[m] = bucketInit());
          b.outputTokens += out;
          const tId = ev.data.turnId != null ? String(ev.data.turnId) : fallbackTurn;
          const tBucket = ensureTurn(tId, m);
          if (tBucket) tBucket.outputTokens += out;
        }
      }
    }
  }

  // Clamp pathological durations (e.g., from /undo rewinding the timeline).
  for (const t of perTurn) {
    if (t.durationMs < 0) t.durationMs = 0;
  }

  totals.totalTokens = totals.inputTokens + totals.outputTokens;
  totals.billedTokens =
    totals.inputTokens + totals.outputTokens +
    totals.cacheWriteTokens + Math.floor(totals.cacheReadTokens / 10);

  return {
    totals, perModel, perTurn,
    sessionFirstTs: firstTs, sessionLastTs: lastTs,
    lastModel,
  };
}

function bucketInit() {
  return {
    inputTokens: 0, outputTokens: 0,
    cacheReadTokens: 0, cacheWriteTokens: 0,
    cost: 0, apiCalls: 0, durationMs: 0,
    latestQuota: null,
  };
}

function formatTokens(num) {
  if (num >= 1_000_000) return (num / 1_000_000).toFixed(2) + "M";
  if (num >= 1_000)     return (num / 1_000).toFixed(1) + "k";
  return String(num);
}

function formatTitle(agg, sessionId) {
  const t = agg.totals;
  const model = agg.lastModel || "copilot";
  const parts = [
    `↑${formatTokens(t.inputTokens)}`,
    `↓${formatTokens(t.outputTokens)}`,
  ];
  if (t.cacheReadTokens)  parts.push(`⟳${formatTokens(t.cacheReadTokens)}`);
  if (t.cacheWriteTokens) parts.push(`⊕${formatTokens(t.cacheWriteTokens)}`);
  if (t.cost > 0)         parts.push(`$${t.cost.toFixed(4)}`);
  parts.push(`${t.turns}t/${t.toolCalls}🔧`);
  return `copilot[${model.replace(/^claude-/, "")}] ${parts.join(" ")}`;
}

function writeAtomic(filePath, content) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = filePath + ".tmp." + process.pid;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, filePath);
}

function writeTitleBar(text) {
  // OSC 2 — set window title. Many terminals (iTerm2, Kitty, Alacritty,
  // WezTerm, Terminal.app, gnome-terminal, Windows Terminal) honour this
  // even while another full-screen app (Copilot) owns the alt screen.
  // We write to /dev/tty directly to bypass any stdout capture the host
  // process may apply to hook commands.
  if (process.env.TERM === "dumb" || process.env.NO_TITLE === "1") return;
  // Strip any embedded control bytes from the title to prevent escape
  // injection, then clamp to a sensible length.
  const safe = String(text).replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 160);
  const seq = `\x1b]2;${safe}\x07`;
  try {
    fs.writeFileSync("/dev/tty", seq);
  } catch (_) {
    // No TTY (CI/log capture): silently ignore.
  }
}

function buildStatusJson(agg, sessionId, eventsPath) {
  return {
    schema:    1,
    sessionId,
    eventsPath,
    updatedAt: new Date().toISOString(),
    model:     agg.lastModel,
    totals:    agg.totals,
    perModel:  agg.perModel,
    perTurn:   agg.perTurn.slice(-50),
    title:     formatTitle(agg, sessionId),
  };
}

function main() {
  const args = parseArgs(process.argv);
  const sessionId  = discoverSessionId(args);
  const eventsPath = resolveEventsPath(args, sessionId);

  if (!sessionId || !eventsPath || !fs.existsSync(eventsPath)) {
    // Nothing to measure yet (e.g. very first sessionStart hook before
    // events.jsonl is created). Still record the "current session" pointer
    // so external watchers can attach.
    if (sessionId) {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      writeAtomic(
        path.join(STATE_DIR, "current"),
        sessionId + "\n"
      );
    }
    return;
  }

  const events = readJsonl(eventsPath);
  const agg    = aggregate(events);
  const status = buildStatusJson(agg, sessionId, eventsPath);

  fs.mkdirSync(STATE_DIR, { recursive: true });
  writeAtomic(path.join(STATE_DIR, sessionId + ".json"), JSON.stringify(status, null, 2));
  writeAtomic(path.join(STATE_DIR, "latest.json"),       JSON.stringify(status, null, 2));
  writeAtomic(path.join(STATE_DIR, "current"),           sessionId + "\n");

  // Title bar update.
  writeTitleBar(status.title);

  if (args.print) {
    process.stdout.write(JSON.stringify(status, null, 2) + "\n");
  }
}

safeMain();
