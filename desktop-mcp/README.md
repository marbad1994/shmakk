# desktop-mcp

Cross-platform desktop control MCP server (Python, stdio). Mouse, scrolling,
keyboard, screenshots. Windows, macOS and X11 use pyautogui; Wayland (KDE Plasma)
uses ydotool + spectacle. The backend is picked automatically.

## Tools

| Tool | Purpose |
| --- | --- |
| desktop_screen_info | Screen size and cursor position |
| desktop_screenshot | PNG of screen or region, optional downscale |
| desktop_mouse_move / click / drag / button | Pointer control |
| desktop_scroll | Vertical or horizontal wheel |
| desktop_type_text | Type text (Unicode via clipboard paste) |
| desktop_key_press / hotkey / key_hold | Keys and combos |
| desktop_do | Run many actions in ONE call, then screenshot (fast path) |
| desktop_wait | Pause for UI to settle |
| desktop_doctor | Report missing tools, sockets, permissions |

## Install and run

```
cd desktop-mcp
python -m venv .venv
source .venv/bin/activate.fish   # fish
pip install -e .
desktop-mcp
```

Client config (Claude Desktop / Claude Code):

```
{"mcpServers": {"desktop": {"command": "/abs/path/.venv/bin/desktop-mcp"}}}
```

## Speed and coordinates

All tools share one view space: the screen scaled to at most
DESKTOP_MCP_VIEW_WIDTH (default 1280) wide. A full screenshot is exactly that
size, so image pixels are the click coordinates. Screenshots are JPEG. Action
tools take `screenshot=true` to return the result, and `desktop_do` batches many
steps into one call. Use a screenshot region (optionally with zoom) for small checks.

## Skipping approval prompts

Approval is a client setting. In Claude Code, allow the server in settings:
`{"permissions": {"allow": ["mcp__desktop"]}}` (use your server name). In
Claude Desktop, choose "Always allow" per tool.

## Wayland (KDE Plasma)

```
sudo pacman -S ydotool spectacle wl-clipboard libkscreen
sudo usermod -aG input $USER      # then log out and back in
systemctl --user enable --now ydotool
```

Run `desktop_doctor` to verify. Limits: the cursor position is not available
(Wayland hides it), the pyautogui corner failsafe does not exist (stop the
server to abort), ydotool types with a US layout, and the first screenshot may
trigger a KDE permission prompt. Overrides: DESKTOP_MCP_BACKEND=pyautogui|wayland,
DESKTOP_MCP_SCREEN_SIZE=1920x1080, YDOTOOL_SOCKET=/path.

## Safety

- Failsafe on (pyautogui backend): slam the cursor into a screen corner to abort (DESKTOP_MCP_FAILSAFE=0 disables).
- DESKTOP_MCP_READONLY=1 exposes only screenshot, screen info and wait.
- This server controls your real desktop. Only connect it to clients you trust.

## Platform notes

- macOS: grant Accessibility and Screen Recording to the terminal/host app.
- Linux X11: needs xclip or xsel for Unicode typing (pyperclip). Wayland: see above.
- Windows: works out of the box; elevated windows need an elevated host.
