# Status-bar examples

See https://github.com/abhi-singhs/copilot-token-meter

These drop-in snippets render the Copilot token meter outside the
terminal title bar. They all read:

```text
~/.copilot/state/token-meter/latest.json
```

Because each snippet reads `.title` from that file, tmux, Polybar,
iTerm2, WezTerm, and the plugin title bar stay in sync.

Requirements: run the plugin so `latest.json` exists; install `jq` for
shell-based snippets.

## Files

- `tmux.conf` — tmux `status-right` fragment with optional context %.
- `polybar.ini` — Polybar `custom/script` module for `.title`.
- `iterm2-wezterm.md` — iTerm2 Script component and WezTerm Lua snippet.

## Install: tmux

```bash
cp examples/tmux.conf ~/.tmux-tokenmeter.conf
```

```tmux
source-file ~/.tmux-tokenmeter.conf
```

Reload with `tmux source-file ~/.tmux.conf`.

## Install: Polybar

Copy `polybar.ini` into your Polybar config and add the module:

```ini
modules-right = copilot-tokens date
```

## Install: iTerm2 / WezTerm

Open `iterm2-wezterm.md` and copy the snippet for your terminal.
The iTerm2 command uses `jq`; the WezTerm Lua reads JSON directly.

All three examples use `~/.copilot/state/token-meter/latest.json`, so
custom status bars show the same text as the title bar.
