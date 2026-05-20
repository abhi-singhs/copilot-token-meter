"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  parseTelemetryBlocks,
  parseApiResponseBlocks,
  findJsonBlock,
  safeResumeOffset,
} = require("../lib/telemetry");

function telemetryBlock(obj) {
  return `[Telemetry] cli.telemetry:\n${JSON.stringify(obj)}\n`;
}

function apiBlock(obj) {
  return `[DEBUG] data:\n${JSON.stringify(obj)}\n`;
}

test("parseTelemetryBlocks filters sessions, dedupes events, keeps quota, and stops before partial tail", () => {
  const seen = new Set();
  const text = [
    "noise before telemetry\n",
    telemetryBlock({
      kind: "assistant_usage",
      session_id: "session-a",
      properties: {
        event_id: "evt-1",
        model: "claude-sonnet-4.6",
        api_call_id: "api-1",
        provider_call_id: "provider-1",
        interaction_id: "interaction-1",
        initiator: "user",
        reasoning_effort: "medium",
      },
      metrics: {
        input_tokens: 10,
        output_tokens: 20,
        cache_read_tokens: 30,
        cache_write_tokens: 40,
        reasoning_tokens: 5,
        duration: 123,
      },
      created_at: "2025-01-01T00:00:00.000Z",
    }),
    telemetryBlock({
      kind: "assistant_usage",
      session_id: "other-session",
      properties: { event_id: "evt-other", model: "claude-sonnet-4.6" },
      metrics: { input_tokens: 999 },
    }),
    telemetryBlock({
      kind: "assistant_usage",
      session_id: "session-a",
      properties: { event_id: "evt-1", model: "claude-sonnet-4.6" },
      metrics: { input_tokens: 999 },
    }),
    telemetryBlock({
      kind: "copilot_user_info",
      session_id: "session-a",
      properties: { plan: "pro" },
      metrics: { quota_remaining: 123 },
    }),
    "[Telemetry] cli.telemetry:\n{\"kind\":\"assistant_usage\",\"session_id\":\"session-a\"",
  ].join("");

  const result = parseTelemetryBlocks(text, "session-a", seen);

  assert.equal(result.records.length, 2);
  assert.equal(result.records[0].event_id, "evt-1");
  assert.equal(result.records[0].api_call_id, "api-1");
  assert.equal(result.records[0].provider_call_id, "provider-1");
  assert.equal(result.records[0].metrics.cache_read_tokens, 30);
  assert.equal(result.records[1].__kind, "quota");
  assert.equal(result.records[1].metrics.quota_remaining, 123);
  assert.equal(seen.has("evt-1"), true);
  assert.equal(seen.has("evt-other"), false);
  assert.equal(result.committedEnd > 0, true);
  assert.equal(result.committedEnd < text.length, true);
});

test("parseApiResponseBlocks extracts usage records and skips non-usage JSON and garbage", () => {
  const text = [
    "garbage before first block\n",
    apiBlock({
      id: "msg-1",
      model: "claude-sonnet-4.6",
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        prompt_tokens_details: { cached_tokens: 30, cache_creation_tokens: 40 },
      },
    }),
    "non-JSON garbage between blocks { not actually a debug block }\n",
    apiBlock({ id: "msg-without-usage", model: "claude-sonnet-4.6" }),
    apiBlock({
      id: "msg-2",
      usage: {
        prompt_tokens: 7,
        prompt_tokens_details: {},
      },
    }),
  ].join("");

  const result = parseApiResponseBlocks(text);

  assert.equal(result.committedEnd, text.length);
  assert.deepEqual(result.records, [
    {
      msgId: "msg-1",
      model: "claude-sonnet-4.6",
      promptTokens: 100,
      completionTokens: 20,
      cachedTokens: 30,
      cacheCreationTokens: 40,
    },
    {
      msgId: "msg-2",
      model: null,
      promptTokens: 7,
      completionTokens: 0,
      cachedTokens: 0,
      cacheCreationTokens: 0,
    },
  ]);
});

test("findJsonBlock respects nested braces and escaped quotes inside strings", () => {
  const obj = {
    message: "literal } and { braces plus an escaped quote: \\\" done",
    nested: { value: 1 },
  };
  const text = `prefix\nHEADER\n${JSON.stringify(obj)}\nsuffix`;

  const found = findJsonBlock(text, 0, "HEADER\n");

  assert.equal(found.incomplete, undefined);
  assert.deepEqual(JSON.parse(found.block), obj);
  assert.equal(text.slice(found.blockEnd + 1), "\nsuffix");
});

test("safeResumeOffset resets on rotation or truncation and resumes normal growth", () => {
  assert.equal(safeResumeOffset({ ino: 1, offset: 50 }, { ino: 2, size: 100 }), 0);
  assert.equal(safeResumeOffset({ ino: 1, offset: 50 }, { ino: 1, size: 40 }), 0);
  assert.equal(safeResumeOffset({ ino: 1, offset: 50 }, { ino: 1, size: 80 }), 50);
  assert.equal(safeResumeOffset(null, { ino: 1, size: 80 }), 0);
});
