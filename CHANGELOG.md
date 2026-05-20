# Changelog

All notable changes to **copilot-token-meter** are documented in this file.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- `LICENSE` (MIT), `CHANGELOG.md`, and `repository` / `homepage` / `bugs` URLs in `plugin.json` for marketplace readiness.

### Changed
- `skills/tokens/SKILL.md` no longer hardcodes the `_direct/abhi-singhs--copilot-token-meter` install path; it relies solely on `$COPILOT_PLUGIN_DIR`, which is portable across local, direct, and marketplace installs.
- README install instructions point at the marketplace coordinate (`abhi-singhs/copilot-token-meter`) and de-emphasise local checkouts.

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

[Unreleased]: https://github.com/abhi-singhs/copilot-token-meter/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/abhi-singhs/copilot-token-meter/releases/tag/v0.1.0
