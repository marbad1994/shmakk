# desktop-mcp

Cross-platform desktop control MCP server (Python, stdio). Mouse, scrolling,
keyboard, screenshots via pyautogui. Works on Windows, macOS and X11 Linux.

## Tools

| Tool | Purpose |
| --- | --- |
| desktop_screen_info | Screen size and cursor position |
| desktop_screenshot | PNG of screen or region, optional downscale |
| desktop_mouse_move / click / drag / button | Pointer control |
| desktop_scroll | Vertical or horizontal wheel |
| desktop_type_text | Type text (Unicode via clipboard paste) |
| desktop_key_press / hotkey / key_hold | Keys and combos |
| desktop_wait | Pause for UI to settle |

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

## Safety

- Failsafe on: slam the cursor into a screen corner to abort (DESKTOP_MCP_FAILSAFE=0 disables).
- DESKTOP_MCP_READONLY=1 exposes only screenshot, screen info and wait.
- This server controls your real desktop. Only connect it to clients you trust.

## Platform notes

- macOS: grant Accessibility and Screen Recording to the terminal/host app.
- Linux: X11 only (Wayland blocks synthetic input). Needs xclip or xsel for Unicode typing (pyperclip).
- Windows: works out of the box; elevated windows need an elevated host.
