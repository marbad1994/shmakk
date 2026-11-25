// shmakk window watcher (KWin script, Plasma 6 API).
//
// Runs inside the compositor and forwards window events to the shmakk
// windows daemon (`shmakk windows-daemon`), which owns dev.shmakk.Windows on
// the session bus. If the daemon is not running the calls fail silently and
// nothing is recorded.
//
// Every event is one JSON string passed to dev.shmakk.Windows.Event:
//   { kind: "focus" | "open" | "close" | "geometry" | "snapshot" | "command", t, ... }
//
// Shortcuts (rebind in System Settings > Shortcuts > KWin):
//   Ctrl+Alt+;   reorder windows; press again for the next layout (daemon)
//   Ctrl+Alt+'   swap the window layouts of the two screens (here, instant)
//
// The block between BEGIN SHARED and END SHARED is also loaded by
// src/services/windows.js and prepended to its one-off scripts, so keep it
// free of top-level side effects.

// BEGIN SHARED
var BUS = "dev.shmakk.Windows";
var PATH = "/dev/shmakk/Windows";

function describe(w) {
  var g = w.frameGeometry;
  var desk = (w.desktops && w.desktops.length) ? w.desktops[0].id : "";
  return {
    id: String(w.internalId),
    app: String(w.resourceClass || w.resourceName || ""),
    title: String(w.caption || ""),
    pid: w.pid || 0,
    screen: w.output ? String(w.output.name) : "",
    desktop: String(desk),
    minimized: !!w.minimized,
    fullScreen: !!w.fullScreen,
    geo: { x: Math.round(g.x), y: Math.round(g.y), w: Math.round(g.width), h: Math.round(g.height) }
  };
}

function tracked(w) {
  return !!w && w.normalWindow && !w.skipTaskbar;
}

function send(payload) {
  payload.t = Date.now();
  callDBus(BUS, PATH, BUS, "Event", JSON.stringify(payload));
}

function onCurrentDesktop(w) {
  if (w.onAllDesktops) return true;
  var d = w.desktops;
  if (!d || !d.length) return true;
  for (var i = 0; i < d.length; i++) if (d[i].id === workspace.currentDesktop.id) return true;
  return false;
}

function areaOf(output) {
  var a = workspace.clientArea(KWin.MaximizeArea, output, workspace.currentDesktop);
  return { x: Math.round(a.x), y: Math.round(a.y), w: Math.round(a.width), h: Math.round(a.height) };
}

// Everything the daemon needs to plan a layout, read fresh from KWin.
function context() {
  var list = workspace.windowList();
  var wins = [];
  for (var i = 0; i < list.length; i++) {
    if (tracked(list[i]) && onCurrentDesktop(list[i])) wins.push(describe(list[i]));
  }
  var screens = [];
  for (var s = 0; s < workspace.screens.length; s++) {
    var o = workspace.screens[s];
    var a = areaOf(o);
    screens.push({ name: String(o.name), x: a.x, y: a.y, w: a.w, h: a.h });
  }
  var act = workspace.activeWindow;
  return {
    windows: wins,
    active: tracked(act) ? String(act.internalId) : null,
    screens: screens,
    activeScreen: workspace.activeScreen ? String(workspace.activeScreen.name) : "",
    desktop: String(workspace.currentDesktop.id)
  };
}

function sendCommand(name) {
  var c = context();
  c.kind = "command";
  c.command = name;
  send(c);
}

function fills(g, a) {
  return Math.abs(g.x - a.x) <= 2 && Math.abs(g.y - a.y) <= 2 &&
    Math.abs(g.width - a.w) <= 4 && Math.abs(g.height - a.h) <= 4;
}

// Swap every window on the active screen with every window on the next
// screen, keeping each window's position relative to its screen.
// Maximized and fullscreen windows stay maximized or fullscreen.
function swapScreens() {
  var screens = workspace.screens;
  if (!screens || screens.length < 2) {
    send({ kind: "command", command: "swap-screens", error: "only one screen" });
    return;
  }
  var act = workspace.activeWindow;
  var A = (tracked(act) && act.output) ? act.output : (workspace.activeScreen || screens[0]);
  var ai = 0;
  for (var i = 0; i < screens.length; i++) if (String(screens[i].name) === String(A.name)) ai = i;
  A = screens[ai];
  var B = screens[(ai + 1) % screens.length];
  var areaA = areaOf(A);
  var areaB = areaOf(B);

  var list = workspace.windowList();
  var moves = [];
  for (var n = 0; n < list.length; n++) {
    var w = list[n];
    if (!tracked(w) || !onCurrentDesktop(w) || !w.output) continue;
    var on = String(w.output.name);
    if (on === String(A.name)) moves.push({ w: w, from: areaA, to: B, toArea: areaB });
    else if (on === String(B.name)) moves.push({ w: w, from: areaB, to: A, toArea: areaA });
  }

  for (var m = 0; m < moves.length; m++) {
    var mv = moves[m];
    var g = mv.w.frameGeometry;
    var keep = mv.w.fullScreen || fills(g, mv.from);
    var rel = {
      x: (g.x - mv.from.x) / mv.from.w,
      y: (g.y - mv.from.y) / mv.from.h,
      w: g.width / mv.from.w,
      h: g.height / mv.from.h
    };
    workspace.sendClientToScreen(mv.w, mv.to);
    if (!keep) {
      var t = mv.toArea;
      var nw = Math.min(Math.round(rel.w * t.w), t.w);
      var nh = Math.min(Math.round(rel.h * t.h), t.h);
      mv.w.frameGeometry = {
        x: Math.min(Math.max(t.x + Math.round(rel.x * t.w), t.x), t.x + t.w - nw),
        y: Math.min(Math.max(t.y + Math.round(rel.y * t.h), t.y), t.y + t.h - nh),
        width: nw,
        height: nh
      };
    }
  }
  for (var r = 0; r < moves.length; r++) send({ kind: "geometry", window: describe(moves[r].w) });
  send({ kind: "command", command: "swap-screens", moved: moves.length, a: String(A.name), b: String(B.name) });
}
// END SHARED

function watch(w) {
  if (!tracked(w)) return;
  w.interactiveMoveResizeFinished.connect(function () { send({ kind: "geometry", window: describe(w) }); });
  w.minimizedChanged.connect(function () { send({ kind: "geometry", window: describe(w) }); });
  w.outputChanged.connect(function () { send({ kind: "geometry", window: describe(w) }); });
  w.fullScreenChanged.connect(function () {
    if (workspace.activeWindow === w) send({ kind: "focus", window: describe(w) });
  });
}

function snapshot() {
  var list = workspace.windowList();
  var out = [];
  for (var i = 0; i < list.length; i++) {
    if (tracked(list[i])) out.push(describe(list[i]));
  }
  var a = workspace.activeWindow;
  send({ kind: "snapshot", windows: out, active: tracked(a) ? String(a.internalId) : null });
}

var existing = workspace.windowList();
for (var i = 0; i < existing.length; i++) watch(existing[i]);

workspace.windowAdded.connect(function (w) {
  if (!tracked(w)) return;
  watch(w);
  send({ kind: "open", window: describe(w) });
});

workspace.windowRemoved.connect(function (w) {
  if (!tracked(w)) return;
  send({ kind: "close", window: { id: String(w.internalId) } });
});

workspace.windowActivated.connect(function (w) {
  send({ kind: "focus", window: tracked(w) ? describe(w) : null });
});

workspace.currentDesktopChanged.connect(function () {
  var a = workspace.activeWindow;
  send({ kind: "focus", window: tracked(a) ? describe(a) : null });
});

registerShortcut("shmakk-reorder", "shmakk: Reorder windows (press again for the next layout)",
  "Ctrl+Alt+;", function () { sendCommand("reorder"); });
registerShortcut("shmakk-swap-screens", "shmakk: Swap window layouts between screens",
  "Ctrl+Alt+'", function () { swapScreens(); });

snapshot();
