# Contributing

## Quick start

Before pushing, make sure both local checks pass:

```bash
npm test
npm run lint
```

CI covers these checks in `.github/workflows/test.yml`: unit tests and CLI smoke checks run on Node 18, 20, and 22 across Ubuntu, macOS, and Windows; lint runs on Ubuntu with Node 22.

## Dependency policy

The runtime code is intentionally dependency-free and uses only Node built-ins. Keep it that way unless a new runtime dependency has a strong justification.

Dev-only dependencies are allowed only when essential. The current dev dependency is `eslint`; discuss any new dev dependency in the PR.

## Testing a local checkout against Copilot CLI

For plugin development, install the checkout directly, edit files, then refresh Copilot CLI's plugin snapshot:

```bash
copilot plugin install /path/to/copilot-token-meter
# edit files
copilot plugin update copilot-token-meter
# restart Copilot CLI for hooks to reload
```

Copilot CLI currently warns that direct local installs are deprecated, but they still work for plugin development. Restart the CLI after install or update because hooks are loaded once per session.

## Code style

Use plain Node.js with CommonJS modules. Put `"use strict";` at the top of every JavaScript file.

Prefer small, focused functions and avoid premature abstractions. Comments should explain why something is done, not restate what the code says. Do not add JSDoc blocks unless they add clarity.

The ESLint config enforces correctness rules such as `eqeqeq`, `no-var`, and `no-undef`. Formatting and other style choices are left to reviewer judgement.

## Commit messages

Use a short imperative subject line and a wrapped body that explains why the change is needed. Conventional Commits prefixes are not required.

Always include this trailer at the end of the commit body:

```text
Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
```

## Changelog discipline

For non-trivial changes, add an entry under `## [Unreleased]` in `CHANGELOG.md`. Use the existing Keep a Changelog sections: `Added`, `Changed`, `Removed`, and `Fixed`.

## Reporting bugs or requesting features

File bugs and feature requests at https://github.com/abhi-singhs/copilot-token-meter/issues.

For telemetry bugs, include the Copilot CLI version and the relevant excerpt from `~/.copilot/state/token-meter/hooks.log` or `~/.copilot/state/token-meter/errors.log`.
