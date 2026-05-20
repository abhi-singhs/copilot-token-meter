"use strict";

// Telemetry-log parsing for the Copilot CLI process logs.
//
// Copilot CLI writes one debug log per process to `~/.copilot/logs/process-*.log`.
// Inside the chatter we extract two structured streams:
//
// 1. [Telemetry] cli.telemetry: blocks of kind "assistant_usage" — the
//    "official" per-API-call usage record (model, output_tokens, cache_read,
//    cache_write, reasoning_tokens, duration, ttft_ms, ...) tagged
//    with session_id, api_call_id (== response.id), and provider_call_id
//    (== events.jsonl assistant.message.requestId).
//
// 2. [DEBUG] data: blocks — the raw HTTP response body from the model
//    provider. We use these to repair the `input_tokens: 0` bug in current
//    Copilot CLI builds: the truthful uncached input is
//       prompt_tokens - cached_tokens - cache_creation_tokens
//    pulled from `usage.prompt_tokens` + `usage.prompt_tokens_details`.
//    These get matched to telemetry records by id == api_call_id.
//
// Parsing is incremental: per-(session, log) byte offsets are cached so we
// only read the new tail of each log on every hook tick. The cache is
// concurrency-safe via an advisory lockfile and self-healing across log
// rotation/truncation (inode + size sanity checks).

const fs   = require("fs");
const path = require("path");
const os   = require("os");
const { n } = require("./format");
const { writeAtomic } = require("./io");

const HOME      = process.env.COPILOT_HOME || path.join(os.homedir(), ".copilot");
const STATE_DIR = path.join(HOME, "state", "token-meter");
const LOGS_DIR  = path.join(HOME, "logs");
const CACHE_PATH = path.join(STATE_DIR, "telemetry-cache.json");
const LOCK_PATH  = path.join(STATE_DIR, "telemetry-cache.lock");

const LOG_LOOKBACK_MS    = 14 * 24 * 60 * 60 * 1000; // 14 days
const MAX_SEEN_EVENT_IDS = 10_000;
const MAX_API_RESPONSES  = 20_000;
const MAX_SESSIONS       = 250; // drop oldest beyond this in cache
const SESSION_TTL_MS     = 30 * 24 * 60 * 60 * 1000; // 30 days
const CACHE_SCHEMA       = 3;

// Advisory lockfile around the cache read-modify-write cycle. We try to
// acquire it via O_EXCL with a short retry loop; on persistent contention we
// proceed without the lock — the cost is one missed cache update tick,
// which the next hook invocation will pick up. The hook must never block
// the agent. Returns a release() function (no-op if we never held the lock).
function acquireCacheLock(timeoutMs = 200) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const fd = fs.openSync(LOCK_PATH, "wx");
      try { fs.writeSync(fd, String(process.pid)); } catch (_) {}
      return () => {
        try { fs.closeSync(fd); } catch (_) {}
        try { fs.unlinkSync(LOCK_PATH); } catch (_) {}
      };
    } catch (e) {
      if (e && e.code === "EEXIST") {
        // Detect & break stale locks (> 30s old — far longer than any sane
        // hook). Otherwise back off briefly.
        try {
          const st = fs.statSync(LOCK_PATH);
          if (Date.now() - st.mtimeMs > 30_000) {
            try { fs.unlinkSync(LOCK_PATH); } catch (_) {}
            continue;
          }
        } catch (_) {}
        // Tiny busy-wait — synchronous because hooks are synchronous.
        const until = Date.now() + 20;
        while (Date.now() < until) { /* spin */ }
        continue;
      }
      // Permissions or other — give up; proceed lock-free.
      return () => {};
    }
  }
  return () => {}; // lock not acquired; proceed best-effort
}

function listProcessLogs() {
  if (!fs.existsSync(LOGS_DIR)) return [];
  const cutoff = Date.now() - LOG_LOOKBACK_MS;
  const out = [];
  for (const name of fs.readdirSync(LOGS_DIR)) {
    if (!name.startsWith("process-") || !name.endsWith(".log")) continue;
    const full = path.join(LOGS_DIR, name);
    try {
      const st = fs.statSync(full);
      if (st.mtimeMs >= cutoff) {
        out.push({ path: full, size: st.size, mtimeMs: st.mtimeMs, ino: st.ino });
      }
    } catch (_) {}
  }
  return out;
}

function loadCache() {
  try {
    const c = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
    if (c && c.schema === CACHE_SCHEMA && c.sessions) {
      if (!c.apiResponses) c.apiResponses = {};
      if (!Array.isArray(c.apiResponsesOrder)) c.apiResponsesOrder = [];
      return c;
    }
  } catch (_) {}
  return { schema: CACHE_SCHEMA, sessions: {}, apiResponses: {}, apiResponsesOrder: [] };
}

function saveCache(cache) {
  try { writeAtomic(CACHE_PATH, JSON.stringify(cache)); } catch (_) {}
}

// Generic JSON-block extractor: starting at `from`, find the next `header`,
// skip past it to the first `{`, then balance braces (respecting strings)
// until the matching `}`. Returns {block, blockEnd} or {incomplete:true}
// when the block is only partially flushed yet (so the caller can resume).
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

// Parse [Telemetry] cli.telemetry: { kind: assistant_usage | copilot_user_info }
// blocks belonging to `sessionId`. `seen` is a Set of event_ids we've already
// recorded — required to de-dupe across overlapping cache writes (e.g. when
// the same log is appended to during a hook's parsing window).
function parseTelemetryBlocks(text, sessionId, seen) {
  const HEADER = "[Telemetry] cli.telemetry:\n";
  const records = [];
  let i = 0;
  let lastCommittedEnd = 0;

  while (true) {
    const found = findJsonBlock(text, i, HEADER);
    if (!found) { lastCommittedEnd = text.length; break; }
    if (found.incomplete) break; // resume next pass

    try {
      const obj = JSON.parse(found.block);
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
            parent_tool_call_id:(obj.properties && obj.properties.parent_tool_call_id) || null,
            reasoning_effort:(obj.properties && obj.properties.reasoning_effort) || null,
            metrics:         obj.metrics || {},
            created_at:      obj.created_at || null,
          });
        }
      } else if (obj && obj.kind === "copilot_user_info" && obj.session_id === sessionId) {
        records.push({ __kind: "quota", metrics: obj.metrics || {}, properties: obj.properties || {} });
      }
    } catch (_) { /* malformed block — skip */ }

    i = found.blockEnd + 1;
    lastCommittedEnd = i;
  }

  return { records, committedEnd: lastCommittedEnd };
}

// Parse [DEBUG] data: blocks (raw HTTP response bodies). Used to repair the
// `input_tokens: 0` bug — the truthful uncached input is
//   prompt_tokens - cached_tokens - cache_creation_tokens
// pulled from the response's `usage` object. We index these by `id` so the
// aggregator can join them to telemetry records by `api_call_id`.
function parseApiResponseBlocks(text) {
  const HEADER = "[DEBUG] data:\n";
  const records = [];
  let i = 0;
  let lastCommittedEnd = 0;

  while (true) {
    const found = findJsonBlock(text, i, HEADER);
    if (!found) { lastCommittedEnd = text.length; break; }
    if (found.incomplete) break;

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
    } catch (_) { /* not a response body — skip */ }

    i = found.blockEnd + 1;
    lastCommittedEnd = i;
  }

  return { records, committedEnd: lastCommittedEnd };
}

// Decide whether a previously-cached log offset is still valid for the
// current file on disk. Returns the offset we should resume from, or 0 if
// the file has been rotated/truncated since we last read it.
function safeResumeOffset(prev, current) {
  if (!prev) return 0;
  if (prev.ino != null && current.ino != null && prev.ino !== current.ino) return 0;
  if (current.size < (prev.offset || 0)) return 0; // truncated
  return prev.offset || 0;
}

// Top-level entry point. Reads new tail of each process log, parses both
// streams in a single pass, updates the cache, and returns the merged view:
//   { usage: [...], quota: {...}|null, apiResponses: { [msgId]: {...} } }
function loadTelemetryUsage(sessionId) {
  if (!sessionId) return { usage: [], quota: null, apiResponses: {} };

  const release = acquireCacheLock();
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const cache = loadCache();
    if (!cache.sessions[sessionId]) {
      cache.sessions[sessionId] = { logs: {}, seenEventIds: [], usage: [], quota: null, lastSeenMs: Date.now() };
    }
    const sess = cache.sessions[sessionId];
    sess.lastSeenMs = Date.now();
    const seen = new Set(sess.seenEventIds);

    for (const log of listProcessLogs()) {
      const prev = sess.logs[log.path];
      const resumeOffset = safeResumeOffset(prev, log);
      if (log.size <= resumeOffset) continue;

      let fd;
      try { fd = fs.openSync(log.path, "r"); } catch (_) { continue; }
      try {
        const len = log.size - resumeOffset;
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, resumeOffset);
        const text = buf.toString("utf8");

        const telem   = parseTelemetryBlocks(text, sessionId, seen);
        const apiResp = parseApiResponseBlocks(text);

        // Advance offset only to the byte both streams have fully committed —
        // a partially-flushed block in either stream must be retried.
        const committed = Math.min(telem.committedEnd, apiResp.committedEnd);
        sess.logs[log.path] = {
          offset: resumeOffset + committed,
          mtimeMs: log.mtimeMs,
          ino:    log.ino,
        };

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

    // Drop oldest API responses beyond the cap (insertion order).
    if (cache.apiResponsesOrder.length > MAX_API_RESPONSES) {
      const drop = cache.apiResponsesOrder.length - MAX_API_RESPONSES;
      for (let k = 0; k < drop; k++) delete cache.apiResponses[cache.apiResponsesOrder[k]];
      cache.apiResponsesOrder = cache.apiResponsesOrder.slice(drop);
    }

    // Evict stale sessions: drop anything past TTL or beyond MAX_SESSIONS by
    // lastSeenMs. We always keep the current sessionId.
    const ttlCutoff = Date.now() - SESSION_TTL_MS;
    const ids = Object.keys(cache.sessions);
    for (const id of ids) {
      if (id === sessionId) continue;
      const s = cache.sessions[id];
      if (!s || (s.lastSeenMs || 0) < ttlCutoff) delete cache.sessions[id];
    }
    const remaining = Object.keys(cache.sessions);
    if (remaining.length > MAX_SESSIONS) {
      const sorted = remaining
        .filter(id => id !== sessionId)
        .map(id => ({ id, t: (cache.sessions[id].lastSeenMs || 0) }))
        .sort((a, b) => a.t - b.t);
      const dropCount = remaining.length - MAX_SESSIONS;
      for (let k = 0; k < dropCount; k++) delete cache.sessions[sorted[k].id];
    }

    sess.seenEventIds = Array.from(seen).slice(-MAX_SEEN_EVENT_IDS);
    saveCache(cache);

    return { usage: sess.usage, quota: sess.quota, apiResponses: cache.apiResponses };
  } finally {
    release();
  }
}

module.exports = {
  loadTelemetryUsage,
  parseTelemetryBlocks,
  parseApiResponseBlocks,
  findJsonBlock,
  safeResumeOffset,
  // exported for tests
  _internals: { acquireCacheLock, listProcessLogs, loadCache, saveCache, CACHE_PATH, STATE_DIR },
};
