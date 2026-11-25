# Window awareness (KDE Plasma)

shmakk can see which desktop windows are open, record how long you focus each
app, predict which app you switch to next, and arrange windows. It works on
KDE Plasma 6 (Wayland or X11) through KWin, because on Wayland only the
compositor knows about other applications' windows.

## How it fits together

| Piece | Where | Job |
| --- | --- | --- |
| Watcher | `kwin/shmakk-watch` | KWin script; sends focus, open, close and geometry events over D-Bus |
| Daemon | `shmakk windows-daemon` | Owns `dev.shmakk.Windows`, writes events to `~/.config/shmakk/windows.db` |
| Store, predictor, layout | `src/services/windows.js` | SQLite tables, Markov next-app model, one-off KWin layout scripts |
| Proactive engine | `src/services/windows-proactive.js` | Suggests or applies layouts when a prediction is confident |
| Reorder engine | `src/services/windows-reorder.js` | Ranks windows, builds and cycles layouts for `Ctrl+Alt+;` |
| Screens | `src/services/windows-screens.js` | Connected outputs, priority order (main screen first), portrait detection |
| Pairs | `src/services/windows-pairs.js` | Which apps you use together, from alternating focus |
| Agent tools | `src/tools.js` | `window_list`, `window_usage`, `window_predict`, `window_layout`, `window_proactive`, `window_reorder`, `window_screens`, `window_pairs` |

Placing windows does not need the daemon: `window_layout` loads a short KWin
script through `org.kde.KWin /Scripting`, runs it and unloads it.

## Setup

```
npm install better-sqlite3 dbus-next
shmakk windows-daemon --install-kwin
shmakk windows-daemon
```

`--install-kwin` runs `kpackagetool6`, enables the script in `kwinrc` and asks
KWin to reload. Check it with:

```
shmakk windows-daemon --status
```

To run the daemon at login, create `~/.config/systemd/user/shmakk-windows.service`
with `vi` and adjust `ExecStart` to wherever `which shmakk` points:

```
[Unit]
Description=shmakk window awareness
PartOf=graphical-session.target
After=graphical-session.target

[Service]
ExecStart=/usr/bin/shmakk windows-daemon
Restart=on-failure

[Install]
WantedBy=graphical-session.target
```

```
systemctl --user daemon-reload
systemctl --user enable --now shmakk-windows
```

## Tools

- `window_list`: open windows with id, app class, screen, desktop, geometry,
  minimized state and the active window. Reports `stale: true` when the daemon
  is not running.
- `window_usage`: focused minutes per app over `1h`, `today`, `24h`, `7d`,
  `30d` or `90d`. Focus blips under one second are ignored.
- `window_predict`: most likely next apps after the active one (or `app`).
  Transitions are weighted by recency (14 day half-life) and blended across
  time of day, per app, and overall frequency. `evidence` is the weighted count
  of transitions seen from the current app; low values mean a guess.
- `window_layout`: placements by window `id` or `app` class, with `x`, `y`,
  `w`, `h` as fractions of the screen work area (panels excluded) or pixels
  with `unit: "px"`. `screen` moves a window to another output, `focus`
  activates it, `minimizeOthers` minimizes everything else on the current
  desktop. Example, editor left two thirds and terminal right third:

```
{ "placements": [
  { "app": "org.kde.kate", "x": 0, "y": 0, "w": 0.667, "h": 1, "focus": true },
  { "app": "org.kde.konsole", "x": 0.667, "y": 0, "w": 0.333, "h": 1 }
] }
```

## Shortcuts

The watcher registers two global shortcuts. Rebind them in System Settings >
Keyboard > Shortcuts > KWin (search for "shmakk"). A default is only applied
the first time a shortcut is registered; after that KDE keeps your binding.

| Shortcut | Action |
| --- | --- |
| `Ctrl+Alt+;` | Reorder: arrange the windows you are working with into the best fitting layout. Press again within 90 seconds for the next layout, as often as you like; it wraps around. |
| `Ctrl+Alt+'` | Swap screens: every window on the active screen moves to the next screen and the other way round, keeping its relative position and size. Maximized and fullscreen windows stay that way. |

Swap runs entirely inside KWin and works without the daemon. Reorder needs
the daemon, because that is where your focus history lives.

How reorder picks a layout:

1. Rank the windows on the current desktop: the active window first, then
   by focus time in the last hour (recent minutes count more), plus a bonus
   for the app the predictor expects next and for apps you use together with
   the active one. Fullscreen windows are left alone.
2. Decide how many windows matter (1 to 4): the active one plus every
   window with at least a quarter of the top score.
3. Lift the active window's strongest companion to second place, so a pair
   you alternate between lands in the same layout instead of being split by
   a window that merely had more focus time an hour ago.
4. Build candidates. One screen: Focus, Main and side (60/40), Halves, Main
   and stack, Three columns, Grid. Two screens, your main screen first, then
   the next one in your priority order: One per screen, Split here one there,
   One here split there, Split on both, then the single-screen layouts on the
   main screen. Portrait screens get the layouts rotated (rows instead of
   columns).
5. Order them by fit to the count from step 2, then by what you kept before,
   and apply the first one that is not already on screen.

Screens have a priority order: the first screen is the main one and holds
the window you are working in, even when you trigger a reorder while on
another screen. Without a stored order the active screen stays first, which
is what older versions did.

```
# in a shmakk session
set HDMI-A-1 as my main screen
which screen is my main one
```

The agent reads and writes that order with `window_screens`; it also mirrors
it into KScreen, so Plasma and KWin agree. The order lives in
`~/.config/shmakk/screens.json`.

Pairs (`window_pairs`) answer a different question than the predictor: not
what you open next, but what you use *at the same time*. It weighs
alternations between two apps over the last 45 days and reports the mutual
share of attention, so an app you keep open all day does not look like a
companion. Reorder uses it for the ranking bonus and to pick the window that
goes next to yours.

Learning: pressing again within 90 seconds counts as "not this one" for the
layout you skipped. A layout you leave in place for 90 seconds counts as
kept. Scores are stored per set of apps (for example Kate + Konsole on one
screen) and per window count, so the first pick gets better over time.

A short notification shows the layout name and its position in the list.

Without the keyboard:

```
shmakk windows-daemon --reorder
shmakk windows-daemon --swap-screens
```

or ask in a shmakk session ("rearrange my windows", "swap my screens"),
which calls the `window_reorder` tool.

After updating, rerun `shmakk windows-daemon --install-kwin` so KWin loads
watcher 0.3.0 with the shortcuts.

## Proactive suggestions

The daemon watches for moments when it is confident about your next app.
Once you have stayed in a window for 30 seconds, it asks the predictor what
comes next. It acts only when all of these hold:

- the prediction is at least 60% likely and based on enough history
  (`evidence` 5 or more)
- that app has an open window that is not already visible next to yours
- the current window is not fullscreen and Do Not Disturb is off
- no suggestion in the last 2 minutes, and none for the same pair in 15

What it does depends on the mode:

| Mode | Behavior |
| --- | --- |
| `suggest` (default) | Notification with **Side by side** (current window left, predicted right, focus moves to it) and **Switch** (just focus it) |
| `auto` | At 80% or more, arranges both windows side by side right away and shows a notification with **Undo**. Below 80% it suggests instead |
| `off` | Nothing |

If you dismiss (or undo) the same pair three times in a row, that pair is
muted. Unmute with the `window_proactive` tool (`unmute: true`).

Set the mode at start, or ask the agent to change it while running:

```
shmakk windows-daemon --proactive auto
```

"stop suggesting windows" in a shmakk session calls `window_proactive` with
`mode: off`. The mode is stored, so it survives daemon restarts.
`shmakk windows-daemon --status` shows the mode, the last 7 days of outcomes
and muted pairs.

After updating shmakk, rerun `shmakk windows-daemon --install-kwin` so KWin
loads the current watcher (it reports fullscreen state since 0.2.0).

## Privacy

Proactive suggestions run entirely locally; no model is called. Window titles (email subjects, URLs, document names) are stored locally but
are not sent to the model. Set `SHMAKK_WINDOWS_TITLES=1` to include them in
tool output. Spans older than 90 days are pruned.

## Environment

| Variable | Default | |
| --- | --- | --- |
| `SHMAKK_WINDOWS_DB` | `~/.config/shmakk/windows.db` | Store location |
| `SHMAKK_WINDOWS_TITLES` | off | `1` sends window titles to the model |
| `SHMAKK_WINDOWS_STRICT` | off | `1` asks before every `window_layout` |
| `SHMAKK_WINDOWS_PROACTIVE` | `suggest` | Default mode when none is stored: `off`, `suggest`, `auto` |
| `SHMAKK_WINDOWS_DWELL_SEC` | `30` | Seconds in a window before a check |
| `SHMAKK_WINDOWS_MIN_P` | `0.6` | Minimum probability to suggest |
| `SHMAKK_WINDOWS_AUTO_P` | `0.8` | Minimum probability to arrange in auto mode |
| `SHMAKK_WINDOWS_MIN_EVIDENCE` | `5` | Minimum weighted transitions observed |
| `SHMAKK_WINDOWS_COOLDOWN_SEC` | `120` | Minimum gap between any two suggestions |
| `SHMAKK_WINDOWS_SPLIT` | `0.6` | Width share of the current window in a split (0.3 to 0.7) |

## Limits

- KDE Plasma 6 only. Other compositors need their own watcher.
- App classes are what KWin reports as `resourceClass`, for example
  `org.kde.konsole` or `firefox`. Use `window_list` to see the exact names.
- Layout scripts run asynchronously in KWin; the tool waits 300 ms and
  returns the geometry the daemon recorded, which is the real result only
  while the daemon is running.
