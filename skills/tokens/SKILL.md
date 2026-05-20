---
name: tokens
description: Show a live breakdown of token usage (input, output, cache read, cache write) and agent activity (turns, tool calls, per-model) for the current Copilot CLI session. USE THIS SKILL whenever the user asks about token usage, context size, how many calls have been made, per-model breakdown, or wants to debug runaway prompts. Trigger phrases include "how many tokens", "show tokens", "/tokens", "what's my usage", "token meter", "input output tokens", "agent activity", "tool call count".
---

# /tokens — Live Copilot CLI Token Meter

This skill prints a real-time breakdown of token usage for the **current** Copilot CLI session, sourced from the per-session `events.jsonl` event log that the CLI writes to `~/.copilot/session-state/<sessionId>/`. It is provided by the `copilot-token-meter` plugin.

## Instructions

When the user invokes `/tokens` (or asks about token usage or agent activity), do the following:

1. **Run the meter once to refresh the snapshot, then print the multi-line breakdown:**

   ```bash
   "$COPILOT_PLUGIN_DIR/bin/copilot-tokens" summary
   ```

   `$COPILOT_PLUGIN_DIR` is set by Copilot CLI to the directory containing this plugin, regardless of how it was installed (marketplace or local). Always invoke the binary through that variable — do not hardcode an absolute path.

2. **Surface the highlights in your reply** — total in/out tokens, cache utilisation, **context-window %** (most recent call), **burn rate** if shown, number of turns and tool calls, and the per-model / per-tool split when the user is likely to find it interesting. For authoritative billing or quota questions, direct users to `/usage` inside Copilot CLI — this plugin does not estimate USD cost.

3. **If the user asks for a live dashboard**, suggest they run `copilot-tokens watch` in a separate terminal pane — the meter writes a status file (`~/.copilot/state/token-meter/latest.json`) that the watcher refreshes every second, so the two stay in sync, and the dashboard shows a sparkline of recent tokens/min.

4. **If the user asks about historical sessions**, run:

   ```bash
   "$COPILOT_PLUGIN_DIR/bin/copilot-tokens" top
   ```

   That ranks every session in `~/.copilot/session-state/` by total tokens used and shows the model per session.

5. **If the numbers look surprising**, the meter joins three data sources in priority order:
   1. **Process telemetry log** (`~/.copilot/logs/process-*.log`) `[Telemetry] cli.telemetry:` `assistant_usage` blocks — the authoritative source for output/cache/reasoning tokens.
   2. **Raw HTTP response bodies** in the same log (`[DEBUG] data: { id, usage: { prompt_tokens, prompt_tokens_details: {...} } }`) — used to **repair** the `input_tokens: 0` bug in current Copilot CLI builds when prompt caching is active (the real value is `prompt_tokens − cached_tokens − cache_creation_tokens`, joined by `data.id` == telemetry `api_call_id`).
   3. **`events.jsonl`** — for turn / tool / message / model activity and `assistant.message.outputTokens` as a final fallback.

   When the process log has been rotated or hasn't yet been flushed, input / cache figures may read 0 — output-token counts and turn / tool activity stay accurate.

## Output format

The `summary` subcommand already prints a well-formatted, coloured block — pass it through verbatim in your reply (wrap in a code block so the colours render correctly in the user's terminal).

## Notes

- The plugin's `postToolUse` hook keeps the terminal title bar updated with `↑in ↓out ⟳cache ⊕write 📦N% Nt/M🔧` after every tool call, so the user sees a live "footer" without needing to invoke this skill.
- The `summary` view also breaks tokens down **per tool** (which tool burned the most input/cache) using proportional attribution: each batched tool call gets a `1/N` share of the next API call's prompt-fold tokens.
- This skill is read-only; it never modifies session state.
- This plugin does not estimate USD cost. For authoritative billing and quota information, direct users to `/usage` inside Copilot CLI.
