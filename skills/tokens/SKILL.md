---
name: tokens
description: Show a live breakdown of token usage (input, output, cache read, cache write, cost) and agent activity (turns, tool calls, per-model) for the current Copilot CLI session. USE THIS SKILL whenever the user asks about token usage, cost, context size, how much they've spent, how many calls have been made, per-model breakdown, or wants to debug runaway prompts. Trigger phrases include "how many tokens", "show tokens", "/tokens", "what's my usage", "cost so far", "token meter", "input output tokens", "agent activity", "tool call count".
---

# /tokens — Live Copilot CLI Token Meter

This skill prints a real-time breakdown of token usage for the **current** Copilot CLI session, sourced from the per-session `events.jsonl` event log that the CLI writes to `~/.copilot/session-state/<sessionId>/`. It is provided by the `copilot-token-meter` plugin.

## Instructions

When the user invokes `/tokens` (or asks about token usage, cost, or agent activity), do the following:

1. **Run the meter once to refresh the snapshot, then print the multi-line breakdown:**

   ```bash
   "$COPILOT_PLUGIN_DIR/bin/copilot-tokens" summary
   ```

   `$COPILOT_PLUGIN_DIR` is set by Copilot CLI to the directory containing this plugin. Equivalent absolute path: `~/.copilot/installed-plugins/_direct/abhi-singhs--copilot-token-meter/bin/copilot-tokens`.

2. **Surface the highlights in your reply** — total in/out tokens, cache utilisation, cost (if any), number of turns and tool calls, and the per-model split if more than one model has been used.

3. **If the user asks for a live dashboard**, suggest they run `copilot-tokens watch` in a separate terminal pane — the meter writes a status file (`~/.copilot/state/token-meter/latest.json`) that the watcher refreshes every second, so the two stay in sync.

4. **If the user asks about historical sessions**, run:

   ```bash
   "$COPILOT_PLUGIN_DIR/bin/copilot-tokens" top
   ```

   That ranks every session in `~/.copilot/session-state/` by total tokens used and shows model + cost per session.

5. **If the numbers look surprising**, remind the user that the meter relies on the Copilot CLI emitting `assistant.usage` events (input/output/cache/cost) and `assistant.message` events (output tokens). Older CLI builds and BYOK providers may only emit the message-level counts, in which case input and cache figures will read 0 — the plugin still shows accurate output-token counts and turn/tool activity in that case.

## Output format

The `summary` subcommand already prints a well-formatted, coloured block — pass it through verbatim in your reply (wrap in a code block so the colours render correctly in the user's terminal).

## Notes

- The plugin's `postToolUse` hook keeps the terminal title bar updated with `↑in ↓out ⟳cache $cost Nt/M🔧` after every tool call, so the user sees a live "footer" without needing to invoke this skill.
- This skill is read-only; it never modifies session state.
