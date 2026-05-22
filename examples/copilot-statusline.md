# Copilot CLI custom status line — `copilot-token-meter`

Copilot CLI 1.0.52+ ships a `Configure Status Line` menu (open it with
`/footer`) that includes a `custom` row. Enable it and Copilot will spawn the
command you set under `statusLine.command` on every state change, pipe the
session JSON to it on stdin, and render the command's stdout as a footer row
beneath the built-in items.

The plugin's `copilot-tokens statusline` subcommand is purpose-built for this
contract: it reads the Copilot payload, joins it with the plugin's cached
telemetry, and prints a colourised one-liner like:

```
↑12.3k ↓45.6k ⟳88.0k ⊕5.1k 🧠1.2k · 📦42% · 7t/23🔧
```

## 1. Resolve the absolute command path

```bash
copilot-tokens statusline-command
# → "/Users/you/.copilot/installed-plugins/_direct/abhi-singhs--copilot-token-meter/bin/copilot-tokens statusline"
```

The path will differ depending on whether the plugin was installed from the
marketplace, from a local checkout, or symlinked onto `$PATH`.

## 2. Merge into `~/.copilot/config.json`

`~/.copilot/config.json` is JSON-with-comments (JSONC), so existing `//`
banners are fine to leave alone. Add (or merge) the following block at the top
level — replacing the absolute path with the one from step 1:

```json
{
  "statusLine": {
    "type": "command",
    "command": "/absolute/path/to/copilot-tokens statusline",
    "padding": 0
  }
}
```

## 3. Toggle the `custom` row in `/footer`

Open the Copilot CLI configurator with `/footer`, scroll to the `custom` row,
press `enter` to toggle it on, then `esc` to save.

## Notes

- The command is fail-safe: any error (missing cache, malformed payload,
  unreadable state file) is swallowed and the row renders empty rather than
  breaking Copilot's footer.
- Honours `NO_COLOR=1` for terminals that don't render ANSI in the footer.
  Pass `--plain` after `statusline` if you want to disable colour without
  exporting an env var:

  ```json
  { "statusLine": { "type": "command", "command": "/.../copilot-tokens statusline --plain" } }
  ```
- Pairs cleanly with the existing terminal title bar — running both surfaces
  side-by-side incurs no extra cost; they share the same cached state file.
