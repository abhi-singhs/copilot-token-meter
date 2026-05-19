# copilot-token-meter

> Live token & cost meter for **GitHub Copilot CLI**. Shows input / output / cache tokens, cost, and agent activity for every prompt — in your terminal title bar, in a live dashboard, and via a `/tokens` slash command.

## What you get

| Surface | How |
|---|---|
| **Always-visible "footer"** | The plugin hooks `sessionStart`, `userPromptSubmitted`, `postToolUse`, and `agentStop` and writes a one-line summary to your terminal title bar via OSC 2. Works in iTerm2, Kitty, Alacritty, WezTerm, Terminal.app, gnome-terminal, Windows Terminal. |
| **`/tokens` slash command** | Inside Copilot CLI, type `/tokens` for a multi-line breakdown — per-model, per-turn, with cost & quota. |
| **`copilot-tokens` CLI** | Companion CLI with `status`, `summary`, `watch`, `top`, `json`, `recompute` subcommands for use in a second pane / tmux / CI. |
| **Status JSON for other tools** | `~/.copilot/state/token-meter/latest.json` is rewritten on every hook tick — point your tmux status bar, polybar, iTerm status, or VS Code status item at it. |

## Why a plugin (and not the built-in footer)?

Copilot CLI's built-in footer (`settings.json` → `footer`) only supports a fixed set of toggles (`showModelEffort`, `showDirectory`, `showBranch`, `showContextWindow`, `showQuota`). There is no public API for plugins to inject custom footer items.

This plugin works around that by piggy-backing on three stable contracts the CLI already exposes:

1. **Plugin lifecycle hooks** (`sessionStart`, `userPromptSubmitted`, `postToolUse`, `agentStop`).
2. **`events.jsonl`** in `~/.copilot/session-state/<sessionId>/` — typed against `schemas/session-events.schema.json` — for turn / tool / message / model activity and the `assistant.message.outputTokens` field.
3. **Process telemetry log** at `~/.copilot/logs/process-*.log` — the CLI writes one debug log per process containing `[Telemetry] cli.telemetry:` JSON blocks. Each `kind: "assistant_usage"` block carries the full token / cache / cost breakdown (`input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, `reasoning_tokens`, `cost`, `duration`, `ttft_ms`) and is joined back to the originating turn via `provider_call_id` ↔ `assistant.message.requestId`. Each `kind: "copilot_user_info"` block carries a live quota snapshot.

The hook script merges the two sources, aggregates totals, and writes an OSC 2 title-bar escape to `/dev/tty` so you get a true always-visible footer above your shell prompt.

> Telemetry-log parsing is incremental: per-`(session, log)` byte offsets are cached in `~/.copilot/state/token-meter/telemetry-cache.json`, so only the new tail of each log is read on every hook tick. Event IDs are deduped so the same usage event isn't billed twice when multiple processes touch the same session.

## Install

The plugin lives in this repository. Install it into Copilot CLI from wherever you cloned it:

```bash
# From an absolute local path (recommended while iterating):
copilot plugin install /Users/abhisingh/Documents/copilot-token-meter

# Or once pushed to GitHub:
copilot plugin install abhi-singhs/copilot-token-meter
```

`copilot plugin install <path>` snapshots the folder into
`~/.copilot/installed-plugins/_direct/copilot-token-meter/` and registers it in
`~/.copilot/config.json` with `source: { source: "local", path: "<your path>" }`.

After editing files in this folder, refresh the snapshot:

```bash
copilot plugin update copilot-token-meter
```

To uninstall:

```bash
copilot plugin uninstall copilot-token-meter
```

> **Important:** Plugins are loaded once per `copilot` session. Restart the
> CLI after install / update for hooks to take effect.

Add the `bin/` directory to your `$PATH` (optional — only needed to call
`copilot-tokens` directly from your shell):

```bash
export PATH="$HOME/Documents/copilot-token-meter/bin:$PATH"
```

The plugin uses only Node's built-in modules — no `npm install` needed.

### Recommended companion settings

In `~/.copilot/settings.json`:

```json
{
  "footer": {
    "showContextWindow": true,
    "showQuota": true
  }
}
```

These are built-in items that give you complementary signal (context-window % full and remaining premium-request quota) alongside the token-meter's title-bar.

## Usage

### Inside Copilot CLI

```
> /tokens
```

The skill runs `copilot-tokens summary` and replies with the formatted breakdown.

### From a shell

```bash
copilot-tokens                 # one-line summary
copilot-tokens summary         # detailed multi-line breakdown
copilot-tokens watch           # live dashboard, refreshes every 1s
copilot-tokens top             # top sessions by total tokens, all time
copilot-tokens json            # raw status JSON (for scripting)
copilot-tokens recompute       # force re-scan of the current session
```

### From tmux

```tmux
set -g status-right '#(cat ~/.copilot/state/token-meter/latest.json 2>/dev/null | jq -r .title) | %H:%M'
```

### From iTerm2 / WezTerm status bar

Read `~/.copilot/state/token-meter/latest.json` and render the `.title` field.

## Title bar format

```
copilot[opus-4.7-xhigh] ↑12.3k ↓4.2k ⟳88.0k ⊕5.1k 🧠1.2k 7t/23🔧
```

| Symbol | Meaning |
|---|---|
| `↑` | input tokens (new prompt tokens sent to the model) |
| `↓` | output tokens (model's reply tokens) |
| `⟳` | cache **read** tokens (reused prefix from prompt cache) |
| `⊕` | cache **write** tokens (new prefix written to prompt cache) |
| `🧠` | reasoning tokens (shown only when > 0; OpenAI reasoning models, etc.) |
| `Nt/M🔧` | turns / tool calls |

The `summary` view additionally shows: prompt-tokens (= input + cache_read + cache_write — what actually crossed the wire), total billed tokens (Anthropic discounted formula), cost in raw CLI units, cumulative API duration, and a live `Quota` block sourced from `copilot_user_info` telemetry events.

## State files

| Path | Purpose |
|---|---|
| `~/.copilot/state/token-meter/latest.json` | Snapshot of the most recently updated session. |
| `~/.copilot/state/token-meter/<sessionId>.json` | Per-session snapshot. |
| `~/.copilot/state/token-meter/current` | Plain-text file containing the current session ID. |
| `~/.copilot/state/token-meter/telemetry-cache.json` | Per-`(session, log)` byte offsets + de-duped `event_id` set for incremental telemetry parsing. |
| `~/.copilot/state/token-meter/hooks.log` | One-line trace per hook invocation (handy for debugging that hooks fire at all). |
| `~/.copilot/state/token-meter/errors.log` | Hook error log (rotated by `logrotate` etc.). |

## How accurate are the numbers?

- **Output tokens & activity** (turns, tool calls, message counts, model) come from `events.jsonl`, which is the same record the CLI's own UI reads from. These are always present.
- **Input / cache_read / cache_write / reasoning / cost / duration** come from `[Telemetry] cli.telemetry:` `assistant_usage` blocks in `~/.copilot/logs/process-*.log`. The plugin joins each usage block to the originating turn via `provider_call_id` ↔ `assistant.message.requestId`. These match exactly what the CLI reports to its quota service.
- **Reasoning tokens** are surfaced separately when the provider reports them (OpenAI o-series / gpt-5 reasoning models). Anthropic does not split reasoning out from output tokens, so `🧠` typically reads 0 on Claude models — the reasoning is already inside `↓`.
- **Billed tokens** (in `summary` view) is computed as `input + output + cache_write + cache_read/10`, matching Anthropic's published pricing model. If you're on GitHub-managed routing or a BYOK provider, the actual billing rule may differ — treat this as an upper-bound estimate.
- **Cost** is reported in the CLI's internal cost unit (labeled `cu`), not USD. The unit appears to be related to billing weights but the conversion factor isn't published; use `/usage` inside Copilot CLI for authoritative premium-request accounting.
- **Quota** (premium interactions / chat / completions remaining) is pulled from `copilot_user_info` telemetry blocks emitted by the CLI itself, so it tracks `/usage` directly.
- If telemetry logs are unavailable (very fresh session, logs rotated away), the meter degrades gracefully to events-only mode — `outputTokens` and activity are still accurate, the rest read 0, and the `summary` banner switches to `Source: events.jsonl only`.

## License

MIT
