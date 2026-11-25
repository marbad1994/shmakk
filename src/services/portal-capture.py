#!/usr/bin/env python3
"""ScreenCast portal helper for shmakk capture.

Negotiates org.freedesktop.portal.ScreenCast on the session bus to open a
PipeWire stream for the whole desktop (MONITOR), then streams raw BGRx video
into a FIFO that ffmpeg reads via a GStreamer pipeline.

One JSON metadata line is written to stdout before the stream starts:

    {"nodeId": <int>, "width": <int>, "height": <int>, "restoreToken": <str|null>}

The width/height reported are the *actual* dimensions GStreamer negotiated with
the stream (the native resolution), not the portal's logical `size` prop, which
differs under fractional scaling.

Requires: python3 (dbus + PyGObject), gst-python, gstreamer with the pipewire
plugin, and a running xdg-desktop-portal with a ScreenCast backend. The first
capture pops a one-time screen-share dialog; subsequent captures use the restore
token and skip it.
"""

import argparse
import json
import os
import signal
import sys

import dbus
import dbus.mainloop.glib
import gi

gi.require_version("Gst", "1.0")
gi.require_version("GLibUnix", "2.0")
from gi.repository import GLib, GLibUnix, Gst

SCREENCAST = "org.freedesktop.portal.ScreenCast"
REQUEST = "org.freedesktop.portal.Request"
DESKTOP = "org.freedesktop.portal.Desktop"
DESKTOP_PATH = "/org/freedesktop/portal/desktop"

CURSOR_MODES = {"hidden": 1, "embedded": 2, "metadata": 4}


def request_path(bus, token):
    # xdg-desktop-portal (>= 0.9) builds the request object path from the
    # sender's unique name with the initial ':' removed and all '.' replaced
    # by '_' (e.g. ':1.273' -> '1_273').
    sender = bus.get_unique_name()
    if sender.startswith(":"):
        sender = sender[1:]
    sender = sender.replace(".", "_")
    return "%s/request/%s/%s" % (DESKTOP_PATH, sender, token)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fifo", required=True)
    ap.add_argument("--cursor", default="embedded", choices=sorted(CURSOR_MODES))
    ap.add_argument("--restore-token", default=None)
    args = ap.parse_args()

    dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
    bus = dbus.SessionBus()
    portal = bus.get_object(DESKTOP, DESKTOP_PATH)
    screencast = dbus.Interface(portal, SCREENCAST)

    def request(call):
        """Invoke a portal method and wait for its Request::Response signal."""
        token = "shmakk" + os.urandom(8).hex()
        path = request_path(bus, token)
        state = {}
        loop = GLib.MainLoop()

        def on_response(code, results):
            state["code"] = int(code)
            state["results"] = results
            loop.quit()

        bus.add_signal_receiver(
            on_response, signal_name="Response", dbus_interface=REQUEST, path=path
        )
        timeout = GLib.timeout_add_seconds(60, loop.quit)
        try:
            handle = call(token)
            # The portal returns the actual request handle. Verify it matches the
            # path we subscribed to and, if not (e.g. older portal versions),
            # re-subscribe at the real handle so we never miss the Response.
            if handle is not None and str(handle) != path:
                bus.remove_signal_receiver(
                    on_response, signal_name="Response", dbus_interface=REQUEST, path=path
                )
                path = str(handle)
                bus.add_signal_receiver(
                    on_response, signal_name="Response", dbus_interface=REQUEST, path=path
                )
            loop.run()
        finally:
            GLib.source_remove(timeout)
            bus.remove_signal_receiver(
                on_response, signal_name="Response", dbus_interface=REQUEST, path=path
            )

        if "code" not in state:
            raise RuntimeError("portal request timed out (screen-share dialog open?)")
        if state["code"] != 0:
            raise RuntimeError("portal request rejected (code=%s)" % state["code"])
        return state["results"]

    # 1. CreateSession
    session = request(
        lambda token: screencast.CreateSession(
            dbus.Dictionary(
                {
                    "handle_token": dbus.String(token),
                    "session_handle_token": dbus.String("shmakk" + token),
                },
                signature="sv",
            )
        )
    )
    session_handle = dbus.ObjectPath(str(session["session_handle"]))

    # 2. SelectSources: whole desktop, embedded cursor, persistent selection.
    select_opts = {
        "types": dbus.UInt32(1),  # MONITOR bitmask
        "multiple": dbus.Boolean(False),
        "cursor_mode": dbus.UInt32(CURSOR_MODES[args.cursor]),
        "persist_mode": dbus.UInt32(2),  # persistent
    }
    if args.restore_token:
        select_opts["restore_token"] = dbus.String(args.restore_token)

    request(
        lambda token: screencast.SelectSources(
            session_handle,
            dbus.Dictionary(
                {"handle_token": dbus.String(token), **select_opts},
                signature="sv",
            ),
        )
    )

    # 3. Start
    started = request(
        lambda token: screencast.Start(
            session_handle,
            "",
            dbus.Dictionary({"handle_token": dbus.String(token)}, signature="sv"),
        )
    )

    streams = started.get("streams")
    if not streams or len(streams) == 0:
        raise RuntimeError("Start returned no streams")
    node_id, props = streams[0]

    size = props.get("size")
    width, height = (int(size[0]), int(size[1])) if size and len(size) >= 2 else (0, 0)

    serial = props.get("pipewire-serial")
    restore_token = started.get("restore_token") or props.get("restore_token")

    # 4. PipeWire fd. v6: OpenPipeWireRemote; older portals embed pipewire_fd.
    if "pipewire_fd" in props:
        fd = props["pipewire_fd"].take()
    else:
        fd = screencast.OpenPipeWireRemote(
            session_handle, dbus.Dictionary({}, signature="sv")
        ).take()

    os.set_inheritable(fd, True)

    # 5. Stream raw video into the FIFO with GStreamer. The ScreenCast portal
    #    reports the *logical* desktop size in `props["size"]` (e.g. 1438x808 at
    #    KDE scale 0.95), but pipewiresrc delivers the *native* stream
    #    (1366x768). ffmpeg reads the FIFO with the size we report here, so we
    #    report the size GStreamer actually negotiated rather than the portal's
    #    logical size; reporting the wrong size makes ffmpeg misread the raw
    #    bytes into scanline glitches.
    Gst.init(None)

    src_spec = "pipewiresrc fd=%d" % fd
    if serial is not None:
        # v6: target by object.serial (never reused).
        src_spec += " target-object=%d" % int(serial)
    else:
        src_spec += " path=%d" % int(node_id)

    try:
        pipeline = Gst.parse_launch(
            "%s name=pwsrc ! video/x-raw ! videoconvert ! "
            "video/x-raw,format=BGRx ! filesink location=%s sync=false"
            % (src_spec, args.fifo)
        )
    except Exception as exc:
        print("gst pipeline failed to build: %s" % exc, file=sys.stderr)
        sys.exit(1)

    pwsrc = pipeline.get_by_name("pwsrc")
    srcpad = pwsrc.get_static_pad("src")
    loop = GLib.MainLoop()
    polls = {"n": 0}

    def report_metadata():
        caps = srcpad.get_current_caps()
        if caps and caps.get_size() > 0:
            struct = caps.get_structure(0)
            ok_w, cw = struct.get_int("width")
            ok_h, ch = struct.get_int("height")
            if ok_w and ok_h and cw > 0 and ch > 0:
                print(
                    json.dumps(
                        {
                            "nodeId": int(node_id),
                            "width": cw,
                            "height": ch,
                            "restoreToken": str(restore_token) if restore_token else None,
                        }
                    ),
                    flush=True,
                )
                return False  # actual size known; stop polling

        # Stream hasn't negotiated a size yet. Give it up to ~10s before falling
        # back to the portal-reported logical size.
        polls["n"] += 1
        if polls["n"] >= 100:
            print(
                json.dumps(
                    {
                        "nodeId": int(node_id),
                        "width": width,
                        "height": height,
                        "restoreToken": str(restore_token) if restore_token else None,
                    }
                ),
                flush=True,
            )
            return False
        return True

    def on_bus(bus, msg):
        if msg.type == Gst.MessageType.ERROR:
            err, _ = msg.parse_error()
            print("gst error: %s" % (err.message if err else msg), file=sys.stderr)
            loop.quit()
        return True

    bus = pipeline.get_bus()
    bus.add_signal_watch()
    bus.connect("message", on_bus)

    # POSIX FIFO open() blocks until both ends are open. capture.js creates the
    # FIFO and waits for our metadata line before launching ffmpeg (the reader),
    # so filesink's open(O_WRONLY) would deadlock here. Open the read end first
    # (non-blocking, never read from, kept for the process lifetime) so the
    # writer open completes at once and we can negotiate the real size before
    # ffmpeg attaches. ffmpeg still reads every byte; this fd only satisfies the
    # open() handshake and keeps filesink from hitting EPIPE.
    fifo_reader = os.open(args.fifo, os.O_RDONLY | os.O_NONBLOCK)

    if pipeline.set_state(Gst.State.PLAYING) == Gst.StateChangeReturn.FAILURE:
        print("gst pipeline failed to start", file=sys.stderr)
        sys.exit(1)

    GLib.timeout_add(100, report_metadata)
    GLibUnix.signal_add(GLib.PRIORITY_HIGH, signal.SIGTERM, loop.quit)
    GLibUnix.signal_add(GLib.PRIORITY_HIGH, signal.SIGINT, loop.quit)

    try:
        loop.run()
    finally:
        pipeline.set_state(Gst.State.NULL)


if __name__ == "__main__":
    main()
