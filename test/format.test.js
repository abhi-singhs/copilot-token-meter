"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { n, formatTokens, formatMs, pad, formatTitle, formatStatusLine, parseDuration } = require("../lib/format");

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

test("parseDuration accepts s/m/h/d/w suffixes and bare seconds", () => {
  assert.equal(parseDuration("0"), 0);
  assert.equal(parseDuration("30"), 30 * 1000);
  assert.equal(parseDuration("30s"), 30 * 1000);
  assert.equal(parseDuration("5m"), 5 * 60_000);
  assert.equal(parseDuration("2h"), 2 * 3_600_000);
  assert.equal(parseDuration("7d"), 7 * 86_400_000);
  assert.equal(parseDuration("1w"), 7 * 86_400_000);
  assert.equal(parseDuration(" 10m "), 10 * 60_000);
  assert.equal(parseDuration("1.5h"), 1.5 * 3_600_000);
  assert.equal(parseDuration("2H"), 2 * 3_600_000);
});

test("parseDuration rejects malformed input", () => {
  assert.equal(parseDuration(""), null);
  assert.equal(parseDuration(null), null);
  assert.equal(parseDuration(undefined), null);
  assert.equal(parseDuration("abc"), null);
  assert.equal(parseDuration("10x"), null);
  assert.equal(parseDuration("-5m"), null);
  assert.equal(parseDuration("5 m extra"), null);
});

test("formatStatusLine renders compact tokens line without colour", () => {
  const agg = {
    totals: {
      inputTokens: 1234,
      outputTokens: 4567,
      cacheReadTokens: 88000,
      cacheWriteTokens: 5100,
      reasoningTokens: 1200,
      turns: 7,
      toolCalls: 23,
      contextUtilization: 0.42,
    },
  };

  assert.equal(
    formatStatusLine(agg, null, { color: false }),
    "↑1.2k ↓4.6k ⟳88.0k ⊕5.1k 🧠1.2k · 📦42% · 7t/23🔧",
  );
});

test("formatStatusLine prefers Copilot payload context % over aggregator value", () => {
  const agg = {
    totals: {
      inputTokens: 100, outputTokens: 200,
      cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
      turns: 1, toolCalls: 0,
      contextUtilization: 0.10,
    },
  };
  const payload = {
    context_window: { current_context_used_percentage: 85.6 },
  };

  const line = formatStatusLine(agg, payload, { color: false });
  assert.equal(line.includes("📦86%"), true, "should round payload pct: " + line);
  assert.equal(line.includes("📦10%"), false, "should ignore aggregator pct when payload present");
});

test("formatStatusLine omits zero-valued optional counters and turns/tools", () => {
  const agg = {
    totals: {
      inputTokens: 50, outputTokens: 75,
      cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
      turns: 0, toolCalls: 0,
    },
  };

  assert.equal(
    formatStatusLine(agg, null, { color: false }),
    "↑50 ↓75",
  );
});

test("formatStatusLine emits ANSI escapes when color enabled", () => {
  const agg = {
    totals: {
      inputTokens: 10, outputTokens: 20,
      cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
      turns: 0, toolCalls: 0,
    },
  };

  const line = formatStatusLine(agg, null, { color: true });
  assert.equal(line.includes("\x1b["), true, "should contain ANSI escapes: " + line);
});

test("formatStatusLine clamps context % to [0, 100]", () => {
  const agg = { totals: { inputTokens: 0, outputTokens: 0, turns: 0, toolCalls: 0 } };

  // Way over 100 from a buggy payload.
  const high = formatStatusLine(agg, { context_window: { current_context_used_percentage: 500 } }, { color: false });
  assert.equal(high.includes("📦100%"), true, "should clamp >100: " + high);

  // Negative from a buggy payload.
  const low = formatStatusLine(agg, { context_window: { current_context_used_percentage: -10 } }, { color: false });
  assert.equal(low.includes("📦0%"), true, "should clamp <0: " + low);
});

test("formatStatusLine tolerates missing totals and payload entirely", () => {
  assert.equal(formatStatusLine({}, null, { color: false }), "↑0 ↓0");
  assert.equal(formatStatusLine(null, null, { color: false }), "↑0 ↓0");
});
