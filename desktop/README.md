# shmakk desktop

The shmakk web interface in a native window (Electron). Same UI, same engine —
plus native menus, a native folder picker, window-state memory and no browser tab.

```bash
npm run build:web        # in the repo root, once
cd desktop && npm install
npm start                # or, from anywhere: shmakk --desktop
```

`shmakk --desktop --workspace ~/code/project` opens straight into a project.

## Packaging

```bash
cd desktop && npm run dist   # → desktop/dist (dmg / AppImage / deb / nsis)
```

## How it works

`main.js` starts the shmakk server (`src/webui/server.js`) in-process on a random
loopback port with a one-off token and points a sandboxed, context-isolated
window at it. `preload.js` exposes a four-function bridge (`pickFolder`,
`openExternal`, `onMenu`, platform info) — the page has no Node access.

The integrated terminal uses `node-pty`. It is an N-API module, so the copy
built for Node normally loads under Electron as-is; if the terminal tab reports
it is unavailable, run `npx @electron/rebuild -m ..` inside `desktop/`.
