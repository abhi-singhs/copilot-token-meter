"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { modelInfo, contextWindow, _resetCache } = require("../lib/pricing");

test("modelInfo uses the longest matching context-window entry", () => {
  _resetCache();
  const info = modelInfo("claude-opus-4.7-1m-internal");

  assert.deepEqual(info.match, ["opus-4.7-1m"]);
  assert.equal(info.contextWindow, 1_000_000);
  assert.equal(modelInfo("claude-opus-4.7").contextWindow, 200_000);
});

test("contextWindow returns known model window size", () => {
  _resetCache();
  assert.equal(contextWindow("claude-opus-4.7-1m-internal"), 1_000_000);
  assert.equal(contextWindow("claude-sonnet-4.6"), 200_000);
  assert.equal(contextWindow("not-a-known-model"), null);
});
