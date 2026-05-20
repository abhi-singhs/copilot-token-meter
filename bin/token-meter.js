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
const LOGS_DIR   = path.join(HOME, "logs");
const TELEMETRY_CACHE = path.join(STATE_DIR, "telemetry-cache.json");

// Only scan process logs touched in the last N days (cuts cold-start cost).
const LOG_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;
// Bound the per-session list of "seen event IDs" so the cache file can't grow unboundedly.
const MAX_SEEN_EVENT_IDS = 10000;
// Bound the global (process-wide) map of API response usage records, keyed by msg-id.
const MAX_API_RESPONSES = 20000;
const TELEMETRY_CACHE_SCHEMA = 2;

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

// ---------------------------------------------------------------------------
// Telemetry-log parsing
//
// Copilot CLI writes one debug log per process to `~/.copilot/logs/process-*.log`.
// Among the chatter there are full `[Telemetry] cli.telemetry:` blocks of the
// form:
//
//     [Telemetry] cli.telemetry:
//     {
//       "kind": "assistant_usage",
//       "properties": { "event_id": "...", "model": "...", "api_call_id": "..." },
//       "metrics": { "input_tokens": 0, "output_tokens": 102, "cache_read_tokens": ...,
//                    "cache_write_tokens": ..., "reasoning_tokens": 0, "cost": 45,
//                    "duration": 4944, ... },
//       "session_id": "<sessionId>",
//       ...
//     }
//
// These blocks are the real source of truth for input / output / cache /
// reasoning / cost. The per-session `events.jsonl` only carries the
// message-level `outputTokens`, so we merge the two: telemetry for token /
// cost totals, events.jsonl for turn / tool / message activity.
//
// We cache a (logPath -> byteOffset) map per session in
// `~/.copilot/state/token-meter/telemetry-cache.json` so we only ever read the
// *new* tail of each log, even though logs grow large (10s of MB).
// We also remember the set of `event_id`s we've already accounted for so the
// same usage event isn't double-counted across overlapping cache writes.
// ---------------------------------------------------------------------------

function listProcessLogs() {
  if (!fs.existsSync(LOGS_DIR)) return [];
  const cutoff = Date.now() - LOG_LOOKBACK_MS;
  const out = [];
  for (const name of fs.readdirSync(LOGS_DIR)) {
    if (!name.startsWith("process-") || !name.endsWith(".log")) continue;
    const full = path.join(LOGS_DIR, name);
    try {
      const st = fs.statSync(full);
      if (st.mtimeMs >= cutoff) out.push({ path: full, size: st.size, mtimeMs: st.mtimeMs });
    } catch (_) {}
  }
  return out;
}

function loadTelemetryCache() {
  try {
    const c = JSON.parse(fs.readFileSync(TELEMETRY_CACHE, "utf8"));
    if (c && c.schema === TELEMETRY_CACHE_SCHEMA && c.sessions) {
      if (!c.apiResponses) c.apiResponses = {};
      if (!Array.isArray(c.apiResponsesOrder)) c.apiResponsesOrder = [];
      return c;
    }
  } catch (_) {}
  return { schema: TELEMETRY_CACHE_SCHEMA, sessions: {}, apiResponses: {}, apiResponsesOrder: [] };
}

function saveTelemetryCache(cache) {
  try { writeAtomic(TELEMETRY_CACHE, JSON.stringify(cache)); } catch (_) {}
}

// Scan a buffer of log text starting from offset 0, extracting all
// `[Telemetry] cli.telemetry: { ... }` JSON blocks that belong to `sessionId`
// and whose event_id isn't already in `seen`. Returns the records and the
// byte offset up to which we *fully* parsed (we never advance past an
// incomplete block, so the next pass can re-read it once it's flushed).
function parseTelemetryBlocks(text, sessionId, seen) {
  const HEADER = "[Telemetry] cli.telemetry:\n";
  const records = [];
  let i = 0;
  let lastCommittedEnd = 0;

  while (true) {
    const headerIdx = text.indexOf(HEADER, i);
    if (headerIdx === -1) {
      lastCommittedEnd = text.length;
      break;
    }
    let braceStart = headerIdx + HEADER.length;
    while (braceStart < text.length && text[braceStart] !== "{") braceStart++;
    if (braceStart >= text.length) {
      // Header found at the very tail; wait for the next pass to read more.
      break;
    }

    let depth = 0;
    let j = braceStart;
    let inString = false;
    let escape = false;
    let blockEnd = -1;
    while (j < text.length) {
      const c = text[j];
      if (inString) {
        if (escape) escape = false;
        else if (c === "\\") escape = true;
        else if (c === '"') inString = false;
      } else {
        if (c === '"') inString = true;
        else if (c === "{") depth++;
        else if (c === "}") {
          depth--;
          if (depth === 0) { blockEnd = j; break; }
        }
      }
      j++;
    }
    if (blockEnd === -1) break; // incomplete block — bail, retry next pass

    const block = text.slice(braceStart, blockEnd + 1);
    try {
      const obj = JSON.parse(block);
      if (obj && obj.kind === "assistant_usage" && obj.session_id === sessionId) {
        const eid = obj.properties && obj.properties.event_id;
        if (eid && !seen.has(eid)) {
          seen.add(eid);
          records.push({
            event_id:        eid,
            model:           (obj.properties && obj.properties.model) || null,
            api_call_id:     (obj.properties && obj.properties.api_call_id) || null,
            provider_call_id:(obj.properties && obj.properties.provider_call_id) || null,
            interaction_id:  (obj.properties && obj.properties.interaction_id) || null,
            initiator:       (obj.properties && obj.properties.initiator) || null,
            reasoning_effort:(obj.properties && obj.properties.reasoning_effort) || null,
            metrics:         obj.metrics || {},
            created_at:      obj.created_at || null,
          });
        }
      } else if (obj && obj.kind === "copilot_user_info" && obj.session_id === sessionId) {
        // Stash latest quota snapshot too — handy for the watcher.
        records.push({ __kind: "quota", metrics: obj.metrics || {}, properties: obj.properties || {} });
      }
    } catch (_) { /* malformed block — skip and continue */ }

    i = blockEnd + 1;
    lastCommittedEnd = i;
  }

  return { records, committedEnd: lastCommittedEnd };
}

// Generic JSON-block extractor: starting at `from`, find the next `header`,
// skip past it to the first `{`, then balance braces (respecting strings)
// until the matching closing `}`. Returns { block, blockEnd } or null if no
// complete block is available yet. `blockEnd` is the index of the closing `}`.
function findJsonBlock(text, from, header) {
  const headerIdx = text.indexOf(header, from);
  if (headerIdx === -1) return null;
  let p = headerIdx + header.length;
  while (p < text.length && text[p] !== "{") p++;
  if (p >= text.length) return { incomplete: true, headerIdx };

  let depth = 0, inString = false, escape = false, blockEnd = -1;
  for (let j = p; j < text.length; j++) {
    const c = text[j];
    if (inString) {
      if (escape) escape = false;
      else if (c === "\\") escape = true;
      else if (c === '"') inString = false;
    } else {
      if (c === '"') inString = true;
      else if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) { blockEnd = j; break; }
      }
    }
  }
  if (blockEnd === -1) return { incomplete: true, headerIdx };
  return { headerIdx, braceStart: p, blockEnd, block: text.slice(p, blockEnd + 1) };
}

// Scan a buffer for HTTP-response `data:` blocks Copilot CLI logs. These hold
// the raw Anthropic/OpenAI response JSON, including the only reliable copy of
// `usage.prompt_tokens` and `prompt_tokens_details.{cached_tokens,
// cache_creation_tokens}`. The CLI's own `[Telemetry] cli.telemetry` block
// reports `input_tokens: 0` on every turn that involves prompt caching (a CLI
// bug), so we derive the real uncached input as
//   prompt_tokens - cached_tokens - cache_creation_tokens
// and use it to override that zero. Returns the parsed records and a
// committedEnd so callers can resume cleanly across partial flushes.
function parseApiResponseBlocks(text) {
  const HEADER = "[DEBUG] data:\n";
  const records = [];
  let i = 0;
  let lastCommittedEnd = 0;

  while (true) {
    const found = findJsonBlock(text, i, HEADER);
    if (!found) { lastCommittedEnd = text.length; break; }
    if (found.incomplete) {
      // Header at the tail; resume next pass.
      break;
    }

    try {
      const obj = JSON.parse(found.block);
      if (obj && typeof obj.id === "string" && obj.usage && typeof obj.usage === "object") {
        const u = obj.usage;
        const d = (u.prompt_tokens_details && typeof u.prompt_tokens_details === "object") ? u.prompt_tokens_details : {};
        records.push({
          msgId: obj.id,
          model: obj.model || null,
          promptTokens:        n(u.prompt_tokens),
          completionTokens:    n(u.completion_tokens),
          cachedTokens:        n(d.cached_tokens),
          cacheCreationTokens: n(d.cache_creation_tokens),
        });
      }
    } catch (_) { /* not a JSON response body — skip */ }

    i = found.blockEnd + 1;
    lastCommittedEnd = i;
  }

  return { records, committedEnd: lastCommittedEnd };
}

function loadTelemetryUsage(sessionId) {
  if (!sessionId) return { usage: [], quota: null, apiResponses: {} };
  const cache = loadTelemetryCache();
  if (!cache.sessions[sessionId]) {
    cache.sessions[sessionId] = { logs: {}, seenEventIds: [], usage: [], quota: null };
  }
  const sess = cache.sessions[sessionId];
  const seen = new Set(sess.seenEventIds);

  for (const log of listProcessLogs()) {
    const prev = sess.logs[log.path] || { offset: 0 };
    if (log.size <= prev.offset) continue;

    let fd;
    try { fd = fs.openSync(log.path, "r"); } catch (_) { continue; }
    try {
      const len = log.size - prev.offset;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, prev.offset);
      const text = buf.toString("utf8");

      const telem = parseTelemetryBlocks(text, sessionId, seen);
      const apiResp = parseApiResponseBlocks(text);

      // Advance the offset only as far as both parsers have fully committed —
      // otherwise a partial block in either stream would be skipped on the
      // next pass. parseTelemetryBlocks only scopes to this session, so we
      // need every committed byte to be safe for both.
      const committed = Math.min(telem.committedEnd, apiResp.committedEnd);
      sess.logs[log.path] = { offset: prev.offset + committed, mtimeMs: log.mtimeMs };

      for (const r of telem.records) {
        if (r.__kind === "quota") sess.quota = r;
        else sess.usage.push(r);
      }
      for (const r of apiResp.records) {
        if (!r.msgId) continue;
        if (!Object.prototype.hasOwnProperty.call(cache.apiResponses, r.msgId)) {
          cache.apiResponsesOrder.push(r.msgId);
        }
        cache.apiResponses[r.msgId] = {
          model:               r.model,
          promptTokens:        r.promptTokens,
          completionTokens:    r.completionTokens,
          cachedTokens:        r.cachedTokens,
          cacheCreationTokens: r.cacheCreationTokens,
        };
      }
    } finally {
      try { fs.closeSync(fd); } catch (_) {}
    }
  }

  // Cap the global API-response map (LRU-ish — drop oldest insertion order).
  if (cache.apiResponsesOrder.length > MAX_API_RESPONSES) {
    const drop = cache.apiResponsesOrder.length - MAX_API_RESPONSES;
    for (let k = 0; k < drop; k++) delete cache.apiResponses[cache.apiResponsesOrder[k]];
    cache.apiResponsesOrder = cache.apiResponsesOrder.slice(drop);
  }

  sess.seenEventIds = Array.from(seen).slice(-MAX_SEEN_EVENT_IDS);
  saveTelemetryCache(cache);
  return { usage: sess.usage, quota: sess.quota, apiResponses: cache.apiResponses };
}



function aggregate(events, telemetry) {
  telemetry = telemetry || { usage: [], quota: null };

  const totals = {
    inputTokens:        0,
    outputTokens:       0,
    cacheReadTokens:    0,
    cacheWriteTokens:   0,
    reasoningTokens:    0,
    cost:               0,
    durationMs:         0,
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
        reasoningTokens: 0,
        cost: 0, durationMs: 0,
        toolCalls: 0, apiCalls: 0,
        startedAt: null, endedAt: null,
      });
    }
    return perTurn[turnIdx[turnId]];
  }

  // ── Map provider/api-call IDs back to the turn that produced them so the
  //    telemetry usage records can be billed to the right turn bucket.
  //    `assistant.message.requestId` matches `assistant_usage.provider_call_id`
  //    in the telemetry block.
  const requestIdToTurn = Object.create(null);

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

      case "assistant.turn_start": {
        currentTurnId = d.turnId != null ? String(d.turnId) : null;
        const ts0 = ensureTurn(currentTurnId, lastModel);
        if (ts0) ts0.startedAt = ts;
        break;
      }

      case "assistant.turn_end": {
        const te = ensureTurn(d.turnId != null ? String(d.turnId) : currentTurnId, lastModel);
        if (te) {
          te.endedAt = ts;
          if (te.startedAt && ts) te.durationMs = ts - te.startedAt;
        }
        totals.turns++;
        break;
      }

      case "tool.execution_start": {
        totals.toolCalls++;
        const tt = ensureTurn(currentTurnId, lastModel);
        if (tt) tt.toolCalls++;
        break;
      }

      case "assistant.message": {
        totals.assistantMessages++;
        if (d.model) lastModel = d.model;
        const turnId = d.turnId != null ? String(d.turnId) : currentTurnId;
        ensureTurn(turnId, d.model);
        if (d.requestId && turnId != null) {
          requestIdToTurn[d.requestId] = turnId;
        }
        break;
      }

      case "assistant.usage": {
        // Reserved for future CLI builds that surface usage in events.jsonl.
        if (d.model) lastModel = d.model;
        const m = d.model || lastModel || "unknown";
        const bucket = perModel[m] || (perModel[m] = bucketInit());
        bucket.inputTokens      += n(d.inputTokens);
        bucket.outputTokens     += n(d.outputTokens);
        bucket.cacheReadTokens  += n(d.cacheReadTokens);
        bucket.cacheWriteTokens += n(d.cacheWriteTokens);
        bucket.reasoningTokens  += n(d.reasoningTokens);
        bucket.cost             += n(d.cost);
        bucket.apiCalls         += 1;
        bucket.durationMs       += n(d.duration);

        totals.inputTokens      += n(d.inputTokens);
        totals.outputTokens     += n(d.outputTokens);
        totals.cacheReadTokens  += n(d.cacheReadTokens);
        totals.cacheWriteTokens += n(d.cacheWriteTokens);
        totals.reasoningTokens  += n(d.reasoningTokens);
        totals.cost             += n(d.cost);
        totals.durationMs       += n(d.duration);
        totals.apiCalls         += 1;

        const turn = ensureTurn(currentTurnId, m);
        if (turn) {
          turn.inputTokens      += n(d.inputTokens);
          turn.outputTokens     += n(d.outputTokens);
          turn.cacheReadTokens  += n(d.cacheReadTokens);
          turn.cacheWriteTokens += n(d.cacheWriteTokens);
          turn.reasoningTokens  += n(d.reasoningTokens);
          turn.cost             += n(d.cost);
          turn.apiCalls         += 1;
          turn.model = m;
        }

        if (d.quotaSnapshots && typeof d.quotaSnapshots === "object") {
          bucket.latestQuota = d.quotaSnapshots;
        }
        break;
      }
    }
  }

  // ── Fold in telemetry-log assistant_usage records (the real source of truth
  //    for input/cache/reasoning/cost on current Copilot CLI builds, which
  //    don't write `assistant.usage` events to events.jsonl).
  //
  //    Workaround: current Copilot CLI builds always emit `input_tokens: 0`
  //    in the assistant_usage telemetry even when there's real uncached
  //    prompt content. The raw HTTP response logged just above each
  //    telemetry block has the truthful number under
  //    `usage.prompt_tokens - prompt_tokens_details.cached_tokens
  //     - prompt_tokens_details.cache_creation_tokens`. We index those by
  //    `id` (== telemetry's `api_call_id`) in `loadTelemetryUsage` and use
  //    them here to repair the zero.
  const apiResponses = (telemetry && telemetry.apiResponses) || {};
  function repairedInput(r, mt) {
    const reported = n(mt.input_tokens);
    if (reported > 0) return reported;
    const api = r.api_call_id ? apiResponses[r.api_call_id] : null;
    if (!api) return reported;
    const derived = api.promptTokens - api.cachedTokens - api.cacheCreationTokens;
    return derived > 0 ? derived : reported;
  }
  const haveTelemetry = telemetry.usage && telemetry.usage.length > 0;
  if (haveTelemetry) {
    for (const r of telemetry.usage) {
      const m  = r.model || lastModel || "unknown";
      if (r.model) lastModel = r.model;
      const mt = r.metrics || {};
      const inTok = repairedInput(r, mt);
      const bucket = perModel[m] || (perModel[m] = bucketInit());
      bucket.inputTokens      += inTok;
      bucket.outputTokens     += n(mt.output_tokens);
      bucket.cacheReadTokens  += n(mt.cache_read_tokens);
      bucket.cacheWriteTokens += n(mt.cache_write_tokens);
      bucket.reasoningTokens  += n(mt.reasoning_tokens);
      bucket.cost             += n(mt.cost);
      bucket.apiCalls         += 1;
      bucket.durationMs       += n(mt.duration);

      totals.inputTokens      += inTok;
      totals.outputTokens     += n(mt.output_tokens);
      totals.cacheReadTokens  += n(mt.cache_read_tokens);
      totals.cacheWriteTokens += n(mt.cache_write_tokens);
      totals.reasoningTokens  += n(mt.reasoning_tokens);
      totals.cost             += n(mt.cost);
      totals.durationMs       += n(mt.duration);
      totals.apiCalls         += 1;

      const turnId = r.provider_call_id && requestIdToTurn[r.provider_call_id];
      if (turnId != null) {
        const turn = ensureTurn(turnId, m);
        if (turn) {
          turn.inputTokens      += inTok;
          turn.outputTokens     += n(mt.output_tokens);
          turn.cacheReadTokens  += n(mt.cache_read_tokens);
          turn.cacheWriteTokens += n(mt.cache_write_tokens);
          turn.reasoningTokens  += n(mt.reasoning_tokens);
          turn.cost             += n(mt.cost);
          turn.durationMs       += n(mt.duration);
          turn.apiCalls         += 1;
          turn.model = m;
        }
      }
    }
  }

  // ── Fallback: when neither assistant.usage events nor telemetry records
  //    are available (e.g., logs cleaned up, fresh session before first
  //    flush), fall back to message-level outputTokens for the output count.
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

  for (const t of perTurn) {
    if (t.durationMs < 0) t.durationMs = 0;
  }

  totals.totalTokens  = totals.inputTokens + totals.outputTokens;
  totals.billedTokens =
    totals.inputTokens + totals.outputTokens +
    totals.cacheWriteTokens + Math.floor(totals.cacheReadTokens / 10);
  totals.promptTokens = // what we actually sent on the wire
    totals.inputTokens + totals.cacheReadTokens + totals.cacheWriteTokens;

  return {
    totals, perModel, perTurn,
    sessionFirstTs: firstTs, sessionLastTs: lastTs,
    lastModel,
    telemetryAvailable: haveTelemetry,
    telemetryRecords:   haveTelemetry ? telemetry.usage.length : 0,
    quota:              telemetry.quota || null,
  };
}

function bucketInit() {
  return {
    inputTokens: 0, outputTokens: 0,
    cacheReadTokens: 0, cacheWriteTokens: 0,
    reasoningTokens: 0,
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
  if (t.reasoningTokens)  parts.push(`🧠${formatTokens(t.reasoningTokens)}`);
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
    schema:    2,
    sessionId,
    eventsPath,
    updatedAt: new Date().toISOString(),
    model:     agg.lastModel,
    totals:    agg.totals,
    perModel:  agg.perModel,
    perTurn:   agg.perTurn.slice(-50),
    quota:     agg.quota,
    telemetryAvailable: agg.telemetryAvailable,
    telemetryRecords:   agg.telemetryRecords,
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

  const events    = readJsonl(eventsPath);
  const telemetry = loadTelemetryUsage(sessionId);
  const agg       = aggregate(events, telemetry);
  const status    = buildStatusJson(agg, sessionId, eventsPath);

  fs.mkdirSync(STATE_DIR, { recursive: true });
  writeAtomic(path.join(STATE_DIR, sessionId + ".json"), JSON.stringify(status, null, 2));
  writeAtomic(path.join(STATE_DIR, "latest.json"),       JSON.stringify(status, null, 2));
  writeAtomic(path.join(STATE_DIR, "current"),           sessionId + "\n");

  writeTitleBar(status.title);

  if (args.print) {
    process.stdout.write(JSON.stringify(status, null, 2) + "\n");
  }
}

safeMain();
