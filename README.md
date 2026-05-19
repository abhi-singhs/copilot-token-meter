# copilot-token-meter

> Live token & cost meter for **GitHub Copilot CLI**. Shows input / output / cache tokens, cost, and agent activity for every prompt — in your terminal title bar, in a live dashboard, and via a `/tokens` slash command.

## What you get

| Surface | How |
|---|---|
| **Always-visible "footer"** | The plugin hooks `sessionStart`, `postToolUse`, and `stop` and writes a one-line summary to your terminal title bar via OSC 2. Works in iTerm2, Kitty, Alacritty, WezTerm, Terminal.app, gnome-terminal, Windows Terminal. |
| **`/tokens` slash command** | Inside Copilot CLI, type `/tokens` for a multi-line breakdown — per-model, per-turn, with cost & quota. |
| **`copilot-tokens` CLI** | Companion CLI with `status`, `summary`, `watch`, `top`, `json`, `recompute` subcommands for use in a second pane / tmux / CI. |
| **Status JSON for other tools** | `~/.copilot/state/token-meter/latest.json` is rewritten on every hook tick — point your tmux status bar, polybar, iTerm status, or VS Code status item at it. |

## Why a plugin (and not the built-in footer)?

Copilot CLI's built-in footer (`settings.json` → `footer`) only supports a fixed set of toggles (`showModelEffort`, `showDirectory`, `showBranch`, `showContextWindow`, `showQuota`). There is no public API for plugins to inject custom footer items.

This plugin works around that by piggy-backing on two stable contracts the CLI already exposes:

1. **Plugin lifecycle hooks** (`sessionStart`, `postToolUse`, `stop`).
2. **`events.jsonl`** in `~/.copilot/session-state/<sessionId>/` — typed against `schemas/session-events.schema.json` and emits `assistant.usage` events with `{ model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, cost, duration, quotaSnapshots }` after every LLM round-trip, plus `assistant.message` events with `outputTokens`.

The hook script reads `events.jsonl`, aggregates totals, and writes an OSC 2 title-bar escape to `/dev/tty` so you get a true always-visible footer above your shell prompt.

## Install

This repo *is* a Copilot CLI plugin. Drop it into `~/.copilot/installed-plugins/_direct/abhi-singhs--copilot-token-meter/` and enable it in `~/.copilot/settings.json`:

```json
{
  "enabledPlugins": {
    "abhi-singhs/copilot-token-meter": true
  }
}
```

Then add the `bin/` directory to your `$PATH` (optional — only needed for `copilot-tokens`):

```bash
export PATH="$HOME/.copilot/installed-plugins/_direct/abhi-singhs--copilot-token-meter/bin:$PATH"
```

The plugin uses only Node's built-in modules — no `npm install` needed.

### Recommended companion settings

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
copilot[opus-4.7-xhigh] ↑12.3k ↓4.2k ⟳88.0k ⊕5.1k $0.0921 7t/23🔧
```

| Symbol | Meaning |
|---|---|
| `↑` | input tokens (new prompt tokens sent to the model) |
| `↓` | output tokens (model's reply tokens) |
| `⟳` | cache **read** tokens (reused prefix from prompt cache) |
| `⊕` | cache **write** tokens (new prefix written to prompt cache) |
| `$` | running cost (when provider reports it) |
| `Nt/M🔧` | turns / tool calls |

## State files

| Path | Purpose |
|---|---|
| `~/.copilot/state/token-meter/latest.json` | Snapshot of the most recently updated session. |
| `~/.copilot/state/token-meter/<sessionId>.json` | Per-session snapshot. |
| `~/.copilot/state/token-meter/current` | Plain-text file containing the current session ID. |
| `~/.copilot/state/token-meter/errors.log` | Hook error log (rotated by `logrotate` etc.). |

## How accurate are the numbers?

- **Input / output / cache / cost** come from the CLI's `assistant.usage` event, which is the same record the CLI uses for its own quota accounting. Numbers match what you'd see in `/usage`.
- **Reasoning tokens** are folded into `outputTokens` by Anthropic & OpenAI provider conventions; the meter does not double-count them.
- **Billed tokens** (in `summary` view) is computed as `input + output + cache_write + cache_read/10`, matching Anthropic's published pricing model. If you're on GitHub-managed routing or a BYOK provider, the actual billing rule may differ — treat this as an upper-bound estimate.
- For older CLI builds and BYOK providers that don't emit `assistant.usage`, the meter falls back to the message-level `outputTokens` field on `assistant.message`. In that case `inputTokens` will read 0 but output/turn/tool-call counts remain accurate.

## License

MIT
