"""Desktop control MCP server: mouse, keyboard, scroll, screenshots.

Cross-platform. Windows/macOS/X11 use pyautogui; Wayland (KDE Plasma) uses
ydotool + spectacle. Runs over stdio.

Coordinates: every tool uses one "view" space, which is the real logical screen
scaled down so its width is at most DESKTOP_MCP_VIEW_WIDTH (default 1280). A
screenshot is exactly the view, so pixel positions in the image are the
coordinates to click. No scaling math for the caller.

Environment:
  DESKTOP_MCP_BACKEND=auto|pyautogui|wayland   (default auto)
  DESKTOP_MCP_VIEW_WIDTH=1280   max width of the view / screenshots
  DESKTOP_MCP_JPEG_QUALITY=70   screenshot quality
  DESKTOP_MCP_SETTLE=0.4        seconds to wait before an after-action screenshot
  DESKTOP_MCP_FAILSAFE=0        disable corner-abort (pyautogui backend only)
  DESKTOP_MCP_PAUSE=0.05        pause after each pyautogui call
  DESKTOP_MCP_READONLY=1        only expose info / screenshot / wait / doctor
  DESKTOP_MCP_SCREEN_SIZE=WxH   override logical screen size (Wayland)
  YDOTOOL_SOCKET=path           ydotoold socket (Wayland), auto-detected if unset
"""

from __future__ import annotations

import io
import os
import time
from typing import Literal

from mcp.server.fastmcp import FastMCP, Image
from mcp.types import ToolAnnotations
from PIL import Image as PILImage
from pydantic import BaseModel, Field

from .backend import make_backend

READONLY = os.environ.get("DESKTOP_MCP_READONLY", "0") == "1"
VIEW_W = int(os.environ.get("DESKTOP_MCP_VIEW_WIDTH", "1280"))
JPEG_Q = int(os.environ.get("DESKTOP_MCP_JPEG_QUALITY", "70"))
SETTLE = float(os.environ.get("DESKTOP_MCP_SETTLE", "0.4"))
B = make_backend()

mcp = FastMCP("desktop_mcp")

Button = Literal["left", "right", "middle"]

_READ = ToolAnnotations(readOnlyHint=True, destructiveHint=False, idempotentHint=True, openWorldHint=False)
_ACT = ToolAnnotations(readOnlyHint=False, destructiveHint=True, idempotentHint=False, openWorldHint=True)

SHOT = Field(False, description="Return a screenshot of the result after the action. Saves a separate desktop_screenshot call.")


def action(fn):
    """Register a tool that changes desktop state (skipped in read-only mode)."""
    if READONLY:
        return fn
    return mcp.tool(annotations=_ACT)(fn)


# ------------------------------------------------------------- coordinates

def _geom() -> tuple[int, int, int, int]:
    """(real_w, real_h, view_w, view_h)."""
    sw, sh = B.size()
    s = min(1.0, VIEW_W / sw)
    return sw, sh, max(1, round(sw * s)), max(1, round(sh * s))


def _to_real(x: int, y: int) -> tuple[int, int]:
    sw, sh, vw, vh = _geom()
    if not (0 <= x < vw and 0 <= y < vh):
        raise ValueError(f"Point ({x}, {y}) is outside the screen view ({vw}x{vh}).")
    return min(sw - 1, round(x * sw / vw)), min(sh - 1, round(y * sh / vh))


def _pair(x, y):
    if (x is None) != (y is None):
        raise ValueError("Provide both x and y, or neither.")
    return _to_real(x, y) if x is not None else (None, None)


def _pos() -> str:
    p = B.position()
    if not p:
        return "cursor position unavailable"
    sw, sh, vw, vh = _geom()
    return f"cursor at ({round(p[0] * vw / sw)}, {round(p[1] * vh / sh)})"


# ------------------------------------------------------------------ capture

def _capture(region: tuple[int, int, int, int] | None = None, zoom: float = 1.0):
    """Return (jpeg_bytes, note). Region is in view coordinates."""
    _, _, vw, vh = _geom()
    img = B.screenshot()
    nw, nh = img.size
    if region:
        x, y, w, h = region
        x, y = max(0, x), max(0, y)
        w, h = min(vw - x, w), min(vh - y, h)
        if w <= 0 or h <= 0:
            raise ValueError(f"Region is outside the screen view ({vw}x{vh}).")
        fx, fy = nw / vw, nh / vh
        img = img.crop((round(x * fx), round(y * fy), round((x + w) * fx), round((y + h) * fy)))
        out = (max(1, round(w * zoom)), max(1, round(h * zoom)))
        note = (f"Crop of view region x={x} y={y} w={w} h={h} at zoom {zoom:g}. "
                f"Click coordinates: x_view = {x} + px/{zoom:g}, y_view = {y} + py/{zoom:g}.")
    else:
        out = (vw, vh)
        note = f"Full screen {vw}x{vh}. Image pixels are the coordinates to click."
    if img.size != out:
        img = img.resize(out, PILImage.BILINEAR, reducing_gap=2.0)
    buf = io.BytesIO()
    img.convert("RGB").save(buf, format="JPEG", quality=JPEG_Q)
    return buf.getvalue(), note


def _finish(msg: str, shot: bool, settle: float | None = None):
    if not shot:
        return msg
    time.sleep(SETTLE if settle is None else settle)
    data, _ = _capture()
    return [msg, Image(data=data, format="jpeg")]


# ---------------------------------------------------------------- read-only

@mcp.tool(annotations=_READ)
def desktop_screen_info() -> dict:
    """Screen size in view coordinates (what every tool uses), the real logical
    size, cursor position (null on Wayland) and the backend in use."""
    sw, sh, vw, vh = _geom()
    p = B.position()
    cur = {"x": round(p[0] * vw / sw), "y": round(p[1] * vh / sh)} if p else None
    return {"view_width": vw, "view_height": vh, "real_width": sw, "real_height": sh,
            "cursor": cur, "backend": B.name}


@mcp.tool(annotations=_READ)
def desktop_doctor() -> dict:
    """Diagnose the backend: which required tools, sockets and permissions are
    present. Call this only if input or screenshots fail."""
    d = B.doctor()
    try:
        d["logical_screen_size"] = list(B.size())
    except Exception as e:  # noqa: BLE001
        d["logical_screen_size_error"] = str(e)
    return d


@mcp.tool(annotations=_READ)
def desktop_screenshot(
    x: int | None = Field(None, description="Left of optional region (view coords). Use a region to read small text or check one widget cheaply."),
    y: int | None = Field(None, description="Top of region"),
    width: int | None = Field(None, gt=0, description="Width of region"),
    height: int | None = Field(None, gt=0, description="Height of region"),
    zoom: float = Field(1.0, ge=0.25, le=4.0, description="Region magnification. >1 gives sharper small text; <1 makes it smaller/cheaper."),
):
    """Screenshot (JPEG). With no arguments it is the full screen at view size and
    image pixels ARE the click coordinates. Prefer a region for small checks and
    prefer screenshot=true on action tools over a separate call."""
    region = (x, y, width, height) if None not in (x, y, width, height) else None
    data, note = _capture(region, zoom)
    return [note, Image(data=data, format="jpeg")]


@mcp.tool(annotations=_READ)
def desktop_wait(seconds: float = Field(1.0, ge=0, le=30, description="Seconds to wait"),
                 screenshot: bool = SHOT):
    """Wait for an app or animation to settle."""
    time.sleep(seconds)
    return _finish(f"waited {seconds}s", screenshot, 0)


# -------------------------------------------------------------------- mouse

@action
def desktop_mouse_move(
    x: int = Field(description="Target X in view coordinates"),
    y: int = Field(description="Target Y in view coordinates"),
    duration: float = Field(0.0, ge=0, le=5, description="Seconds to glide; 0 = instant (ignored on Wayland)"),
    screenshot: bool = SHOT,
):
    """Move the mouse cursor to view coordinates."""
    rx, ry = _to_real(x, y)
    B.move(rx, ry, duration)
    return _finish(_pos(), screenshot)


@action
def desktop_mouse_click(
    x: int | None = Field(None, description="X to click at (view coords); omit to click at current cursor"),
    y: int | None = Field(None, description="Y to click at; omit to click at current cursor"),
    button: Button = "left",
    clicks: int = Field(1, ge=1, le=3, description="1 = click, 2 = double-click, 3 = triple-click"),
    screenshot: bool = SHOT,
):
    """Click a mouse button, optionally after moving to (x, y)."""
    rx, ry = _pair(x, y)
    B.click(rx, ry, button, clicks)
    return _finish(f"{button} click x{clicks}; {_pos()}", screenshot)


@action
def desktop_mouse_drag(
    from_x: int, from_y: int, to_x: int, to_y: int,
    button: Button = "left",
    duration: float = Field(0.3, ge=0.05, le=10, description="Seconds for the drag"),
    screenshot: bool = SHOT,
):
    """Press at (from_x, from_y), drag to (to_x, to_y), release. View coordinates."""
    f, t = _to_real(from_x, from_y), _to_real(to_x, to_y)
    B.drag(f[0], f[1], t[0], t[1], button, duration)
    return _finish(_pos(), screenshot)


@action
def desktop_mouse_button(state: Literal["down", "up"], button: Button = "left"):
    """Hold or release a mouse button at the current cursor (for custom drags)."""
    B.button(state, button)
    return f"{button} {state}; {_pos()}"


@action
def desktop_scroll(
    amount: int = Field(description="Wheel clicks. Positive = up / right, negative = down / left"),
    horizontal: bool = Field(False, description="Scroll horizontally instead of vertically"),
    x: int | None = Field(None, description="Move here first (scroll targets the window under the cursor)"),
    y: int | None = None,
    screenshot: bool = SHOT,
):
    """Scroll the mouse wheel."""
    rx, ry = _pair(x, y)
    if rx is not None:
        B.move(rx, ry, 0)
    B.scroll(amount, horizontal)
    return _finish(f"scrolled {amount} {'horizontal' if horizontal else 'vertical'}", screenshot)


# ----------------------------------------------------------------- keyboard

@action
def desktop_type_text(
    text: str = Field(description="Text to type into the focused window"),
    interval: float = Field(0.005, ge=0, le=1, description="Seconds between keystrokes (ASCII path)"),
    enter: bool = Field(False, description="Press Enter afterwards"),
    screenshot: bool = SHOT,
):
    """Type text. ASCII is typed key by key; other characters are pasted via the
    clipboard (which overwrites it)."""
    msg = B.type_text(text, interval)
    if enter:
        B.press("enter", 1)
        msg += " + enter"
    return _finish(msg, screenshot)


@action
def desktop_key_press(
    key: str = Field(description="Key name, e.g. enter, tab, esc, backspace, delete, up, down, left, right, home, end, pageup, pagedown, space, super, f1..f12"),
    presses: int = Field(1, ge=1, le=100),
    screenshot: bool = SHOT,
):
    """Press and release a single key one or more times."""
    B.press(key, presses)
    return _finish(f"pressed {key} x{presses}", screenshot)


@action
def desktop_hotkey(
    keys: list[str] = Field(description='Keys held together in order, e.g. ["ctrl","c"], ["super","space"], ["alt","f4"]'),
    screenshot: bool = SHOT,
):
    """Press a key combination (modifiers first, then the final key)."""
    if not keys:
        raise ValueError("keys must not be empty")
    B.hotkey(keys)
    return _finish("pressed " + "+".join(keys), screenshot)


@action
def desktop_key_hold(key: str, state: Literal["down", "up"]):
    """Hold or release a key (always release what you hold)."""
    B.key_hold(key, state)
    return f"{key} {state}"


# -------------------------------------------------------------------- batch

class Step(BaseModel):
    do: Literal["move", "click", "double_click", "right_click", "drag", "scroll",
                "type", "key", "hotkey", "wait"]
    x: int | None = Field(None, description="view X (move/click/drag start/scroll target)")
    y: int | None = None
    to_x: int | None = Field(None, description="drag end X")
    to_y: int | None = None
    text: str | None = Field(None, description="for type")
    enter: bool = Field(False, description="for type: press Enter after")
    key: str | None = Field(None, description="for key")
    keys: list[str] | None = Field(None, description="for hotkey")
    amount: int | None = Field(None, description="for scroll: positive up/right, negative down/left")
    horizontal: bool = False
    seconds: float | None = Field(None, ge=0, le=30, description="for wait")


def _need(step: Step, *names: str) -> None:
    for n in names:
        if getattr(step, n) is None:
            raise ValueError(f"'{step.do}' needs '{n}'")


def _run_step(s: Step) -> None:
    d = s.do
    if d == "move":
        _need(s, "x", "y"); B.move(*_to_real(s.x, s.y), 0)
    elif d in ("click", "double_click", "right_click"):
        rx, ry = _pair(s.x, s.y)
        B.click(rx, ry, "right" if d == "right_click" else "left", 2 if d == "double_click" else 1)
    elif d == "drag":
        _need(s, "x", "y", "to_x", "to_y")
        f, t = _to_real(s.x, s.y), _to_real(s.to_x, s.to_y)
        B.drag(f[0], f[1], t[0], t[1], "left", 0.3)
    elif d == "scroll":
        _need(s, "amount")
        rx, ry = _pair(s.x, s.y)
        if rx is not None:
            B.move(rx, ry, 0)
        B.scroll(s.amount, s.horizontal)
    elif d == "type":
        _need(s, "text"); B.type_text(s.text, 0.005)
        if s.enter:
            B.press("enter", 1)
    elif d == "key":
        _need(s, "key"); B.press(s.key, 1)
    elif d == "hotkey":
        _need(s, "keys"); B.hotkey(s.keys)
    elif d == "wait":
        time.sleep(s.seconds if s.seconds is not None else 0.5)


@action
def desktop_do(
    steps: list[Step] = Field(description="Actions run in order in ONE call. Stops at the first error."),
    screenshot: bool = Field(True, description="Return a screenshot after the last step"),
    settle: float = Field(0.6, ge=0, le=10, description="Seconds to wait before that screenshot"),
):
    """Run several actions in a single call, then optionally screenshot. Use this
    instead of many separate calls; it is much faster. Example, open a launcher
    app and search: [{"do":"key","key":"super"},{"do":"wait","seconds":0.5},
    {"do":"type","text":"volume control"},{"do":"wait","seconds":0.5}]."""
    for i, s in enumerate(steps):
        try:
            _run_step(s)
        except Exception as e:  # noqa: BLE001
            raise ValueError(f"step {i + 1}/{len(steps)} ({s.do}) failed after {i} completed: {e}") from e
        if s.do not in ("wait",):
            time.sleep(0.03)
    return _finish(f"ran {len(steps)} steps", screenshot, settle)


def main() -> None:
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
