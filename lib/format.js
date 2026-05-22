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

// Parse a short duration string like "30s", "10m", "2h", "7d", "1w" into
// milliseconds. Bare numbers are treated as seconds. Returns null for
// malformed input so callers can render their own error message.
function parseDuration(s) {
  if (s == null || s === "") return null;
  const m = String(s).trim().match(/^(\d+(?:\.\d+)?)\s*([smhdw]?)$/i);
  if (!m) return null;
  const value = parseFloat(m[1]);
  if (!isFinite(value) || value < 0) return null;
  const unit = (m[2] || "s").toLowerCase();
  const mult = {
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
    w: 604_800_000,
  }[unit];
  return mult == null ? null : value * mult;
}

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

// ANSI colour helpers for formatStatusLine. Kept inline so the module stays
// dependency-free and so callers can opt out by passing `color: false`.
const ANSI = {
  reset: "\x1b[0m",
  bold:  "\x1b[1m",
  dim:   "\x1b[2m",
  red:   "\x1b[31m",
  green: "\x1b[32m",
  yel:   "\x1b[33m",
  blue:  "\x1b[34m",
  mag:   "\x1b[35m",
  cyan:  "\x1b[36m",
  gray:  "\x1b[90m",
};

// Build the single-line status string rendered by the Copilot CLI custom
// status line (statusLine.command). Designed to live in the footer alongside
// the built-in items, so it focuses on the unique data the plugin produces:
// repaired input / cache / reasoning token counts plus turn / tool activity.
//
//   ↑12.3k ↓45.6k ⟳88.0k ⊕5.1k 🧠1.2k · 📦25% · 7t/23🔧
//
// `agg` is the aggregator output (or a cached status JSON with the same
// shape). `payload` is the optional Copilot CLI stdin payload — when present,
// its live `context_window.current_context_used_percentage` and friends are
// preferred over the events-derived values because they reflect what the
// model just saw. `options.color` toggles ANSI output (default true).
function formatStatusLine(agg, payload, options) {
  const opts = options || {};
  const useColor = opts.color !== false;
  const c = (color, s) => (useColor ? ANSI[color] + s + ANSI.reset : s);

  const t = (agg && agg.totals) || {};
  const inTok    = n(t.inputTokens);
  const outTok   = n(t.outputTokens);
  const crTok    = n(t.cacheReadTokens);
  const cwTok    = n(t.cacheWriteTokens);
  const reasTok  = n(t.reasoningTokens);
  const turns    = n(t.turns);
  const tools    = n(t.toolCalls);

  // Prefer the live context % Copilot itself reports in the stdin payload
  // (current_context_used_percentage); fall back to the aggregator's
  // last-call estimate (contextUtilization is 0–1 in our schema).
  let ctxPct = null;
  const cw = payload && payload.context_window;
  if (cw && typeof cw.current_context_used_percentage === "number") {
    ctxPct = Math.max(0, Math.min(100, cw.current_context_used_percentage));
  } else if (typeof t.contextUtilization === "number") {
    ctxPct = Math.max(0, Math.min(100, t.contextUtilization * 100));
  }

  const parts = [
    c("cyan",  `↑${formatTokens(inTok)}`),
    c("green", `↓${formatTokens(outTok)}`),
  ];
  if (crTok)   parts.push(c("blue", `⟳${formatTokens(crTok)}`));
  if (cwTok)   parts.push(c("mag",  `⊕${formatTokens(cwTok)}`));
  if (reasTok) parts.push(c("mag",  `🧠${formatTokens(reasTok)}`));

  if (ctxPct != null) {
    const pctStr = ctxPct.toFixed(0) + "%";
    const ctxColor = ctxPct >= 95 ? "red" : ctxPct >= 80 ? "yel" : "green";
    parts.push(c("gray", "·"));
    parts.push(c(ctxColor, `📦${pctStr}`));
  }

  if (turns || tools) {
    parts.push(c("gray", "·"));
    parts.push(c("gray", `${turns}t/${tools}🔧`));
  }

  return parts.join(" ");
}

module.exports = { n, formatTokens, formatMs, pad, formatTitle, formatStatusLine, parseDuration };
