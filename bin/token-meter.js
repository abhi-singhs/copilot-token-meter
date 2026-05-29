#!/usr/bin/env node
// copilot-token-meter: hook script for GitHub Copilot CLI session telemetry.
//
// Invoked by the plugin lifecycle hooks (sessionStart, userPromptSubmitted,
// postToolUse, agentStop). Reads events.jsonl + process-log telemetry, runs
// the aggregator, and writes:
//
//   1. ~/.copilot/state/token-meter/<sessionId>.json  (per-session snapshot)
//   2. ~/.copilot/state/token-meter/latest.json       (most-recent session)
//   3. ~/.copilot/state/token-meter/current           (just the sessionId)
//   4. OSC 2 escape to /dev/tty                       (terminal title bar)
//
// The script is intentionally dependency-free and side-effect-safe: any
// uncaught error is logged to errors.log and the process exits 0 so a hook
// failure never blocks the agent.

"use strict";

const fs   = require("fs");
const path = require("path");
const os   = require("os");

const { readJsonl, writeAtomic, writeTitleBar } = require("../lib/io");
const { aggregate }                              = require("../lib/aggregate");
const { loadTelemetryUsage }                     = require("../lib/telemetry");
const { formatTitle }                            = require("../lib/format");

const HOME      = process.env.COPILOT_HOME || path.join(os.homedir(), ".copilot");
const STATE_DIR = path.join(HOME, "state", "token-meter");
const SESSIONS  = path.join(HOME, "session-state");

function safeMain() {
  let hookName = "?";
  try {
    for (const a of process.argv.slice(2)) {
      if (a.startsWith("--hook=")) { hookName = a.slice(7); break; }
    }
  } catch (_) {}
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const root = process.env.COPILOT_PLUGIN_ROOT
      || process.env.CLAUDE_PLUGIN_ROOT
      || process.env.PLUGIN_ROOT
      || "";
    fs.appendFileSync(
      path.join(STATE_DIR, "hooks.log"),
      `[${new Date().toISOString()}] hook=${hookName} pid=${process.pid} cwd=${process.cwd()} root=${root}\n`
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
  const out = { hook: null, sessionId: null, eventsPath: null, print: false };
  for (const a of argv.slice(2)) {
    if (a.startsWith("--hook="))         out.hook       = a.slice(7);
    else if (a.startsWith("--session=")) out.sessionId  = a.slice(10);
    else if (a.startsWith("--events="))  out.eventsPath = a.slice(9);
    else if (a === "--print")            out.print      = true;
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

// Append a rolling burn-rate snapshot. Used by T1.4 burn-rate computations
// and the `watch` sparkline. Append-only, capped at ~5000 lines per session.
function appendHistorySnapshot(sessionId, agg) {
  const hist = path.join(STATE_DIR, "history-" + sessionId + ".jsonl");
  try {
    const t = agg.totals;
    const line = JSON.stringify({
      ts: Date.now(),
      inputTokens:      t.inputTokens,
      outputTokens:     t.outputTokens,
      cacheReadTokens:  t.cacheReadTokens,
      cacheWriteTokens: t.cacheWriteTokens,
      turns:            t.turns,
      toolCalls:        t.toolCalls,
      promptTokens:     t.promptTokens,
    }) + "\n";
    fs.appendFileSync(hist, line);
    // Best-effort truncation: if the file is large (> ~1MB), trim to the
    // last 5000 lines.
    try {
      const st = fs.statSync(hist);
      if (st.size > 1_000_000) {
        const data = fs.readFileSync(hist, "utf8").trim().split("\n");
        const keep = data.slice(-5000).join("\n") + "\n";
        writeAtomic(hist, keep);
      }
    } catch (_) {}
  } catch (_) {}
}

function buildStatusJson(agg, sessionId, eventsPath) {
  return {
    schema:    3,
    sessionId,
    eventsPath,
    updatedAt: new Date().toISOString(),
    model:     agg.lastModel,
    totals:    agg.totals,
    perModel:  agg.perModel,
    perTurn:   agg.perTurn.slice(-50),
    perTool:   agg.perTool,
    subAgentTotals: agg.subAgentTotals,
    quota:     agg.quota,
    telemetryAvailable: agg.telemetryAvailable,
    telemetryRecords:   agg.telemetryRecords,
    title:     formatTitle(agg),
  };
}

function main() {
  const args = parseArgs(process.argv);
  const sessionId  = discoverSessionId(args);
  const eventsPath = resolveEventsPath(args, sessionId);

  if (!sessionId || !eventsPath || !fs.existsSync(eventsPath)) {
    if (sessionId) {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      writeAtomic(path.join(STATE_DIR, "current"), sessionId + "\n");

      // On sessionStart the events.jsonl typically doesn't exist yet. Seed a
      // fresh zero-state per-session cache so the custom status line for THIS
      // session reads its own data immediately instead of falling through to
      // a sibling session's stale totals.
      if (args.hook === "sessionStart") {
        const cached = path.join(STATE_DIR, sessionId + ".json");
        if (!fs.existsSync(cached)) {
          const emptyAgg = aggregate([], null);
          const status   = buildStatusJson(emptyAgg, sessionId, eventsPath);
          const body     = JSON.stringify(status, null, 2);
          writeAtomic(cached, body);
          writeAtomic(path.join(STATE_DIR, "latest.json"), body);
        }
      }
    }
    return;
  }

  const events    = readJsonl(eventsPath);
  const telemetry = loadTelemetryUsage(sessionId);
  const agg       = aggregate(events, telemetry);
  const status    = buildStatusJson(agg, sessionId, eventsPath);

  fs.mkdirSync(STATE_DIR, { recursive: true });
  writeAtomic(path.join(STATE_DIR, sessionId + ".json"), JSON.stringify(status, null, 2));
  writeAtomic(path.join(STATE_DIR, "latest.json"),       JSON.stringify(status, null, 2));
  writeAtomic(path.join(STATE_DIR, "current"),           sessionId + "\n");

  appendHistorySnapshot(sessionId, agg);

  // T3.4 — optional title-bar reset when the agent finishes. Opt-in via
  // env var so users who like seeing the final stats lingering keep that
  // behavior. When enabled, clear the title back to a generic string.
  if (process.env.COPILOT_TOKENMETER_RESET_ON_STOP === "1" &&
      args.hook === "agentStop") {
    writeTitleBar("");
  } else {
    writeTitleBar(status.title);
  }

  if (args.print) {
    process.stdout.write(JSON.stringify(status, null, 2) + "\n");
  }
}

safeMain();
