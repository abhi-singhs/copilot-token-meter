# Changelog

All notable changes to **copilot-token-meter** are documented in this file.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- **Hook no longer crashes with `MODULE_NOT_FOUND` when invoked from VS Code (or any host that runs hooks with cwd ≠ plugin dir).** `hooks.json` used to invoke `node ./bin/token-meter.js`, which only resolved correctly because Copilot CLI sets cwd to the plugin directory. VS Code's Copilot chat agent runs the hook with cwd = workspace folder, so Node looked for `./bin/token-meter.js` under the user's project and failed with `Error: Cannot find module '/path/to/workspace/bin/token-meter.js'`. The hook command now resolves an absolute script path from `$COPILOT_PLUGIN_ROOT` (exported by Copilot CLI 1.0.56+) — falling back to `$CLAUDE_PLUGIN_ROOT`, `$PLUGIN_ROOT`, and finally the standard direct-install path `~/.copilot/installed-plugins/_direct/abhi-singhs--copilot-token-meter`. The bash and PowerShell forms also guard with a `[ -f "$S" ]` / `Test-Path` check and silently `exit 0` when the script can't be located, so a misplaced install never blocks the agent. `hooks.log` now also records the resolved `root=` so install issues are easy to diagnose.

## [0.2.1] - 2026-05-22

### Fixed
- **Status line no longer bleeds tokens across Copilot sessions.** When a brand-new Copilot CLI session started, its `statusLine.command` was rendering the *previous* session's token totals because the renderer fell back to the shared `latest.json` cache whenever the new session's per-session cache hadn't been seeded yet. The custom status line now treats `payload.session_id` as authoritative: it only reads that session's own per-session cache (or, if no cache exists yet, derives totals from Copilot's own `context_window.total_*_tokens` payload — which is zero at session start). The `sessionStart` hook also now seeds a clean zero-state per-session cache up front so the very first `statusLine.command` invocation in a new session reads its own data, never a sibling session's. Added 5 regression tests covering the cross-session isolation and the seeding behaviour.

## [0.2.0] - 2026-05-20

### Added
- **Custom status line for Copilot CLI 1.0.52+.** New `copilot-tokens statusline` subcommand purpose-built for Copilot CLI's `statusLine.command` slot (the `custom` row in `/footer`). Reads the session JSON payload Copilot pipes in on stdin, joins it with the plugin's cached telemetry / repair data, and prints a compact ANSI-coloured line — `↑12.3k ↓45.6k ⟳88.0k ⊕5.1k 🧠1.2k · 📦42% · 7t/23🔧` — that drops straight into the Copilot footer alongside `directory`, `branch`, `effort`, `context-used`, and `quota`. Live context % is sourced from the payload's `context_window.current_context_used_percentage` (falling back to the plugin's events-derived estimate). All errors are swallowed so a misbehaving statusline never breaks Copilot's UI. Honours `--plain` / `NO_COLOR=1`.
- `copilot-tokens statusline-command` companion subcommand that prints the exact absolute-path command string to paste into `~/.copilot/config.json` under `statusLine.command`.
- `formatStatusLine(agg, payload, options)` helper in `lib/format.js` (with 6 new unit tests covering colour toggling, payload-vs-aggregator preference, zero-suppression, and bounds clamping).
- `examples/copilot-statusline.md` ready-to-merge config snippet + walkthrough for `~/.copilot/config.json`.
- README "As Copilot CLI's custom status line" section with the three-step wire-up and a note on running both the title-bar and footer-line surfaces side-by-side.
- `LICENSE` (MIT), `CHANGELOG.md`, and `repository` / `homepage` / `bugs` URLs in `plugin.json` for marketplace readiness.
- ESLint flat config (`eslint.config.js`) + `npm run lint` script + a CI lint job (Ubuntu, Node 22). `eslint` is the only `devDependencies` entry; runtime stays dependency-free.
- `--plain` / `--no-color` flag on `copilot-tokens` and support for the `NO_COLOR=1` env var (per [no-color.org](https://no-color.org)). Plain mode also swaps the context-window block characters (`▮`/`▯`) for an ASCII `[##  ]` bar so output pipes cleanly into tmux / `jq` / `less`.
- `copilot-tokens top --limit N` (default 20) and `top --since <duration>` filters; durations accept `s`/`m`/`h`/`d`/`w` suffixes (e.g. `30m`, `24h`, `7d`, `2w`).
- `reasoning_effort` is now surfaced in the `By model` row of `summary` — single tier (e.g. `gpt-5.4 (high)`) or modal-plus suffix when mixed (`gpt-5.4 (high+)`). Anthropic models continue to show no effort tag (the field isn't reported).
- Unit tests for `lib/io.js` (`writeAtomic`, `writeTitleBar`, `readJsonl`), plus `parseDuration` (in `lib/format.js`) and `dominantEffort` (in `lib/aggregate.js`). Total test count grew from 17 to 30.
- `examples/` directory with drop-in status-bar snippets for tmux, polybar, iTerm2, and WezTerm.
- `CONTRIBUTING.md` describing the dependency-free policy, local-checkout install loop, commit conventions, and CHANGELOG discipline.
- README "Troubleshooting" section covering the common failure modes (title bar not updating, zero numbers, the `input_tokens: 0` repair window, custom `models.json` cache refresh, hook errors, mangled colours in pipes).

### Changed
- `skills/tokens/SKILL.md` no longer hardcodes the `_direct/abhi-singhs--copilot-token-meter` install path; it relies solely on `$COPILOT_PLUGIN_DIR`, which is portable across local, direct, and marketplace installs.
- README install instructions point at the marketplace coordinate (`abhi-singhs/copilot-token-meter`) and de-emphasise local checkouts.
- Optional user override file renamed from `pricing.json` to `models.json` and now only carries `match` + `contextWindow` entries.

### Removed
- USD cost estimation. The previous Anthropic / OpenAI list-price multiplication produced numbers that did not reflect GitHub Copilot routing, enterprise discounts, BYOK rates, cache-TTL tiers, or promotional credits, so it has been removed entirely. Use `/usage` inside Copilot CLI for authoritative billing. Removed surfaces: `Cost` section and per-row USD columns in `summary`, USD column in `top`, `~`USD in the one-line `status`, `usdCost`/`usdCostKnown` fields from status JSON and history snapshots, `costForBucket` / `formatUSD` from `lib/pricing.js`, and all related disclaimers.

## [0.1.0] - 2026-05-19

Initial release.

### Added
- Plugin lifecycle hooks (`sessionStart`, `userPromptSubmitted`, `postToolUse`, `agentStop`) that write a one-line summary to the terminal title bar via OSC 2.
- `/tokens` slash command (skill) that prints a per-session breakdown of input / output / cache / reasoning tokens, estimated USD cost, context-window utilisation, burn rate, per-tool attribution, and live quota.
- `copilot-tokens` companion CLI with `status`, `summary`, `watch`, `top`, `json`, and `recompute` subcommands.
- Per-`(session, log)` incremental telemetry parsing with byte-offset cache and event-id deduplication in `~/.copilot/state/token-meter/telemetry-cache.json`.
- Repair of the `input_tokens: 0` bug in current Copilot CLI builds by joining `[Telemetry] cli.telemetry` records to the raw `[DEBUG] data: { usage: { prompt_tokens, prompt_tokens_details: { cached_tokens, cache_creation_tokens } } }` HTTP response bodies via `api_call_id`.
- Sub-agent (the `task` tool) rollup that attributes downstream API spend to the parent tool while surfacing a separate Sub-agents section.
- Built-in Anthropic / OpenAI list-price table for USD cost estimation, with user override at `~/.copilot/state/token-meter/pricing.json`.
- `node --test` unit suite (19 tests) covering formatting, pricing, telemetry parsing, and aggregation.
- GitHub Actions CI matrix: Node 18 / 20 / 22 on Ubuntu / macOS / Windows.

[Unreleased]: https://github.com/abhi-singhs/copilot-token-meter/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/abhi-singhs/copilot-token-meter/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/abhi-singhs/copilot-token-meter/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/abhi-singhs/copilot-token-meter/releases/tag/v0.1.0
