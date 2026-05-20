# Changelog

All notable changes to **copilot-token-meter** are documented in this file.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-05-20

### Added
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

[Unreleased]: https://github.com/abhi-singhs/copilot-token-meter/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/abhi-singhs/copilot-token-meter/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/abhi-singhs/copilot-token-meter/releases/tag/v0.1.0
