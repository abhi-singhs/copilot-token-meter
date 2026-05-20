"use strict";

const fs   = require("fs");
const path = require("path");
const os   = require("os");

// Per-model pricing. Numbers are USD per 1M tokens.
//
// Sources (Anthropic Claude — published pricing):
//   - opus 4.x:   $15 input / $75 output / $1.50 cache_read / $18.75 cache_write (5m)
//   - sonnet 4.x: $3  input / $15 output / $0.30 cache_read / $3.75  cache_write (5m)
//   - haiku 4.x:  $1  input / $5  output / $0.10 cache_read / $1.25  cache_write (5m)
//
// `contextWindow` is the model's prompt window in tokens. We use it for the
// context-utilization % indicator (T1.3).
//
// `match` is a list of substrings — the longest match wins. Names are matched
// case-insensitively against the resolved model string.
//
// Users can override / extend this table via
// ~/.copilot/state/token-meter/pricing.json. Missing fields fall back to the
// built-in entry; entirely unknown models report unknown ($0 derived) so the
// USD column degrades cleanly instead of misleading.
const DEFAULT_PRICING = {
  models: [
    { match: ["opus-4.7-1m"],   input: 15.00, output: 75.00, cacheRead: 1.50, cacheWrite: 18.75, contextWindow: 1_000_000 },
    { match: ["opus-4.7"],      input: 15.00, output: 75.00, cacheRead: 1.50, cacheWrite: 18.75, contextWindow:   200_000 },
    { match: ["opus-4.6"],      input: 15.00, output: 75.00, cacheRead: 1.50, cacheWrite: 18.75, contextWindow:   200_000 },
    { match: ["opus-4.5"],      input: 15.00, output: 75.00, cacheRead: 1.50, cacheWrite: 18.75, contextWindow:   200_000 },
    { match: ["opus"],          input: 15.00, output: 75.00, cacheRead: 1.50, cacheWrite: 18.75, contextWindow:   200_000 },
    { match: ["sonnet-4.6"],    input:  3.00, output: 15.00, cacheRead: 0.30, cacheWrite:  3.75, contextWindow:   200_000 },
    { match: ["sonnet-4.5"],    input:  3.00, output: 15.00, cacheRead: 0.30, cacheWrite:  3.75, contextWindow:   200_000 },
    { match: ["sonnet"],        input:  3.00, output: 15.00, cacheRead: 0.30, cacheWrite:  3.75, contextWindow:   200_000 },
    { match: ["haiku-4.5"],     input:  1.00, output:  5.00, cacheRead: 0.10, cacheWrite:  1.25, contextWindow:   200_000 },
    { match: ["haiku"],         input:  1.00, output:  5.00, cacheRead: 0.10, cacheWrite:  1.25, contextWindow:   200_000 },
    { match: ["gpt-5.5"],       input:  2.50, output: 20.00, cacheRead: 0.25, cacheWrite:  2.50, contextWindow:   400_000 },
    { match: ["gpt-5.4-mini", "gpt-5-mini"], input: 0.25, output: 2.00, cacheRead: 0.025, cacheWrite: 0.25, contextWindow: 400_000 },
    { match: ["gpt-5.4", "gpt-5.3", "gpt-5.2", "gpt-5"], input: 1.25, output: 10.00, cacheRead: 0.125, cacheWrite: 1.25, contextWindow: 400_000 },
    { match: ["gpt-4.1"],       input:  2.00, output:  8.00, cacheRead: 0.50, cacheWrite:  2.00, contextWindow: 1_000_000 },
  ],
};

const OVERRIDE_PATH = path.join(
  process.env.COPILOT_HOME || path.join(os.homedir(), ".copilot"),
  "state", "token-meter", "pricing.json"
);

let _cached = null;
function loadPricing() {
  if (_cached) return _cached;
  let table = { models: DEFAULT_PRICING.models.slice() };
  try {
    if (fs.existsSync(OVERRIDE_PATH)) {
      const user = JSON.parse(fs.readFileSync(OVERRIDE_PATH, "utf8"));
      if (user && Array.isArray(user.models)) {
        // User entries override builtins by match-prefix; new entries get
        // appended at the front so they're tried first.
        table.models = user.models.concat(DEFAULT_PRICING.models);
      }
    }
  } catch (_) { /* malformed override — fall back to defaults */ }
  _cached = table;
  return _cached;
}

function _resetCache() { _cached = null; } // for tests

function modelInfo(model) {
  if (!model) return null;
  const key = String(model).toLowerCase();
  const table = loadPricing();
  let best = null, bestLen = -1;
  for (const m of table.models) {
    for (const tag of m.match) {
      if (key.indexOf(tag) !== -1 && tag.length > bestLen) {
        best = m;
        bestLen = tag.length;
      }
    }
  }
  return best;
}

// Compute USD cost for a token bucket. Uses Anthropic-style per-million
// pricing across input, output, cache_read, cache_write. Returns null when
// the model is unknown so the caller can render "—" instead of a misleading
// $0.00.
function costForBucket(model, bucket) {
  const info = modelInfo(model);
  if (!info) return null;
  const cost =
      (bucket.inputTokens      || 0) * info.input      / 1_000_000
    + (bucket.outputTokens     || 0) * info.output     / 1_000_000
    + (bucket.cacheReadTokens  || 0) * info.cacheRead  / 1_000_000
    + (bucket.cacheWriteTokens || 0) * info.cacheWrite / 1_000_000;
  return cost;
}

function contextWindow(model) {
  const info = modelInfo(model);
  return info ? info.contextWindow : null;
}

function formatUSD(usd) {
  if (usd == null) return "—";
  if (usd < 0.01)  return "$" + usd.toFixed(4);
  if (usd < 1)     return "$" + usd.toFixed(3);
  if (usd < 100)   return "$" + usd.toFixed(2);
  return "$" + Math.round(usd).toLocaleString();
}

module.exports = {
  modelInfo,
  costForBucket,
  contextWindow,
  formatUSD,
  DEFAULT_PRICING,
  _resetCache,
};
