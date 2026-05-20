"use strict";

// Coerce to a finite number, treating everything else as 0. The aggregator
// runs on log-derived data that may contain nulls, strings, or NaN; this
// keeps a single bad record from poisoning a total.
function n(v) { return typeof v === "number" && isFinite(v) ? v : 0; }

function formatTokens(num) {
  if (num >= 1_000_000) return (num / 1_000_000).toFixed(2) + "M";
  if (num >= 1_000)     return (num / 1_000).toFixed(1) + "k";
  return String(num);
}

function formatMs(ms) {
  if (!ms) return "—";
  if (ms < 1000) return ms + "ms";
  if (ms < 60_000) return (ms / 1000).toFixed(1) + "s";
  const m = Math.floor(ms / 60_000), s = Math.floor((ms % 60_000) / 1000);
  return `${m}m${s.toString().padStart(2, "0")}s`;
}

function pad(s, w) { s = String(s); return s.length >= w ? s : s + " ".repeat(w - s.length); }

// Build the OSC 2 title string. Compact format optimized for terminal title
// bars (~80–160 chars max). Includes only counters that are > 0 to avoid
// noise during cold-start turns.
function formatTitle(agg) {
  const t = agg.totals;
  const model = agg.lastModel || "copilot";
  const parts = [
    `↑${formatTokens(t.inputTokens)}`,
    `↓${formatTokens(t.outputTokens)}`,
  ];
  if (t.cacheReadTokens)  parts.push(`⟳${formatTokens(t.cacheReadTokens)}`);
  if (t.cacheWriteTokens) parts.push(`⊕${formatTokens(t.cacheWriteTokens)}`);
  if (t.reasoningTokens)  parts.push(`🧠${formatTokens(t.reasoningTokens)}`);
  parts.push(`${t.turns}t/${t.toolCalls}🔧`);
  return `copilot[${model.replace(/^claude-/, "")}] ${parts.join(" ")}`;
}

module.exports = { n, formatTokens, formatMs, pad, formatTitle };
