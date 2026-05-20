"use strict";

const { n } = require("./format");
const { costForBucket, contextWindow } = require("./pricing");

function bucketInit() {
  return {
    inputTokens: 0, outputTokens: 0,
    cacheReadTokens: 0, cacheWriteTokens: 0,
    reasoningTokens: 0,
    cost: 0, apiCalls: 0, durationMs: 0,
    latestQuota: null,
  };
}

// Cross-stream aggregator: walks events.jsonl, optionally folds in telemetry
// log records, and produces totals + per-model + per-turn + per-tool buckets.
//
// Two repair paths worth knowing about:
//
//   1. `repairedInput` — current Copilot CLI builds always emit
//      `input_tokens: 0` in their assistant_usage telemetry when prompt
//      caching is active. We derive the truthful value from the matching
//      raw HTTP response usage record (joined by api_call_id) using
//      `prompt_tokens - cached_tokens - cache_creation_tokens`.
//
//   2. Per-tool attribution: the events stream has tool.execution_start
//      with `name` but no per-tool token data. We attribute the *delta* of
//      input/cache_read/cache_write between the assistant.message that
//      *fired* a tool and the next assistant.message (containing the tool's
//      result) to the tool that ran. This is approximate (the model may
//      think between tool calls within the same turn) but for most
//      single-tool turns it matches reality within ~1%.
function aggregate(events, telemetry) {
  telemetry = telemetry || { usage: [], quota: null, apiResponses: {} };

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
    usdCost:            0,
    usdCostKnown:       true, // false if any record's model is unknown to pricing
  };
  const perModel = Object.create(null);
  const perTurn  = [];
  const turnIdx  = Object.create(null);
  const perTool  = Object.create(null); // name → { calls, lastCallId, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, durationMs }
  let currentTurnId = null;
  let lastModel = null;
  let firstTs = null, lastTs = null;

  // For tool attribution: when an assistant.message has toolRequests, the
  // tools' results will be folded into the NEXT API call's prompt. We
  // remember the batch in `pendingToolBatch` and apply it to that call.

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
        tools: [],
        usdCost: 0,
      });
    }
    return perTurn[turnIdx[turnId]];
  }

  function ensureTool(name) {
    if (!name) return null;
    if (!perTool[name]) {
      perTool[name] = {
        name,
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        durationMs: 0,
        usdCost: 0,
        models: Object.create(null),
      };
    }
    return perTool[name];
  }

  // assistant.message.requestId == telemetry assistant_usage.provider_call_id
  const requestIdToTurn = Object.create(null);
  // requestId → list of tool names whose results were folded into the prompt
  // for this API call. Each tool gets credit for its share (1/N) of the
  // call's input / cache tokens.
  const requestIdToToolBatch = Object.create(null);
  let pendingToolBatch = null;

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
        // Don't clear pendingToolBatch — `user.message` events sometimes
        // appear mid-sequence (e.g., tool-response surrogates). The next
        // assistant.message will overwrite pendingToolBatch with its own
        // toolRequests if it kicks off a new batch.
        break;

      case "assistant.turn_start": {
        currentTurnId = d.turnId != null ? String(d.turnId) : null;
        const ts0 = ensureTurn(currentTurnId, lastModel);
        if (ts0) ts0.startedAt = ts;
        // Crucially, do NOT clear pendingToolBatch here: each turn contains
        // exactly one assistant.message, and the previous turn's tool
        // results are folded into the NEXT turn's prompt — that's the
        // attribution boundary we want.
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
        const name = d.toolName || d.name || "?";
        const tool = ensureTool(name);
        if (tool) {
          tool.calls++;
          tool._lastStart = ts;
        }
        const tt = ensureTurn(currentTurnId, lastModel);
        if (tt) {
          tt.toolCalls++;
          tt.tools.push({ name, callId: d.toolCallId || d.callId || d.id || null });
        }
        break;
      }

      case "tool.execution_complete": {
        const name = d.toolName || d.name || "?";
        const tool = perTool[name];
        if (tool && tool._lastStart && ts) {
          tool.durationMs += Math.max(0, ts - tool._lastStart);
          tool._lastStart = null;
        }
        break;
      }

      case "assistant.message": {
        totals.assistantMessages++;
        if (d.model) lastModel = d.model;
        const turnId = d.turnId != null ? String(d.turnId) : currentTurnId;
        ensureTurn(turnId, d.model);
        if (d.requestId && turnId != null) {
          requestIdToTurn[d.requestId] = turnId;
          // This API call's prompt was augmented by the *previous* message's
          // toolRequests' results — attribute its tokens to those tools.
          if (pendingToolBatch && pendingToolBatch.length) {
            requestIdToToolBatch[d.requestId] = pendingToolBatch.slice();
          }
        }
        // Remember any new tool requests so the *next* API call can be
        // attributed to them.
        pendingToolBatch =
          (d.toolRequests && d.toolRequests.length)
            ? d.toolRequests.map(r => r.name || r.toolName || "?")
            : null;
        break;
      }

      case "assistant.usage": {
        // Reserved for future CLI builds that emit usage in events.jsonl.
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

  // ── Fold in telemetry-log assistant_usage records (the real source of
  //    truth on current Copilot CLI builds).
  //
  // Bug repair: assistant_usage.input_tokens is always 0 when prompt caching
  // is active. The truthful value lives in the matching raw response
  // (telemetry.apiResponses[api_call_id]) — derived as
  //   prompt_tokens - cached_tokens - cache_creation_tokens.
  const apiResponses = telemetry.apiResponses || {};
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
      const inTok    = repairedInput(r, mt);
      const outTok   = n(mt.output_tokens);
      const crTok    = n(mt.cache_read_tokens);
      const cwTok    = n(mt.cache_write_tokens);
      const reasTok  = n(mt.reasoning_tokens);
      const costRaw  = n(mt.cost);
      const durMs    = n(mt.duration);

      const bucket = perModel[m] || (perModel[m] = bucketInit());
      bucket.inputTokens      += inTok;
      bucket.outputTokens     += outTok;
      bucket.cacheReadTokens  += crTok;
      bucket.cacheWriteTokens += cwTok;
      bucket.reasoningTokens  += reasTok;
      bucket.cost             += costRaw;
      bucket.apiCalls         += 1;
      bucket.durationMs       += durMs;

      totals.inputTokens      += inTok;
      totals.outputTokens     += outTok;
      totals.cacheReadTokens  += crTok;
      totals.cacheWriteTokens += cwTok;
      totals.reasoningTokens  += reasTok;
      totals.cost             += costRaw;
      totals.durationMs       += durMs;
      totals.apiCalls         += 1;

      const turnId = r.provider_call_id && requestIdToTurn[r.provider_call_id];
      if (turnId != null) {
        const turn = ensureTurn(turnId, m);
        if (turn) {
          turn.inputTokens      += inTok;
          turn.outputTokens     += outTok;
          turn.cacheReadTokens  += crTok;
          turn.cacheWriteTokens += cwTok;
          turn.reasoningTokens  += reasTok;
          turn.cost             += costRaw;
          turn.durationMs       += durMs;
          turn.apiCalls         += 1;
          turn.model = m;
        }
      }

      // Per-tool attribution: bill this API call's input/cache tokens to
      // the tools whose results were included in the prompt (split N ways).
      // We attribute input + cache_read + cache_write because the tool
      // result text shows up in all three buckets across consecutive calls.
      const toolBatch = r.provider_call_id && requestIdToToolBatch[r.provider_call_id];
      if (toolBatch && toolBatch.length) {
        const share = 1 / toolBatch.length;
        for (const name of toolBatch) {
          const tool = ensureTool(name);
          if (tool) {
            tool.inputTokens      += inTok    * share;
            tool.outputTokens     += outTok   * share;
            tool.cacheReadTokens  += crTok    * share;
            tool.cacheWriteTokens += cwTok    * share;
            tool.models[m] = (tool.models[m] || 0) + share;
          }
        }
      }
    }
  }

  // Fallback when neither events nor telemetry carry usage: use message-level
  // outputTokens for the output count (still useful even without telemetry).
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

  for (const turn of perTurn) {
    if (turn.durationMs < 0) turn.durationMs = 0;
  }

  // Derived totals (wire + billed, in tokens) and USD cost (per-model).
  totals.totalTokens  = totals.inputTokens + totals.outputTokens;
  totals.billedTokens =
    totals.inputTokens + totals.outputTokens +
    totals.cacheWriteTokens + Math.floor(totals.cacheReadTokens / 10);
  totals.promptTokens =
    totals.inputTokens + totals.cacheReadTokens + totals.cacheWriteTokens;

  for (const [m, b] of Object.entries(perModel)) {
    const usd = costForBucket(m, b);
    b.usdCost = usd == null ? 0 : usd;
    if (usd == null) totals.usdCostKnown = false;
    totals.usdCost += b.usdCost;
  }
  for (const turn of perTurn) {
    const usd = costForBucket(turn.model, turn);
    turn.usdCost = usd == null ? 0 : usd;
  }
  for (const tool of Object.values(perTool)) {
    // Round fractional shares back to integers for display.
    tool.inputTokens      = Math.round(tool.inputTokens);
    tool.outputTokens     = Math.round(tool.outputTokens);
    tool.cacheReadTokens  = Math.round(tool.cacheReadTokens);
    tool.cacheWriteTokens = Math.round(tool.cacheWriteTokens);
    // Drop internal scratch fields before serializing.
    delete tool._lastStart;
    // Tool USD uses the dominant model for that tool (most calls).
    const dom = Object.entries(tool.models).sort((a, b) => b[1] - a[1])[0];
    const m = dom ? dom[0] : lastModel;
    const usd = costForBucket(m, tool);
    tool.usdCost = usd == null ? 0 : usd;
  }

  // Context-window utilization: based on the most recent API call's prompt
  // size (cache_read + cache_write + input), not the cumulative total. We
  // pull this from the last telemetry record so /tokens reflects what the
  // model actually saw on the most recent call.
  let lastCallPromptTokens = 0;
  if (haveTelemetry && telemetry.usage.length > 0) {
    const lastCall = telemetry.usage[telemetry.usage.length - 1];
    const lmt = lastCall.metrics || {};
    lastCallPromptTokens =
      n(lmt.cache_read_tokens) + n(lmt.cache_write_tokens) + repairedInput(lastCall, lmt);
  }
  const window = contextWindow(lastModel);
  totals.contextWindow = window || null;
  totals.lastCallPromptTokens = lastCallPromptTokens;
  totals.contextUtilization = window && lastCallPromptTokens > 0
    ? Math.min(1, lastCallPromptTokens / window)
    : null;

  return {
    totals, perModel, perTurn, perTool,
    sessionFirstTs: firstTs, sessionLastTs: lastTs,
    lastModel,
    telemetryAvailable: haveTelemetry,
    telemetryRecords:   haveTelemetry ? telemetry.usage.length : 0,
    quota:              telemetry.quota || null,
  };
}

module.exports = { aggregate, bucketInit };
