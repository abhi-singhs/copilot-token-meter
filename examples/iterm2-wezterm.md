# iTerm2 and WezTerm status bars

See https://github.com/abhi-singhs/copilot-token-meter

Both examples read `~/.copilot/state/token-meter/latest.json` and display
its `.title` field. Install `jq` for the iTerm2 command.

## iTerm2 status bar

Open **Preferences > Profiles > Session > Configure Status Bar**, add a
**Script** component, and set the script to:

```bash
cat ~/.copilot/state/token-meter/latest.json | jq -r .title
```

Use a two-second refresh interval if your iTerm2 version offers one.

## WezTerm

Add this to `~/.wezterm.lua` to update the right status text:

```lua
local wezterm = require 'wezterm'

local token_meter_dir = (os.getenv('HOME') or '') .. '/.copilot/state/token-meter'
local token_meter_file = token_meter_dir .. '/latest.json' -- ~/.copilot/state/token-meter/latest.json

local function token_meter_title()
  pcall(wezterm.read_dir, token_meter_dir)
  local file = io.open(token_meter_file, 'r')
  if not file then return '' end

  local body = file:read('*a')
  file:close()

  local ok, parsed = pcall(wezterm.json_parse, body)
  if ok and parsed and parsed.title then
    return parsed.title
  end
  return ''
end

wezterm.on('update-right-status', function(window, pane)
  window:set_right_status(token_meter_title())
end)
```

If the status file is missing, the snippet renders an empty string.
