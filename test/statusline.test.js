"use strict";

// Regression tests for the per-session isolation of the custom Copilot CLI
// status line (statusLine.command). Each running Copilot session calls the
// `copilot-tokens statusline` subcommand with its own session_id on stdin,
// so the rendered line MUST reflect that session — never a sibling session's
// cached totals. These tests spawn the real binary against a temp
// COPILOT_HOME so they exercise the cache lookup + payload fallback path.

const { test }     = require("node:test");
const assert       = require("node:assert/strict");
const fs           = require("node:fs");
const os           = require("node:os");
const path         = require("node:path");
const { spawnSync } = require("node:child_process");

const BIN_COPILOT_TOKENS = path.resolve(__dirname, "..", "bin", "copilot-tokens");
const BIN_TOKEN_METER    = path.resolve(__dirname, "..", "bin", "token-meter.js");

function tempHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenmeter-statusline-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, "state", "token-meter"), { recursive: true });
  fs.mkdirSync(path.join(dir, "session-state"),        { recursive: true });
  fs.mkdirSync(path.join(dir, "logs"),                 { recursive: true });
  return dir;
}

function runStatusline(home, stdin) {
  const res = spawnSync("node", [BIN_COPILOT_TOKENS, "statusline", "--plain"], {
    input: stdin == null ? "" : stdin,
    env:   Object.assign({}, process.env, { COPILOT_HOME: home, NO_COLOR: "1", NO_TITLE: "1" }),
    encoding: "utf8",
  });
  return res.stdout;
}

function runSessionStartHook(home, sessionId) {
  const res = spawnSync("node", [BIN_TOKEN_METER, "--hook=sessionStart"], {
    input: JSON.stringify({ sessionId, cwd: "/tmp", timestamp: new Date().toISOString() }),
    env:   Object.assign({}, process.env, { COPILOT_HOME: home, NO_TITLE: "1" }),
    encoding: "utf8",
  });
  return res;
}

function writeCachedStatus(home, sessionId, totals) {
  const file = path.join(home, "state", "token-meter", sessionId + ".json");
  fs.writeFileSync(file, JSON.stringify({
    schema:    3,
    sessionId,
    eventsPath: path.join(home, "session-state", sessionId, "events.jsonl"),
    updatedAt: new Date().toISOString(),
    model:     "claude-sonnet-4.6",
    totals,
  }));
  return file;
}

function writeLatest(home, body) {
  fs.writeFileSync(path.join(home, "state", "token-meter", "latest.json"), JSON.stringify(body));
}

test("statusline does NOT bleed an older session's tokens into a brand-new session", (t) => {
  const home = tempHome(t);

  // Simulate an older session that has already cached big totals AND become
  // the most-recent `latest.json` snapshot.
  const oldTotals = {
    inputTokens: 9999, outputTokens: 8888,
    cacheReadTokens: 777_000, cacheWriteTokens: 66_000,
    reasoningTokens: 0, turns: 17, toolCalls: 22,
    contextUtilization: 0.55,
  };
  writeCachedStatus(home, "OLD-SESSION", oldTotals);
  writeLatest(home, {
    schema: 3,
    sessionId: "OLD-SESSION",
    totals: oldTotals,
    updatedAt: new Date().toISOString(),
    model: "claude-sonnet-4.6",
  });

  // Brand-new session that has no per-session cache yet (sessionStart hook
  // hasn't fired, or events.jsonl is still empty). Copilot CLI hands us its
  // running totals via context_window — they should be 0 at session start.
  const payload = {
    session_id: "NEW-SESSION",
    context_window: {
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cache_read_tokens: 0,
      total_cache_write_tokens: 0,
      current_context_used_percentage: 0,
    },
  };
  const out = runStatusline(home, JSON.stringify(payload));

  assert.equal(out.includes("9.6k"), false, "must not show old session's input bucket: " + out);
  assert.equal(out.includes("8.6k") || out.includes("8.9k"), false, "must not show old output: " + out);
  assert.equal(out.includes("777"),  false, "must not show old cache read: " + out);
  assert.equal(out.includes("66.0k"), false, "must not show old cache write: " + out);
  assert.equal(out.includes("17t/22🔧"), false, "must not show old turns/tools: " + out);

  // Brand-new session should render the payload's zero context_window.
  assert.equal(out.startsWith("↑0 ↓0"), true, "should start with zero in/out: " + out);
});

test("statusline renders a clean zero line when payload has session_id but no context_window", (t) => {
  const home = tempHome(t);
  writeLatest(home, {
    schema: 3, sessionId: "STALE",
    totals: { inputTokens: 1000, outputTokens: 2000, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, turns: 5, toolCalls: 8 },
  });

  const out = runStatusline(home, JSON.stringify({ session_id: "FRESH" }));

  assert.equal(out.includes("1.0k"), false, "stale input must not appear: " + out);
  assert.equal(out.includes("2.0k"), false, "stale output must not appear: " + out);
  assert.equal(out.includes("5t/8🔧"), false, "stale turns/tools must not appear: " + out);
  assert.equal(out.trim(), "↑0 ↓0", "should render clean zero state: " + out);
});

test("statusline still uses the matching session's cache when its session_id is provided", (t) => {
  const home = tempHome(t);
  writeCachedStatus(home, "ACTIVE", {
    inputTokens: 1234, outputTokens: 5678,
    cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
    turns: 3, toolCalls: 4,
  });
  // A sibling session's cache must NOT leak in.
  writeCachedStatus(home, "SIBLING", {
    inputTokens: 99_999, outputTokens: 88_888,
    cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
    turns: 50, toolCalls: 60,
  });
  writeLatest(home, {
    schema: 3, sessionId: "SIBLING",
    totals: { inputTokens: 99_999, outputTokens: 88_888, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, turns: 50, toolCalls: 60 },
  });

  const out = runStatusline(home, JSON.stringify({ session_id: "ACTIVE" }));

  assert.equal(out.includes("1.2k"), true, "should show ACTIVE's input: " + out);
  assert.equal(out.includes("5.7k"), true, "should show ACTIVE's output: " + out);
  assert.equal(out.includes("3t/4🔧"), true, "should show ACTIVE's turns: " + out);
  assert.equal(out.includes("100.0k"), false, "must not show SIBLING's input: " + out);
  assert.equal(out.includes("50t"), false, "must not show SIBLING's turns: " + out);
});

test("statusline falls back to latest.json only when no payload session_id is provided", (t) => {
  const home = tempHome(t);
  writeLatest(home, {
    schema: 3, sessionId: "LATEST",
    totals: { inputTokens: 4444, outputTokens: 5555, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, turns: 9, toolCalls: 10 },
  });

  // Empty payload (interactive testing) — must still show *something*.
  const out = runStatusline(home, "{}");

  assert.equal(out.includes("4.4k"), true, "should fall through to latest.json input: " + out);
  assert.equal(out.includes("5.6k") || out.includes("5.5k"), true, "should fall through to latest.json output: " + out);
  assert.equal(out.includes("9t/10🔧"), true, "should fall through to latest.json turns: " + out);
});

test("sessionStart hook seeds a fresh per-session cache so the very first statusline read is isolated", (t) => {
  const home = tempHome(t);

  // Pre-existing sibling cache + latest.json that we must NOT bleed from.
  writeCachedStatus(home, "OLD-SESSION", {
    inputTokens: 9999, outputTokens: 8888,
    cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
    turns: 11, toolCalls: 22,
  });
  writeLatest(home, {
    schema: 3, sessionId: "OLD-SESSION",
    totals: { inputTokens: 9999, outputTokens: 8888, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, turns: 11, toolCalls: 22 },
  });

  const res = runSessionStartHook(home, "BRAND-NEW");
  assert.equal(res.status, 0, "hook must exit 0: " + (res.stderr || ""));

  const cachePath = path.join(home, "state", "token-meter", "BRAND-NEW.json");
  assert.equal(fs.existsSync(cachePath), true, "sessionStart should seed a per-session cache");

  const cached = JSON.parse(fs.readFileSync(cachePath, "utf8"));
  assert.equal(cached.sessionId, "BRAND-NEW");
  assert.equal(cached.totals.inputTokens,  0);
  assert.equal(cached.totals.outputTokens, 0);
  assert.equal(cached.totals.turns,        0);
  assert.equal(cached.totals.toolCalls,    0);

  // After the seed, statusline should render zeros for BRAND-NEW even if no
  // payload context_window is provided.
  const out = runStatusline(home, JSON.stringify({ session_id: "BRAND-NEW" }));
  assert.equal(out.includes("9.6k") || out.includes("9.9k"), false, "must not leak OLD input: " + out);
  assert.equal(out.includes("8.6k") || out.includes("8.9k"), false, "must not leak OLD output: " + out);
  assert.equal(out.trim().startsWith("↑0 ↓0"), true, "should render zeros for the fresh session: " + out);
});
