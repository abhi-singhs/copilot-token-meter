# copilot-token-meter

> Live token meter for **GitHub Copilot CLI**. Shows input / output / cache tokens and agent activity for every prompt — in your terminal title bar, in a live dashboard, and via a `/tokens` slash command.

## What you get

| Surface | How |
|---|---|
| **Always-visible "footer"** | The plugin hooks `sessionStart`, `userPromptSubmitted`, `postToolUse`, and `agentStop` and writes a one-line summary to your terminal title bar via OSC 2. Works in iTerm2, Kitty, Alacritty, WezTerm, Terminal.app, gnome-terminal, Windows Terminal. |
| **`/tokens` slash command** | Inside Copilot CLI, type `/tokens` for a multi-line breakdown — per-model, per-turn, with quota. |
| **`copilot-tokens` CLI** | Companion CLI with `status`, `summary`, `watch`, `top`, `json`, `recompute` subcommands for use in a second pane / tmux / CI. |
| **Status JSON for other tools** | `~/.copilot/state/token-meter/latest.json` is rewritten on every hook tick — point your tmux status bar, polybar, iTerm status, or VS Code status item at it. |

## Why a plugin (and not the built-in footer)?

Copilot CLI's built-in footer (`settings.json` → `footer`) only supports a fixed set of toggles (`showModelEffort`, `showDirectory`, `showBranch`, `showContextWindow`, `showQuota`). There is no public API for plugins to inject custom footer items.

This plugin works around that by piggy-backing on three stable contracts the CLI already exposes:

1. **Plugin lifecycle hooks** (`sessionStart`, `userPromptSubmitted`, `postToolUse`, `agentStop`).
2. **`events.jsonl`** in `~/.copilot/session-state/<sessionId>/` — typed against `schemas/session-events.schema.json` — for turn / tool / message / model activity and the `assistant.message.outputTokens` field.
3. **Process telemetry log** at `~/.copilot/logs/process-*.log` — the CLI writes one debug log per process containing `[Telemetry] cli.telemetry:` JSON blocks. Each `kind: "assistant_usage"` block carries the full token / cache breakdown (`input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, `reasoning_tokens`, `duration`, `ttft_ms`) and is joined back to the originating turn via `provider_call_id` ↔ `assistant.message.requestId`. Each `kind: "copilot_user_info"` block carries a live quota snapshot.
4. **Raw HTTP response bodies** logged in the same process log under `[DEBUG] data: { ... "usage": { "prompt_tokens", "completion_tokens", "prompt_tokens_details": { "cached_tokens", "cache_creation_tokens" } } }`. These are matched to telemetry records by `id` ↔ `api_call_id` and used to *repair* the `input_tokens: 0` that current Copilot CLI builds always report when prompt caching is in play (the truthful uncached input is `prompt_tokens - cached_tokens - cache_creation_tokens`).

The hook script merges the two sources, aggregates totals, and writes an OSC 2 title-bar escape to `/dev/tty` so you get a true always-visible footer above your shell prompt.

> Telemetry-log parsing is incremental: per-`(session, log)` byte offsets are cached in `~/.copilot/state/token-meter/telemetry-cache.json`, so only the new tail of each log is read on every hook tick. Event IDs are deduped so the same usage event isn't billed twice when multiple processes touch the same session.

## Install

The plugin is a self-contained directory you can install into Copilot CLI with `copilot plugin install`.

```bash
# From the GitHub marketplace (recommended):
copilot plugin install abhi-singhs/copilot-token-meter

# Or from a local checkout (handy while developing the plugin itself):
copilot plugin install /path/to/copilot-token-meter
```

The marketplace install snapshots the plugin into Copilot CLI's plugin cache and
registers it in `~/.copilot/config.json`. Local installs additionally record the
source path so `copilot plugin update <name>` can re-snapshot after edits.

After editing files in a local checkout, refresh the snapshot:

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
export PATH="/path/to/copilot-token-meter/bin:$PATH"
```

The plugin uses only Node's built-in modules — no `npm install` needed for runtime use. (`npm test` is supported for the test suite.)

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
copilot-tokens                       # one-line summary
copilot-tokens summary               # detailed multi-line breakdown
copilot-tokens watch                 # live dashboard, refreshes every 1s
copilot-tokens top                   # top sessions by total tokens, all time
copilot-tokens top --limit 5         # only show the top 5
copilot-tokens top --since 7d        # only sessions active in the last 7 days
copilot-tokens json                  # raw status JSON (for scripting)
copilot-tokens recompute             # force re-scan of the current session
copilot-tokens --plain summary       # no ANSI colour (also honours NO_COLOR=1)
```

Drop-in status-bar configs for tmux, polybar, iTerm2, and WezTerm live in [`examples/`](./examples/).

### From tmux

```tmux
set -g status-right '#(cat ~/.copilot/state/token-meter/latest.json 2>/dev/null | jq -r .title) | %H:%M'
```

See [`examples/tmux.conf`](./examples/tmux.conf) for a fuller version that also surfaces context-window utilisation.

### From iTerm2 / WezTerm status bar

Read `~/.copilot/state/token-meter/latest.json` and render the `.title` field. See [`examples/iterm2-wezterm.md`](./examples/iterm2-wezterm.md) for the exact iTerm2 Script status-bar component and a WezTerm `update-right-status` Lua snippet.

### From polybar

See [`examples/polybar.ini`](./examples/polybar.ini) for a `custom/script` module that mirrors the title bar.

## Title bar format

```
copilot[opus-4.7-1m] ↑12.3k ↓4.2k ⟳88.0k ⊕5.1k 🧠1.2k 7t/23🔧
```

| Symbol | Meaning |
|---|---|
| `↑` | input tokens (new prompt tokens sent to the model) |
| `↓` | output tokens (model's reply tokens) |
| `⟳` | cache **read** tokens (reused prefix from prompt cache) |
| `⊕` | cache **write** tokens (new prefix written to prompt cache) |
| `🧠` | reasoning tokens (shown only when > 0; OpenAI reasoning models, etc.) |
| `Nt/M🔧` | turns / tool calls |

The `summary` view additionally shows:

- **Context-window utilization** as a bar + percentage, computed against the most recent API call's prompt size (cache_read + cache_write + input) so it reflects what the model actually saw.
- **Burn rate** — tokens/min over the last 5 / 30 minutes and an ETA to context-window exhaustion at the current rate (when telemetry is producing fresh data).
- **Per-tool attribution** — `By tool` section showing which tools (`bash`, `view`, `edit`, …) burned the most input/cache tokens, with proportional `1/N` splitting across batched tool calls.
- **Sub-agent rollup** — when sub-agents (the `task` tool) make their own API calls, the `Sub-agents` section surfaces their token usage separately, while still folding it into the parent `task` tool entry.
- Prompt-tokens (= input + cache_read + cache_write — what actually crossed the wire), total billed tokens (Anthropic-style formula), cumulative API duration, and a live `Quota` block sourced from `copilot_user_info` telemetry events.

## State files

| Path | Purpose |
|---|---|
| `~/.copilot/state/token-meter/latest.json` | Snapshot of the most recently updated session. |
| `~/.copilot/state/token-meter/<sessionId>.json` | Per-session snapshot. |
| `~/.copilot/state/token-meter/history-<sessionId>.jsonl` | Rolling burn-rate history (capped). |
| `~/.copilot/state/token-meter/current` | Plain-text file containing the current session ID. |
| `~/.copilot/state/token-meter/telemetry-cache.json` | Per-`(session, log)` byte offsets + de-duped `event_id` set + apiResponse cache for incremental telemetry parsing. |
| `~/.copilot/state/token-meter/telemetry-cache.lock` | Transient advisory lockfile (held only briefly during cache writes). |
| `~/.copilot/state/token-meter/models.json` | **Optional** user override for per-model context-window sizes. |
| `~/.copilot/state/token-meter/hooks.log` | One-line trace per hook invocation (handy for debugging that hooks fire at all). |
| `~/.copilot/state/token-meter/errors.log` | Hook error log (rotated by `logrotate` etc.). |

## Configuration

| Env var | Effect |
|---|---|
| `COPILOT_HOME` | Override the `~/.copilot` location (used in tests / CI). |
| `COPILOT_TOKENMETER_RESET_ON_STOP=1` | Clear the terminal title bar when the agent stops, instead of leaving the final stats lingering. |
| `NO_TITLE=1` / `TERM=dumb` | Suppress the OSC 2 title-bar writes entirely. |
| `NO_COLOR=1` | Disable ANSI colour in `copilot-tokens` output (per [no-color.org](https://no-color.org)). Equivalent to passing `--plain` / `--no-color`. |

### Custom model metadata

Drop a `models.json` at `~/.copilot/state/token-meter/models.json` to add or override context-window sizes for new or custom models. Entries with `match` prefixes earlier in the list win; longest match wins among matches with the same name.

```json
{
  "models": [
    { "match": ["my-byok-model"], "contextWindow": 200000 }
  ]
}
```

After editing `models.json`, delete `~/.copilot/state/token-meter/telemetry-cache.json` so the next hook tick re-resolves model metadata.

## Troubleshooting

### The title bar never updates

1. Check `~/.copilot/state/token-meter/hooks.log` — each hook invocation appends a single line. If it's empty, the hooks aren't firing.
2. **Restart Copilot CLI** after `copilot plugin install` or `copilot plugin update`. Hooks are loaded once per session.
3. Confirm your terminal honours OSC 2 (`printf '\e]2;hello\a'` should set the title). The plugin no-ops on `TERM=dumb` and when `NO_TITLE=1` is set.
4. On macOS, Terminal.app's "Tab" title and "Window" title are separate; OSC 2 sets the window title.
5. If you're running inside `tmux`, tmux owns the outer title — use `set -g set-titles on` and `set -g set-titles-string '#{pane_title}'` to pass the pane title through.

### All numbers show 0

1. Telemetry logs lag the first few prompts. Run a couple of `/help` or a quick prompt, then re-check.
2. Confirm process logs exist and are recent: `ls -lt ~/.copilot/logs/process-*.log | head`. The plugin only reads logs newer than 14 days.
3. Force a re-scan: `copilot-tokens recompute`.

### The `input` column reads 0 even though I've sent a long prompt

This is the known `input_tokens: 0` bug in current Copilot CLI builds when prompt caching is active. The plugin repairs it by joining each telemetry record to the matching raw `[DEBUG] data: { ... usage: { prompt_tokens, prompt_tokens_details } }` block via `api_call_id`. The repair only kicks in **after** the raw response is logged — usually one tick later. If it persists across multiple turns, your CLI build may be omitting the `[DEBUG] data:` blocks; check that `~/.copilot/logs/process-*.log` actually contains them.

### My custom `models.json` isn't picked up

Pricing/context-window data is read lazily and cached for the lifetime of each hook process. Edit-then-restart-CLI is enough. If you're running `copilot-tokens` from a long-running watcher, kill and restart it. As a stronger reset, also delete `~/.copilot/state/token-meter/telemetry-cache.json`.

### Hook errors

Check `~/.copilot/state/token-meter/errors.log`. The hook script is wrapped so any error is logged there and the process exits 0 — a hook failure never blocks Copilot CLI. If you see repeated errors, please file an issue with the relevant log excerpt and your Copilot CLI version.

### `copilot-tokens` colours are mangled in tmux / less / scripts

Pass `--plain` (or `--no-color`), or set `NO_COLOR=1` in the environment. The context-window bar falls back to a plain-ASCII `[##  ]` indicator.

## How accurate are the numbers?

- **Output tokens & activity** (turns, tool calls, message counts, model) come from `events.jsonl`, which is the same record the CLI's own UI reads from. These are always present.
- **Input / cache_read / cache_write / reasoning / duration** come from `[Telemetry] cli.telemetry:` `assistant_usage` blocks in `~/.copilot/logs/process-*.log`. The plugin joins each usage block to the originating turn via `provider_call_id` ↔ `assistant.message.requestId`. These match exactly what the CLI reports to its quota service.
- **Input-tokens repair**: current Copilot CLI builds always emit `input_tokens: 0` when prompt caching is active. The truthful value is derived from the matching raw HTTP response body (`[DEBUG] data: { id, usage:{ prompt_tokens, prompt_tokens_details:{...} } }`) using `prompt_tokens − cached_tokens − cache_creation_tokens`, joined by `data.id` == telemetry `api_call_id`. Without this repair the `input` column reads 0 even when there's real uncached content.
- **Per-tool attribution** is approximate: each batched tool call gets a `1/N` share of the *next* API call's prompt-fold tokens (input + cache_read + cache_write). For single-tool turns the attribution is exact; for batches of N tools it splits evenly.
- **Sub-agent attribution**: sub-agent telemetry records carry `initiator: "sub-agent"` and `parent_tool_call_id`. We attribute their tokens to the parent tool (typically `task`) and also surface a separate Sub-agents section.
- **Reasoning tokens** are surfaced separately when the provider reports them (OpenAI o-series / gpt-5 reasoning models). Anthropic does not split reasoning out from output tokens, so `🧠` typically reads 0 on Claude models — the reasoning is already inside `↓`.
- **Billed tokens** (in `summary` view) is computed as `input + output + cache_write + cache_read/10`, matching Anthropic's published billing formula. If you're on GitHub-managed routing or a BYOK provider, the actual billing rule may differ — treat this as an upper-bound estimate.
- **Quota** (premium interactions / chat / completions remaining) is pulled from `copilot_user_info` telemetry blocks emitted by the CLI itself, so it tracks `/usage` directly.
- If telemetry logs are unavailable (very fresh session, logs rotated away), the meter degrades gracefully to events-only mode — `outputTokens` and activity are still accurate, the rest read 0, and the `summary` banner switches to `Source: events.jsonl only`.

> For authoritative billing and quota use `/usage` inside Copilot CLI — this plugin does not estimate USD cost.

## Development

```bash
# Run the unit tests
npm test                       # → node --test test/

# Sanity-check syntax of every script
node --check bin/token-meter.js bin/copilot-tokens lib/*.js
```

CI runs the same checks across Node 18/20/22 on Ubuntu / macOS / Windows via `.github/workflows/test.yml`.

The codebase is intentionally dependency-free — only Node built-ins are used at runtime and at test time. Source layout:

```
lib/
  format.js      number / duration / title formatting helpers
  io.js          JSONL reader, atomic file writes, OSC 2 title writer
  pricing.js     model → context-window lookup (with user override)
  telemetry.js   process-log parsing (telemetry + raw API responses)
  aggregate.js   events.jsonl + telemetry → totals / per-model / per-tool
bin/
  token-meter.js plugin hook script (writes status JSON + title bar)
  copilot-tokens companion CLI (status / summary / watch / top / json)
```

## License

MIT
