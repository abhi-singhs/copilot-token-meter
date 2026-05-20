"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { aggregate, dominantEffort } = require("../lib/aggregate");

function telemetryUsage(overrides) {
  return {
    event_id: "evt",
    model: "claude-sonnet-4.6",
    api_call_id: null,
    provider_call_id: null,
    metrics: {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      duration: 0,
    },
    ...overrides,
    metrics: {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      duration: 0,
      ...(overrides && overrides.metrics),
    },
  };
}

test("attributes telemetry cache tokens to the tool batch folded into the next API call", () => {
  const events = [
    { type: "assistant.turn_start", data: { turnId: "1" } },
    { type: "assistant.message", data: { turnId: "1", requestId: "req-tools", model: "claude-sonnet-4.6", toolRequests: [{ name: "bash" }] } },
    { type: "tool.execution_start", data: { name: "bash", toolCallId: "tool-1" } },
    { type: "assistant.turn_end", data: { turnId: "1" } },
    { type: "assistant.turn_start", data: { turnId: "2" } },
    { type: "assistant.message", data: { turnId: "2", requestId: "req-after-tools", model: "claude-sonnet-4.6" } },
    { type: "assistant.turn_end", data: { turnId: "2" } },
  ];
  const telemetry = {
    usage: [telemetryUsage({
      event_id: "evt-1",
      provider_call_id: "req-after-tools",
      metrics: { input_tokens: 12, output_tokens: 5, cache_read_tokens: 90, cache_write_tokens: 30 },
    })],
    quota: null,
    apiResponses: {},
  };

  const agg = aggregate(events, telemetry);

  assert.equal(agg.totals.turns, 2);
  assert.equal(agg.perTool.bash.cacheReadTokens, 90);
  assert.equal(agg.perTool.bash.cacheWriteTokens, 30);
  assert.equal(agg.perTool.bash.cacheReadTokens > 0, true);
});

test("repairs zero input_tokens from matching API response prompt details", () => {
  const telemetry = {
    usage: [telemetryUsage({
      event_id: "evt-repair",
      api_call_id: "api-1",
      provider_call_id: "provider-1",
      metrics: { input_tokens: 0, output_tokens: 5, cache_read_tokens: 30, cache_write_tokens: 50 },
    })],
    quota: null,
    apiResponses: {
      "api-1": { promptTokens: 100, cachedTokens: 30, cacheCreationTokens: 50 },
    },
  };

  const agg = aggregate([], telemetry);

  assert.equal(agg.totals.inputTokens, 20);
  assert.equal(agg.totals.promptTokens, 100);
});

test("uses assistant.message outputTokens as events-only fallback", () => {
  const events = [
    { type: "assistant.turn_start", data: { turnId: "1" } },
    { type: "assistant.message", data: { turnId: "1", model: "claude-sonnet-4.6", outputTokens: 37 } },
    { type: "assistant.turn_end", data: { turnId: "1" } },
  ];

  const agg = aggregate(events, { usage: [], quota: null, apiResponses: {} });

  assert.equal(agg.totals.outputTokens, 37);
  assert.equal(agg.perModel["claude-sonnet-4.6"].outputTokens, 37);
});

test("splits next API call tokens equally across a requested tool batch", () => {
  const events = [
    { type: "assistant.turn_start", data: { turnId: "1" } },
    { type: "assistant.message", data: { turnId: "1", requestId: "req-tools", model: "claude-sonnet-4.6", toolRequests: [{ name: "a" }, { name: "b" }] } },
    { type: "assistant.turn_end", data: { turnId: "1" } },
    { type: "assistant.turn_start", data: { turnId: "2" } },
    { type: "assistant.message", data: { turnId: "2", requestId: "req-after-tools", model: "claude-sonnet-4.6" } },
    { type: "assistant.turn_end", data: { turnId: "2" } },
  ];
  const telemetry = {
    usage: [telemetryUsage({
      event_id: "evt-split",
      provider_call_id: "req-after-tools",
      metrics: { input_tokens: 100, output_tokens: 10, cache_read_tokens: 40, cache_write_tokens: 20 },
    })],
    quota: null,
    apiResponses: {},
  };

  const agg = aggregate(events, telemetry);

  assert.equal(agg.perTool.a.inputTokens, 50);
  assert.equal(agg.perTool.b.inputTokens, 50);
  assert.equal(agg.perTool.a.outputTokens, 5);
  assert.equal(agg.perTool.b.outputTokens, 5);
  assert.equal(agg.perTool.a.cacheReadTokens, 20);
  assert.equal(agg.perTool.b.cacheWriteTokens, 10);
});

test("sets context utilization for known models and null for unknown models", () => {
  const known = aggregate([], {
    usage: [telemetryUsage({
      event_id: "evt-known",
      model: "claude-sonnet-4.6",
      metrics: { input_tokens: 100, cache_read_tokens: 100, cache_write_tokens: 0 },
    })],
    quota: null,
    apiResponses: {},
  });
  const unknown = aggregate([], {
    usage: [telemetryUsage({
      event_id: "evt-unknown",
      model: "mystery-model",
      metrics: { input_tokens: 100, cache_read_tokens: 100, cache_write_tokens: 0 },
    })],
    quota: null,
    apiResponses: {},
  });

  assert.equal(known.totals.contextWindow, 200_000);
  assert.equal(known.totals.lastCallPromptTokens, 200);
  assert.equal(known.totals.contextUtilization, 0.001);
  assert.equal(unknown.totals.contextWindow, null);
  assert.equal(unknown.totals.contextUtilization, null);
});

test("counts turns, tool calls, and user messages exactly", () => {
  const events = [
    { type: "user.message", data: {} },
    { type: "assistant.turn_start", data: { turnId: "1" } },
    { type: "tool.execution_start", data: { name: "a" } },
    { type: "tool.execution_start", data: { name: "b" } },
    { type: "assistant.turn_end", data: { turnId: "1" } },
    { type: "user.message", data: {} },
    { type: "assistant.turn_start", data: { turnId: "2" } },
    { type: "tool.execution_start", data: { name: "c" } },
    { type: "assistant.turn_end", data: { turnId: "2" } },
    { type: "assistant.turn_start", data: { turnId: "3" } },
    { type: "tool.execution_start", data: { name: "d" } },
    { type: "tool.execution_start", data: { name: "e" } },
    { type: "assistant.turn_end", data: { turnId: "3" } },
  ];

  const agg = aggregate(events, { usage: [], quota: null, apiResponses: {} });

  assert.equal(agg.totals.turns, 3);
  assert.equal(agg.totals.toolCalls, 5);
  assert.equal(agg.totals.userMessages, 2);
});

test("dominantEffort returns null, single label, or modal-plus suffix", () => {
  assert.equal(dominantEffort(null), null);
  assert.equal(dominantEffort({}), null);
  assert.equal(dominantEffort({ low: 0 }), null);
  assert.equal(dominantEffort({ high: 4 }), "high");
  assert.equal(dominantEffort({ high: 4, medium: 2 }), "high+");
  assert.equal(dominantEffort({ medium: 5, low: 1, high: 1 }), "medium+");
});

test("aggregates reasoning_effort per model and surfaces dominantEffort", () => {
  const telemetry = {
    usage: [
      telemetryUsage({ event_id: "e1", model: "gpt-5.4", reasoning_effort: "high",
        metrics: { input_tokens: 10, output_tokens: 1 } }),
      telemetryUsage({ event_id: "e2", model: "gpt-5.4", reasoning_effort: "high",
        metrics: { input_tokens: 10, output_tokens: 1 } }),
      telemetryUsage({ event_id: "e3", model: "gpt-5.4", reasoning_effort: "medium",
        metrics: { input_tokens: 10, output_tokens: 1 } }),
      telemetryUsage({ event_id: "e4", model: "claude-sonnet-4.6",
        metrics: { input_tokens: 5, output_tokens: 1 } }),
    ],
    quota: null,
    apiResponses: {},
  };

  const agg = aggregate([], telemetry);

  assert.equal(agg.perModel["gpt-5.4"].efforts.high, 2);
  assert.equal(agg.perModel["gpt-5.4"].efforts.medium, 1);
  assert.equal(agg.perModel["gpt-5.4"].dominantEffort, "high+");
  assert.equal(agg.perModel["claude-sonnet-4.6"].dominantEffort, null);
});
