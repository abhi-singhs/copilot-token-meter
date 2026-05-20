"use strict";

const fs   = require("fs");
const path = require("path");
const os   = require("os");

// Per-model metadata — context-window sizes used for the utilization
// indicator. USD pricing was removed; for authoritative billing use
// `/usage` inside Copilot CLI.
//
// `contextWindow` is the model's prompt window in tokens.
//
// `match` is a list of substrings — the longest match wins. Names are matched
// case-insensitively against the resolved model string.
//
// Users can override / extend this table via
// ~/.copilot/state/token-meter/models.json.
const DEFAULT_PRICING = {
  models: [
    { match: ["opus-4.7-1m"],   contextWindow: 1_000_000 },
    { match: ["opus-4.7"],      contextWindow:   200_000 },
    { match: ["opus-4.6"],      contextWindow:   200_000 },
    { match: ["opus-4.5"],      contextWindow:   200_000 },
    { match: ["opus"],          contextWindow:   200_000 },
    { match: ["sonnet-4.6"],    contextWindow:   200_000 },
    { match: ["sonnet-4.5"],    contextWindow:   200_000 },
    { match: ["sonnet"],        contextWindow:   200_000 },
    { match: ["haiku-4.5"],     contextWindow:   200_000 },
    { match: ["haiku"],         contextWindow:   200_000 },
    { match: ["gpt-5.5"],       contextWindow:   400_000 },
    { match: ["gpt-5.4-mini", "gpt-5-mini"], contextWindow: 400_000 },
    { match: ["gpt-5.4", "gpt-5.3", "gpt-5.2", "gpt-5"], contextWindow: 400_000 },
    { match: ["gpt-4.1"],       contextWindow: 1_000_000 },
  ],
};

const OVERRIDE_PATH = path.join(
  process.env.COPILOT_HOME || path.join(os.homedir(), ".copilot"),
  "state", "token-meter", "models.json"
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

function contextWindow(model) {
  const info = modelInfo(model);
  return info ? info.contextWindow : null;
}

module.exports = {
  modelInfo,
  contextWindow,
  DEFAULT_PRICING,
  _resetCache,
};
