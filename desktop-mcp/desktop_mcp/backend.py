"""Input/capture backends.

PyAutoGUIBackend: Windows, macOS, X11 Linux.
WaylandBackend:   Linux Wayland (KDE Plasma): ydotool for input, spectacle for
                  screenshots, wl-clipboard for Unicode text, kscreen-doctor
                  for screen geometry.

Select with DESKTOP_MCP_BACKEND=auto|pyautogui|wayland (default auto).
"""

from __future__ import annotations

import contextlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from abc import ABC, abstractmethod

from PIL import Image


class BackendError(RuntimeError):
    pass


class Backend(ABC):
    name = "base"
    can_read_cursor = True

    @abstractmethod
    def size(self) -> tuple[int, int]: ...
    @abstractmethod
    def position(self) -> tuple[int, int] | None: ...
    @abstractmethod
    def screenshot(self) -> Image.Image: ...
    @abstractmethod
    def move(self, x: int, y: int, duration: float) -> None: ...
    @abstractmethod
    def click(self, x: int | None, y: int | None, button: str, clicks: int) -> None: ...
    @abstractmethod
    def drag(self, x1: int, y1: int, x2: int, y2: int, button: str, duration: float) -> None: ...
    @abstractmethod
    def button(self, state: str, button: str) -> None: ...
    @abstractmethod
    def scroll(self, amount: int, horizontal: bool) -> None: ...
    @abstractmethod
    def type_text(self, text: str, interval: float) -> str: ...
    @abstractmethod
    def press(self, key: str, presses: int) -> None: ...
    @abstractmethod
    def hotkey(self, keys: list[str]) -> None: ...
    @abstractmethod
    def key_hold(self, key: str, state: str) -> None: ...
    def doctor(self) -> dict:
        return {"backend": self.name}


# ---------------------------------------------------------------- pyautogui

class PyAutoGUIBackend(Backend):
    name = "pyautogui"

    def __init__(self) -> None:
        # pyautogui imports `mouseinfo`, which calls sys.exit() on Linux when
        # tkinter is missing and prints to stdout (corrupting stdio JSON-RPC).
        sys.modules.setdefault("mouseinfo", type(sys)("mouseinfo"))
        with contextlib.redirect_stdout(sys.stderr):
            import pyautogui
        self.g = pyautogui
        pyautogui.FAILSAFE = os.environ.get("DESKTOP_MCP_FAILSAFE", "1") != "0"
        pyautogui.PAUSE = float(os.environ.get("DESKTOP_MCP_PAUSE", "0.05"))

    def size(self):
        s = self.g.size()
        return (s.width, s.height)

    def position(self):
        p = self.g.position()
        return (p.x, p.y)

    def screenshot(self):
        from PIL import ImageGrab

        return ImageGrab.grab()

    def move(self, x, y, duration):
        self.g.moveTo(x, y, duration=duration)

    def click(self, x, y, button, clicks):
        self.g.click(x=x, y=y, button=button, clicks=clicks, interval=0.1)

    def drag(self, x1, y1, x2, y2, button, duration):
        self.g.moveTo(x1, y1)
        self.g.dragTo(x2, y2, duration=duration, button=button)

    def button(self, state, button):
        (self.g.mouseDown if state == "down" else self.g.mouseUp)(button=button)

    def scroll(self, amount, horizontal):
        (self.g.hscroll if horizontal else self.g.scroll)(amount)

    def type_text(self, text, interval):
        if text.isascii():
            self.g.write(text, interval=interval)
            return f"typed {len(text)} chars"
        import pyperclip

        pyperclip.copy(text)
        self.g.hotkey("command" if sys.platform == "darwin" else "ctrl", "v")
        return f"pasted {len(text)} chars via clipboard"

    def _check(self, key):
        if key not in self.g.KEYBOARD_KEYS:
            raise ValueError(
                f"Unknown key '{key}'. Valid names include: enter, tab, esc, space, backspace, "
                "delete, up/down/left/right, home, end, pageup, pagedown, shift, ctrl, alt, "
                "command/win, f1-f24, and single characters."
            )

    def press(self, key, presses):
        self._check(key)
        self.g.press(key, presses=presses, interval=0.03)

    def hotkey(self, keys):
        for k in keys:
            self._check(k)
        self.g.hotkey(*keys)

    def key_hold(self, key, state):
        self._check(key)
        (self.g.keyDown if state == "down" else self.g.keyUp)(key)


# ------------------------------------------------------------------ wayland

# Linux input-event-codes (linux/input-event-codes.h).
_KEYCODES: dict[str, int] = {
    "esc": 1, "escape": 1, "enter": 28, "return": 28, "tab": 15, "space": 57,
    "backspace": 14, "delete": 111, "del": 111, "insert": 110,
    "home": 102, "end": 107, "pageup": 104, "pagedown": 109,
    "up": 103, "down": 108, "left": 105, "right": 106,
    "shift": 42, "shiftleft": 42, "shiftright": 54,
    "ctrl": 29, "ctrlleft": 29, "ctrlright": 97,
    "alt": 56, "altleft": 56, "altright": 100,
    "command": 125, "win": 125, "winleft": 125, "super": 125, "meta": 125,
    "capslock": 58, "printscreen": 99, "pause": 119, "menu": 127,
    "-": 12, "=": 13, "[": 26, "]": 27, ";": 39, "'": 40, "`": 41,
    "\\": 43, ",": 51, ".": 52, "/": 53,
}
for _i, _c in enumerate("qwertyuiop"):
    _KEYCODES[_c] = 16 + _i
for _i, _c in enumerate("asdfghjkl"):
    _KEYCODES[_c] = 30 + _i
for _i, _c in enumerate("zxcvbnm"):
    _KEYCODES[_c] = 44 + _i
for _i, _c in enumerate("1234567890"):
    _KEYCODES[_c] = 2 + _i
for _i in range(1, 11):
    _KEYCODES[f"f{_i}"] = 58 + _i
_KEYCODES["f11"], _KEYCODES["f12"] = 87, 88

# ydotool click codes: 0x40 = down, 0x80 = up, low bits = button.
_BTN = {"left": 0, "right": 1, "middle": 2}


class WaylandBackend(Backend):
    name = "wayland"
    can_read_cursor = False  # Wayland does not expose the pointer position.

    def __init__(self) -> None:
        sock = os.environ.get("YDOTOOL_SOCKET")
        if not sock:
            rt = os.environ.get("XDG_RUNTIME_DIR", f"/run/user/{os.getuid()}")
            cand = os.path.join(rt, ".ydotool_socket")
            if os.path.exists(cand):
                os.environ["YDOTOOL_SOCKET"] = cand
        self._size: tuple[int, int] | None = None

    # -- helpers
    @staticmethod
    def _need(tool: str, pkg: str) -> str:
        path = shutil.which(tool)
        if not path:
            raise BackendError(f"'{tool}' not found. Install it: sudo pacman -S {pkg}")
        return path

    def _run(self, args: list[str], timeout: float = 15) -> str:
        self._need(args[0], {"ydotool": "ydotool", "spectacle": "spectacle",
                             "wl-copy": "wl-clipboard", "kscreen-doctor": "libkscreen"}.get(args[0], args[0]))
        try:
            r = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
        except subprocess.TimeoutExpired:
            raise BackendError(f"'{args[0]}' timed out") from None
        if r.returncode != 0:
            msg = (r.stderr or r.stdout).strip()
            hint = ""
            if args[0] == "ydotool":
                hint = (" Is ydotoold running (systemctl --user enable --now ydotool) and are you in "
                        "the 'input' group (log out and in after usermod -aG input $USER)?")
            raise BackendError(f"{args[0]} failed: {msg}.{hint}")
        return r.stdout

    def _ydo(self, *args: str) -> None:
        self._run(["ydotool", *args])

    def _keycode(self, key: str) -> int:
        code = _KEYCODES.get(key.lower())
        if code is None:
            raise ValueError(
                f"Unknown key '{key}'. Valid names include: enter, tab, esc, space, backspace, delete, "
                "up/down/left/right, home, end, pageup, pagedown, shift, ctrl, alt, super/win, f1-f12, "
                "letters, digits and common punctuation."
            )
        return code

    # -- geometry / capture
    def size(self):
        if self._size:
            return self._size
        env = os.environ.get("DESKTOP_MCP_SCREEN_SIZE")  # e.g. 1920x1080
        if env:
            w, h = env.lower().split("x")
            self._size = (int(w), int(h))
            return self._size
        try:
            data = json.loads(self._run(["kscreen-doctor", "-j"]))
            xs, ys, x2s, y2s = [], [], [], []
            for o in data["outputs"]:
                if not o.get("enabled"):
                    continue
                sc = o.get("scale") or 1
                w, h = o["size"]["width"] / sc, o["size"]["height"] / sc
                px, py = o["pos"]["x"], o["pos"]["y"]
                xs.append(px); ys.append(py); x2s.append(px + w); y2s.append(py + h)
            self._size = (int(max(x2s) - min(xs)), int(max(y2s) - min(ys)))
        except Exception:
            self._size = self.screenshot().size  # last resort: physical pixels
        return self._size

    def position(self):
        return None

    def screenshot(self):
        with tempfile.TemporaryDirectory() as d:
            out = os.path.join(d, "shot.png")
            # -b background, -n no notification, -f fullscreen, -o output file
            self._run(["spectacle", "-b", "-n", "-f", "-o", out], timeout=30)
            if not os.path.exists(out):
                raise BackendError(
                    "spectacle produced no file. On first use KDE may show a screenshot "
                    "permission prompt; approve it and retry."
                )
            img = Image.open(out)
            img.load()
            return img.convert("RGB")

    # -- mouse
    def move(self, x, y, duration):
        self._ydo("mousemove", "--absolute", "-x", str(x), "-y", str(y))

    def click(self, x, y, button, clicks):
        if x is not None:
            self.move(x, y, 0)
            time.sleep(0.05)
        code = hex(0xC0 | _BTN[button])
        for i in range(clicks):
            self._ydo("click", code)
            if i < clicks - 1:
                time.sleep(0.08)

    def drag(self, x1, y1, x2, y2, button, duration):
        self.move(x1, y1, 0)
        time.sleep(0.05)
        self.button("down", button)
        time.sleep(0.05)
        steps = max(2, int(duration / 0.02))
        for i in range(1, steps + 1):
            self.move(round(x1 + (x2 - x1) * i / steps), round(y1 + (y2 - y1) * i / steps), 0)
            time.sleep(duration / steps)
        self.button("up", button)

    def button(self, state, button):
        flag = 0x40 if state == "down" else 0x80
        self._ydo("click", hex(flag | _BTN[button]))

    def scroll(self, amount, horizontal):
        # Positive = up/right (REL_WHEEL / REL_HWHEEL).
        x, y = (amount, 0) if horizontal else (0, amount)
        self._ydo("mousemove", "--wheel", "-x", str(x), "-y", str(y))

    # -- keyboard
    def type_text(self, text, interval):
        if text.isascii():
            # Note: ydotool types using a US layout; other layouts may differ.
            self._ydo("type", "--key-delay", str(max(1, int(interval * 1000))), "--", text)
            return f"typed {len(text)} chars"
        self._run(["wl-copy", "--", text])
        self.hotkey(["ctrl", "v"])
        return f"pasted {len(text)} chars via clipboard (not valid in terminals; they need ctrl+shift+v)"

    def _events(self, keys: list[str]) -> list[str]:
        codes = [self._keycode(k) for k in keys]
        return [f"{c}:1" for c in codes] + [f"{c}:0" for c in reversed(codes)]

    def press(self, key, presses):
        ev = self._events([key]) * presses
        self._ydo("key", *ev)

    def hotkey(self, keys):
        self._ydo("key", *self._events(keys))

    def key_hold(self, key, state):
        self._ydo("key", f"{self._keycode(key)}:{1 if state == 'down' else 0}")

    def doctor(self):
        rt = os.environ.get("XDG_RUNTIME_DIR", "")
        return {
            "backend": self.name,
            "session_type": os.environ.get("XDG_SESSION_TYPE"),
            "tools": {t: bool(shutil.which(t)) for t in ("ydotool", "ydotoold", "spectacle", "wl-copy", "kscreen-doctor")},
            "ydotool_socket": os.environ.get("YDOTOOL_SOCKET") or (os.path.join(rt, ".ydotool_socket") if rt else None),
            "ydotool_socket_exists": os.path.exists(os.environ.get("YDOTOOL_SOCKET") or os.path.join(rt, ".ydotool_socket")),
            "uinput_writable": os.access("/dev/uinput", os.W_OK),
            "logical_screen_size": None,  # filled by server
        }


def make_backend() -> Backend:
    choice = os.environ.get("DESKTOP_MCP_BACKEND", "auto").lower()
    if choice == "pyautogui":
        return PyAutoGUIBackend()
    if choice == "wayland":
        return WaylandBackend()
    if sys.platform.startswith("linux") and (
        os.environ.get("XDG_SESSION_TYPE") == "wayland" or os.environ.get("WAYLAND_DISPLAY")
    ) and os.environ.get("DESKTOP_MCP_BACKEND") != "pyautogui":
        return WaylandBackend()
    return PyAutoGUIBackend()
