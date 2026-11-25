"""Persistent ScreenCast-portal frame grabber (Wayland).

Adapted from src/services/portal-capture.py in this repo (same portal
handshake, same restore-token file), but instead of streaming raw video to a
FIFO it keeps ONE PipeWire stream open and returns the newest frame on demand.
A screenshot is then a memory copy (milliseconds) instead of a `spectacle`
process launch (about a second).

Requires (Arch): python-dbus python-gobject gst-python gst-plugin-pipewire
and a virtualenv created with --system-site-packages so dbus/gi are visible.

The first run shows KDE's one-time screen-share dialog. The restore token is
stored in the same file shmakk's capture feature uses, so approving once
covers both.
"""

from __future__ import annotations

import os
import sys
import tempfile
import threading
import time

from PIL import Image

SCREENCAST = "org.freedesktop.portal.ScreenCast"
REQUEST = "org.freedesktop.portal.Request"
DESKTOP = "org.freedesktop.portal.Desktop"
DESKTOP_PATH = "/org/freedesktop/portal/desktop"
CURSOR_MODES = {"hidden": 1, "embedded": 2, "metadata": 4}


class PortalUnavailable(RuntimeError):
    pass


def token_path() -> str:
    base = os.environ.get("SHMAKK_CAPTURE_DIR") or os.path.join(tempfile.gettempdir(), "shmakk-capture")
    return os.path.join(os.path.abspath(base), "screencast.restore")


def _read_token() -> str | None:
    try:
        with open(token_path()) as f:
            return f.read().strip() or None
    except OSError:
        return None


def _write_token(tok: str | None) -> None:
    if not tok:
        return
    try:
        os.makedirs(os.path.dirname(token_path()), exist_ok=True)
        with open(token_path(), "w") as f:
            f.write(str(tok).strip() + "\n")
    except OSError:
        pass


def _request_path(bus, token: str) -> str:
    sender = bus.get_unique_name()
    sender = sender[1:] if sender.startswith(":") else sender
    return "%s/request/%s/%s" % (DESKTOP_PATH, sender.replace(".", "_"), token)


class PortalGrabber:
    def __init__(self, cursor: str = "embedded") -> None:
        self.cursor = cursor
        self._lock = threading.Lock()
        self._pipeline = None
        self._sink = None
        self._bus = None  # keep the D-Bus connection (and thus the session) alive
        self._last: tuple[int, int, bytes] | None = None
        self.node_id: int | None = None
        self.size: tuple[int, int] | None = None

    # ------------------------------------------------------------ lifecycle
    @property
    def running(self) -> bool:
        return self._pipeline is not None

    def start(self, timeout: float = 90.0) -> None:
        try:
            import dbus
            import dbus.mainloop.glib
            import gi

            gi.require_version("Gst", "1.0")
            from gi.repository import GLib, Gst
        except Exception as e:  # noqa: BLE001
            raise PortalUnavailable(
                f"python dbus/gi not importable ({e}). Install: sudo pacman -S python-dbus python-gobject "
                "gst-python gst-plugin-pipewire, and create the venv with --system-site-packages."
            ) from e

        dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
        bus = dbus.SessionBus()
        try:
            portal = bus.get_object(DESKTOP, DESKTOP_PATH)
        except Exception as e:  # noqa: BLE001
            raise PortalUnavailable(f"xdg-desktop-portal not reachable on the session bus: {e}") from e
        screencast = dbus.Interface(portal, SCREENCAST)

        def request(call):
            token = "dmcp" + os.urandom(8).hex()
            path = _request_path(bus, token)
            state: dict = {}
            loop = GLib.MainLoop()

            def on_response(code, results):
                state["code"], state["results"] = int(code), results
                loop.quit()

            bus.add_signal_receiver(on_response, signal_name="Response", dbus_interface=REQUEST, path=path)
            timer = GLib.timeout_add_seconds(int(timeout), loop.quit)
            try:
                handle = call(token)
                if handle is not None and str(handle) != path:
                    bus.remove_signal_receiver(on_response, signal_name="Response", dbus_interface=REQUEST, path=path)
                    path = str(handle)
                    bus.add_signal_receiver(on_response, signal_name="Response", dbus_interface=REQUEST, path=path)
                loop.run()
            finally:
                GLib.source_remove(timer)
                bus.remove_signal_receiver(on_response, signal_name="Response", dbus_interface=REQUEST, path=path)
            if "code" not in state:
                raise PortalUnavailable("portal request timed out (is the screen-share dialog still open?)")
            if state["code"] != 0:
                raise PortalUnavailable(f"portal request rejected (code={state['code']}); screen sharing was denied")
            return state["results"]

        session = request(lambda t: screencast.CreateSession(dbus.Dictionary(
            {"handle_token": dbus.String(t), "session_handle_token": dbus.String("dmcp" + t)}, signature="sv")))
        sh = dbus.ObjectPath(str(session["session_handle"]))

        opts = {
            "types": dbus.UInt32(1),  # MONITOR
            "multiple": dbus.Boolean(False),
            "cursor_mode": dbus.UInt32(CURSOR_MODES[self.cursor]),
            "persist_mode": dbus.UInt32(2),
        }
        tok = _read_token()
        if tok:
            opts["restore_token"] = dbus.String(tok)
        request(lambda t: screencast.SelectSources(
            sh, dbus.Dictionary({"handle_token": dbus.String(t), **opts}, signature="sv")))
        started = request(lambda t: screencast.Start(
            sh, "", dbus.Dictionary({"handle_token": dbus.String(t)}, signature="sv")))

        streams = started.get("streams")
        if not streams:
            raise PortalUnavailable("portal Start returned no streams")
        node_id, props = streams[0]
        _write_token(started.get("restore_token") or props.get("restore_token"))

        if "pipewire_fd" in props:
            fd = props["pipewire_fd"].take()
        else:
            fd = screencast.OpenPipeWireRemote(sh, dbus.Dictionary({}, signature="sv")).take()

        Gst.init(None)
        src = "pipewiresrc fd=%d" % fd
        serial = props.get("pipewire-serial")
        src += " target-object=%d" % int(serial) if serial is not None else " path=%d" % int(node_id)
        # appsink keeps only the newest frame (drop=true, max-buffers=1) and we
        # pull on demand, so there is no per-frame Python callback or copy.
        try:
            pipeline = Gst.parse_launch(
                "%s ! video/x-raw ! videoconvert ! video/x-raw,format=BGRx ! "
                "appsink name=sink max-buffers=1 drop=true sync=false" % src
            )
        except Exception as e:  # noqa: BLE001
            raise PortalUnavailable(f"gst pipeline failed to build: {e}") from e
        sink = pipeline.get_by_name("sink")
        if pipeline.set_state(Gst.State.PLAYING) == Gst.StateChangeReturn.FAILURE:
            raise PortalUnavailable("gst pipeline failed to start")

        self._Gst = Gst
        self._bus, self._pipeline, self._sink, self.node_id = bus, pipeline, sink, int(node_id)
        # Block until the first frame so callers fail fast if the stream is dead.
        if self._pull(10.0) is None:
            self.close()
            raise PortalUnavailable("no frames received from the PipeWire stream within 10s")

    def close(self) -> None:
        if self._pipeline is not None:
            try:
                self._pipeline.set_state(self._Gst.State.NULL)
            except Exception:  # noqa: BLE001
                pass
        self._pipeline = self._sink = self._bus = None
        self._last = None

    # --------------------------------------------------------------- frames
    def _pull(self, timeout: float):
        """Pull the newest queued sample into the cache; return the cache."""
        Gst = self._Gst
        sample = self._sink.try_pull_sample(int(timeout * Gst.SECOND))
        if sample is None:
            return self._last
        s = sample.get_caps().get_structure(0)
        w, h = s.get_value("width"), s.get_value("height")
        buf = sample.get_buffer()
        ok, info = buf.map(Gst.MapFlags.READ)
        if not ok:
            return self._last
        try:
            data = bytes(info.data)
        finally:
            buf.unmap(info)
        self._last = (w, h, data)
        self.size = (w, h)
        return self._last

    def frame(self) -> Image.Image:
        """Newest frame as RGB. A static screen sends no new frames, so this
        falls back to the last one received (which is then still correct)."""
        with self._lock:
            if not self.running:
                raise PortalUnavailable("stream not running")
            if self._sink.is_eos():
                self.close()
                raise PortalUnavailable("stream ended (portal session closed)")
            got = self._pull(0.0) or self._pull(2.0)
            if got is None:
                raise PortalUnavailable("no frame available")
            w, h, data = got
            return bgrx_to_image(w, h, data)


def bgrx_to_image(w: int, h: int, data: bytes) -> Image.Image:
    """BGRx pixel buffer -> RGB image. Tolerates row padding."""
    stride = len(data) // h
    if stride < w * 4:
        raise ValueError(f"frame buffer too small: {len(data)} bytes for {w}x{h}")
    return Image.frombuffer("RGB", (w, h), data, "raw", "BGRX", stride, 1)
