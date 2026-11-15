"""Desktop control MCP server: mouse, keyboard, scroll, screenshots.

Cross-platform via pyautogui (Windows, macOS, X11 Linux). Runs over stdio.

Environment:
  DESKTOP_MCP_FAILSAFE=0   disable the move-mouse-to-corner abort (default on)
  DESKTOP_MCP_PAUSE=0.05   seconds to pause after each pyautogui call
  DESKTOP_MCP_READONLY=1   only expose screen_info / screenshot / wait
"""

from __future__ import annotations

import contextlib
import io
import os
import sys
import time
from typing import Literal

# pyautogui imports `mouseinfo`, which on Linux calls sys.exit() when tkinter
# is missing (killing the server at import) and prints to stdout (corrupting
# the stdio JSON-RPC stream). We never use MouseInfo, so stub it out, and send
# any other import-time chatter to stderr.
sys.modules.setdefault("mouseinfo", type(sys)("mouseinfo"))
with contextlib.redirect_stdout(sys.stderr):
    import pyautogui
from mcp.server.fastmcp import FastMCP, Image
from mcp.types import ToolAnnotations
from pydantic import Field

pyautogui.FAILSAFE = os.environ.get("DESKTOP_MCP_FAILSAFE", "1") != "0"
pyautogui.PAUSE = float(os.environ.get("DESKTOP_MCP_PAUSE", "0.05"))
READONLY = os.environ.get("DESKTOP_MCP_READONLY", "0") == "1"

mcp = FastMCP("desktop_mcp")

Button = Literal["left", "right", "middle"]

_READ = ToolAnnotations(readOnlyHint=True, destructiveHint=False, idempotentHint=True, openWorldHint=False)
_ACT = ToolAnnotations(readOnlyHint=False, destructiveHint=True, idempotentHint=False, openWorldHint=True)


def action(fn):
    """Register a tool that changes desktop state (skipped in read-only mode)."""
    if READONLY:
        return fn
    return mcp.tool(annotations=_ACT)(fn)


def _check_point(x: int, y: int) -> None:
    w, h = pyautogui.size()
    if not (0 <= x < w and 0 <= y < h):
        raise ValueError(
            f"Point ({x}, {y}) is outside the screen ({w}x{h}). "
            "Call desktop_screen_info for bounds."
        )


def _pos() -> str:
    p = pyautogui.position()
    return f"cursor at ({p.x}, {p.y})"


# ---------------------------------------------------------------- read-only

@mcp.tool(annotations=_READ)
def desktop_screen_info() -> dict:
    """Return screen size in logical pixels and current cursor position.

    All coordinates used by other desktop_* tools are in this space, with
    (0, 0) at the top-left.
    """
    w, h = pyautogui.size()
    p = pyautogui.position()
    return {"width": w, "height": h, "cursor": {"x": p.x, "y": p.y}}


@mcp.tool(annotations=_READ)
def desktop_screenshot(
    scale: float = Field(1.0, gt=0.05, le=1.0, description="Downscale factor. Coordinates in the image must be divided by this to get screen coordinates."),
    x: int | None = Field(None, description="Left of optional crop region (screen coords)"),
    y: int | None = Field(None, description="Top of optional crop region"),
    width: int | None = Field(None, gt=0, description="Width of crop region"),
    height: int | None = Field(None, gt=0, description="Height of crop region"),
) -> Image:
    """Capture the screen (or a region) as a PNG.

    Image pixels map 1:1 to screen coordinates when scale=1 and no crop. With
    a crop, add (x, y) to image coordinates; with scale<1, divide by scale.
    """
    from PIL import ImageGrab

    sw, sh = pyautogui.size()
    img = ImageGrab.grab()  # full screen; no external tools needed
    # HiDPI: captured pixels may exceed logical size; normalise to logical.
    if img.size != (sw, sh):
        img = img.resize((sw, sh))
    if None not in (x, y, width, height):
        left, top = max(0, x), max(0, y)
        right, bottom = min(sw, x + width), min(sh, y + height)
        if right <= left or bottom <= top:
            raise ValueError(f"Crop region is outside the screen ({sw}x{sh}).")
        img = img.crop((left, top, right, bottom))
    if scale < 1.0:
        img = img.resize((max(1, int(img.width * scale)), max(1, int(img.height * scale))))
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return Image(data=buf.getvalue(), format="png")


@mcp.tool(annotations=_READ)
def desktop_wait(seconds: float = Field(1.0, ge=0, le=30, description="Seconds to wait")) -> str:
    """Wait, e.g. for an app or animation to settle before the next screenshot."""
    time.sleep(seconds)
    return f"waited {seconds}s"


# -------------------------------------------------------------------- mouse

@action
def desktop_mouse_move(
    x: int = Field(description="Target X in screen pixels"),
    y: int = Field(description="Target Y in screen pixels"),
    duration: float = Field(0.2, ge=0, le=5, description="Seconds to glide; 0 = instant"),
) -> str:
    """Move the mouse cursor to absolute coordinates."""
    _check_point(x, y)
    pyautogui.moveTo(x, y, duration=duration)
    return _pos()


@action
def desktop_mouse_click(
    x: int | None = Field(None, description="X to click at; omit to click at current cursor"),
    y: int | None = Field(None, description="Y to click at; omit to click at current cursor"),
    button: Button = "left",
    clicks: int = Field(1, ge=1, le=3, description="1 = click, 2 = double-click, 3 = triple-click"),
) -> str:
    """Click a mouse button, optionally after moving to (x, y)."""
    if (x is None) != (y is None):
        raise ValueError("Provide both x and y, or neither.")
    if x is not None:
        _check_point(x, y)
    pyautogui.click(x=x, y=y, button=button, clicks=clicks, interval=0.1)
    return f"{button} click x{clicks}; {_pos()}"


@action
def desktop_mouse_drag(
    from_x: int, from_y: int, to_x: int, to_y: int,
    button: Button = "left",
    duration: float = Field(0.4, ge=0.05, le=10, description="Seconds for the drag"),
) -> str:
    """Press at (from_x, from_y), drag to (to_x, to_y), release."""
    _check_point(from_x, from_y)
    _check_point(to_x, to_y)
    pyautogui.moveTo(from_x, from_y)
    pyautogui.dragTo(to_x, to_y, duration=duration, button=button)
    return _pos()


@action
def desktop_mouse_button(
    state: Literal["down", "up"],
    button: Button = "left",
) -> str:
    """Hold or release a mouse button at the current cursor (for custom drags)."""
    (pyautogui.mouseDown if state == "down" else pyautogui.mouseUp)(button=button)
    return f"{button} {state}; {_pos()}"


@action
def desktop_scroll(
    amount: int = Field(description="Wheel clicks. Positive = up / right, negative = down / left"),
    horizontal: bool = Field(False, description="Scroll horizontally instead of vertically"),
    x: int | None = Field(None, description="Move here first (scroll targets the window under the cursor)"),
    y: int | None = None,
) -> str:
    """Scroll the mouse wheel."""
    if (x is None) != (y is None):
        raise ValueError("Provide both x and y, or neither.")
    if x is not None:
        _check_point(x, y)
        pyautogui.moveTo(x, y)
    (pyautogui.hscroll if horizontal else pyautogui.scroll)(amount)
    return f"scrolled {amount} {'horizontal' if horizontal else 'vertical'}; {_pos()}"


# ----------------------------------------------------------------- keyboard

@action
def desktop_type_text(
    text: str = Field(description="Text to type into the focused window"),
    interval: float = Field(0.01, ge=0, le=1, description="Seconds between keystrokes (ASCII path)"),
) -> str:
    """Type text. ASCII is typed key by key; text with other characters is
    pasted through the clipboard (clipboard contents are overwritten)."""
    if text.isascii():
        pyautogui.write(text, interval=interval)
        return f"typed {len(text)} chars"
    import pyperclip

    pyperclip.copy(text)
    pyautogui.hotkey("command" if _is_mac() else "ctrl", "v")
    return f"pasted {len(text)} chars via clipboard"


@action
def desktop_key_press(
    key: str = Field(description="Key name, e.g. enter, tab, esc, backspace, delete, up, down, left, right, home, end, pageup, pagedown, space, f1..f24"),
    presses: int = Field(1, ge=1, le=100),
) -> str:
    """Press and release a single key one or more times."""
    _check_key(key)
    pyautogui.press(key, presses=presses, interval=0.03)
    return f"pressed {key} x{presses}"


@action
def desktop_hotkey(
    keys: list[str] = Field(description='Keys held together in order, e.g. ["ctrl","c"], ["command","space"], ["alt","f4"]'),
) -> str:
    """Press a key combination (modifiers first, then the final key)."""
    if not keys:
        raise ValueError("keys must not be empty")
    for k in keys:
        _check_key(k)
    pyautogui.hotkey(*keys)
    return "pressed " + "+".join(keys)


@action
def desktop_key_hold(
    key: str,
    state: Literal["down", "up"],
) -> str:
    """Hold or release a key (always release what you hold)."""
    _check_key(key)
    (pyautogui.keyDown if state == "down" else pyautogui.keyUp)(key)
    return f"{key} {state}"


# ------------------------------------------------------------------ helpers

def _is_mac() -> bool:
    return sys.platform == "darwin"


def _check_key(key: str) -> None:
    if key not in pyautogui.KEYBOARD_KEYS:
        raise ValueError(
            f"Unknown key '{key}'. Valid names include: enter, tab, esc, space, backspace, "
            "delete, up/down/left/right, home, end, pageup, pagedown, shift, ctrl, alt, "
            "command/win, f1-f24, and single characters."
        )


def main() -> None:
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
