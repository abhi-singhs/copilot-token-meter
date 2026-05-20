"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { modelInfo, costForBucket, contextWindow, formatUSD, _resetCache } = require("../lib/pricing");

test("modelInfo uses the longest matching pricing entry", () => {
  _resetCache();
  const info = modelInfo("claude-opus-4.7-1m-internal");

  assert.deepEqual(info.match, ["opus-4.7-1m"]);
  assert.equal(info.contextWindow, 1_000_000);
  assert.equal(modelInfo("claude-opus-4.7").contextWindow, 200_000);
});

test("costForBucket computes per-million token cost", () => {
  _resetCache();
  const cost = costForBucket("claude-sonnet-4.6", {
    inputTokens: 1_000_000,
    outputTokens: 2_000_000,
    cacheReadTokens: 3_000_000,
    cacheWriteTokens: 4_000_000,
  });

  assert.equal(cost, 48.9);
  assert.equal(costForBucket("unknown-model", { inputTokens: 1_000_000 }), null);
});

test("contextWindow returns known model window size", () => {
  _resetCache();
  assert.equal(contextWindow("claude-opus-4.7-1m-internal"), 1_000_000);
  assert.equal(contextWindow("claude-sonnet-4.6"), 200_000);
  assert.equal(contextWindow("not-a-known-model"), null);
});

test("formatUSD renders small and large currency values", () => {
  assert.equal(formatUSD(0.0001), "$0.0001");
  assert.equal(formatUSD(0.01), "$0.010");
  assert.equal(formatUSD(0.50), "$0.500");
  assert.equal(formatUSD(5.99), "$5.99");
  assert.equal(formatUSD(123), "$123");
  assert.equal(formatUSD(null), "—");
});
