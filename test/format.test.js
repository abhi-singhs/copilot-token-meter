"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { n, formatTokens, formatMs, pad, formatTitle } = require("../lib/format");

test("n coerces only finite numbers", () => {
  assert.equal(n(42), 42);
  assert.equal(n(-1.5), -1.5);
  assert.equal(n("42"), 0);
  assert.equal(n(null), 0);
  assert.equal(n(NaN), 0);
  assert.equal(n(Infinity), 0);
  assert.equal(n(-Infinity), 0);
});

test("formatTokens renders compact token counts", () => {
  assert.equal(formatTokens(0), "0");
  assert.equal(formatTokens(999), "999");
  assert.equal(formatTokens(1000), "1.0k");
  assert.equal(formatTokens(999_400), "999.4k");
  assert.equal(formatTokens(1_000_000), "1.00M");
  assert.equal(formatTokens(5_500_000), "5.50M");
});

test("formatMs renders milliseconds, seconds, and minutes", () => {
  assert.equal(formatMs(0), "—");
  assert.equal(formatMs(999), "999ms");
  assert.equal(formatMs(1500), "1.5s");
  assert.equal(formatMs(90_000), "1m30s");
});

test("pad appends spaces up to the requested width", () => {
  assert.equal(pad("x", 3), "x  ");
  assert.equal(pad("long", 2), "long");
  assert.equal(pad(7, 3), "7  ");
});

test("formatTitle builds compact terminal title text", () => {
  const agg = {
    lastModel: "claude-sonnet-4.6",
    totals: {
      inputTokens: 1000,
      outputTokens: 2000,
      cacheReadTokens: 3000,
      cacheWriteTokens: 4000,
      reasoningTokens: 5000,
      turns: 2,
      toolCalls: 3,
    },
  };

  assert.equal(
    formatTitle(agg),
    "copilot[sonnet-4.6] ↑1.0k ↓2.0k ⟳3.0k ⊕4.0k 🧠5.0k 2t/3🔧",
  );

  assert.equal(
    formatTitle({ lastModel: null, totals: { inputTokens: 0, outputTokens: 0, turns: 0, toolCalls: 0 } }),
    "copilot[copilot] ↑0 ↓0 0t/0🔧",
  );
});
