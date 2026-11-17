# Local + cloud nodes: session sync, moves, and remote sessions

Status: design proposal. Scope: single user (you). Backed by the current code in
`src/webui/*`, `src/ssh.js`, `web/src/*`, `docker-compose.yml`, and `Dockerfile`.

## 1. Goal

One shmakk installation on a laptop and one in the cloud (the Docker deploy at
`https://sh.makketing.com`) should behave like one workspace:

1. A session started in the cloud can be opened and driven from the desktop app,
   while the agent keeps running in the cloud.
2. A session can be moved or copied between the two machines, workspace files
   included, even mid-conversation.
3. A session can be marked "remote" so it runs on the laptop but is reachable and
   usable from the cloud web UI.

## 2. Concepts

- **Node**: one running shmakk process. Each node has a stable `nodeId`, a `label`,
  a `kind` (`local` or `cloud`), a reachable `url`, and an access `token`.
- **Owning node**: a session (conversation) lives in exactly one node's
  conversations store, and its agent loop runs in-process on that node.
- **Client**: any shmakk web UI, local or cloud, can be a client of a session on
  another node. A client reads the transcript and drives the conversation through
  the owning node's API and WebSocket.
- **Move vs copy**: move relocates a session (and, by default, its workspace) so
  the target becomes the owner; copy creates an independent duplicate.

## 3. What already exists

- Server, auth, and live updates live in `src/webui/server.js`. Every request
  needs the per-instance token (`shmakk_token` cookie or `Authorization: Bearer`).
  Live updates flow over a WebSocket at `/ws` with a 4 MB message cap.
- Session storage is `src/webui/store.js`: one JSON file per conversation under
  the node's state dir (`~/.local/state/shmakk/web/conversations`, or
  `/data/.local/state/shmakk/web/conversations` in the container because
  `HOME=/data`). `metaOf()` defines the metadata shown in lists.
- The agent loop is `src/webui/chat.js` (`ChatManager`). `send()` starts a run,
  `stop()` aborts it, `sendAndWait()` awaits completion, and `broadcast()` pushes
  `conv` / `item` / `delta` / `remove` / `run` events to every connected window.
- SSH primitives already exist in `src/ssh.js`: `loadHostConfig`, `sshRun`,
  `sshTransfer`, `saveHost`, `testHost`, `listHosts`. Hosts come from
  `~/.config/shmakk/hosts.json` and `.shmakk/hosts.json`.
- Frontend transport is `web/src/lib/api.ts` (same-origin `fetch`) and
  `web/src/lib/ws.ts` (auto-reconnecting WebSocket to `/ws`).
- Cloud deploy: `docker-compose.yml` + `Dockerfile`. The container runs as the
  unprivileged `node` user, `HOME=/data`, `SHMAKK_WORKSPACES_DIR=/data/workspaces`,
  and all persistent state lives in the `shmakk-data` volume.

## 4. Transport and topology

Three different directions need three different links.

### 4.1 Desktop reaches the cloud (capability 1)

The cloud node is already public over HTTPS. The desktop node acts as a proxy:
it holds the cloud URL and token server-side and forwards the browser's requests
to the cloud node. The browser keeps talking only to `127.0.0.1`, so there is no
CORS problem and the cloud token never reaches the browser.

- REST: a generic proxy route on the local node forwards to the cloud node's
  `/api/...` with `Authorization: Bearer <cloudToken>`.
- Live updates: the local node opens its own WebSocket to the cloud node's `/ws`
  and re-emits cloud events into the local `/ws` with a `node` tag.

### 4.2 Move / copy between nodes (capability 2)

Moves go through the owning node's HTTP API, not raw SCP. Reason: the cloud
node's data lives inside the Docker `shmakk-data` volume and the container runs
unprivileged, so files dropped on the host are not inside `/data`. Letting each
node import into its own store is the only robust path.

- Conversation metadata (small, structured): a JSON document.
- Workspace files (can be large): a streaming tar payload uploaded/downloaded over
  the same authenticated channel, so it is not held fully in memory.
- The target node's token authenticates the transfer (`Authorization: Bearer`).

### 4.3 Cloud reaches a "remote" session on the laptop (capability 3)

Chosen transport: SSH reverse tunnel (no ports opened on the laptop).

- The laptop opens an outbound tunnel to the cloud host:
  `ssh -N -R <bind>:<remotePort>:127.0.0.1:<localPort> <sshHostAlias>`.
- The cloud node dials `http://<bind>:<remotePort>` and proxies the remote
  session's API and WebSocket through the tunnel.
- Known wrinkle (validate in the spike): the shmakk process lives in a container,
  so `127.0.0.1` inside the container is not the host's loopback. The tunnel's
  remote side should bind to the Docker bridge gateway (for example
  `172.17.0.1`, or `0.0.0.0` as a fallback) so the container can reach it. The
  gateway address is a cloud-side setting, and the token is the only credential
  on that hop.

## 5. Session identity and metadata

Conversation IDs are currently `c_<base36 ts>_<hex>` from `store.js`. Extend the
conversation metadata (`metaOf`) and JSON with:

- `node`: the stable `nodeId` of the owning node.
- `remote`: true when a session is a local session exposed to the cloud.
- `origin`: optional `{ node, id }` for moved/copied sessions.

Move keeps the conversation id (it is the same logical session) and remaps only on
a collision. Copy always mints a new id and records `origin`.

## 6. The three capabilities in detail

### 6.1 Reach a cloud session from the desktop

1. In Settings, the user configures the cloud node: `url`, `token`, `label`,
   `enabled`. The token is the same one the browser cookie holds on
   `sh.makketing.com`.
2. The sidebar gains a node switcher: "This computer" and the cloud label.
   Selecting the cloud node lists that node's conversations through the proxy.
3. Opening a cloud session loads its transcript and drives it through the same
   proxy. All workspace-scoped operations (file browsing, terminal, edits) for
   that conversation route to the cloud node, because its `workspace` path only
   makes sense there.
4. Live updates for the open cloud session arrive on the local `/ws` with a
   `node` tag; the store applies them to the right conversation.

### 6.2 Move / copy a session, workspace included

A session bundle is: `conversation.json` plus a tar of the workspace directory
(relative paths), including `.shmakk/` state (memory, mcp.json, journal).

- Local to cloud: the local node uploads the bundle to the cloud node's import
  endpoint.
- Cloud to local: the local node downloads the bundle from the cloud node's
  export endpoint and imports it locally.
- `transfer` setting chooses copy (default) or move. Move deletes the source
  after a confirmed successful import (with a small safety delay or an explicit
  confirmation for large workspaces).

**Mid-conversation (running session):**

A "running" session is a conversation whose agent run is active (an LLM or tool
step in flight). A running process cannot be teleported, so the design is
pause, transfer, resume:

1. Add a `pause` primitive to `ChatManager` that stops the run at the next safe
   step boundary (between tool calls, not mid-tool), persists the transcript and
   LLM `history`, and marks items `paused` rather than `interrupted`. Store a
   `resume` marker (the pending prompt) on the conversation.
2. The bundle is exported from the paused state (no live `run` in the JSON).
3. On import, the target node settles items and offers "Resume", which re-enters
   `send()` with the stored marker so the agent continues from the persisted
   transcript and history.

Idle sessions skip step 1 and 3. The exact resume protocol is finalized in the
move task, reusing `sendAndWait` semantics for the continuation.

### 6.3 Remote sessions: run local, reachable from cloud

1. In Settings the user points the cloud connection at an SSH host alias and a
   remote port (reusing `~/.config/shmakk/hosts.json`).
2. A per-session "Expose to cloud" toggle on the local node:
   - Ensures the SSH reverse tunnel is up (auto-connect, keepalive, reconnect).
   - Registers the session with the cloud node: `POST /api/remote/register` with
     `{ sessionId, nodeId, token }`, authenticated with the cloud token.
3. The cloud node stores a registry mapping `sessionId` to
   `{ nodeId, endpoint, token }`. In the cloud web UI the session shows a
   "remote" badge; opening it proxies API and WebSocket to
   `http://<bind>:<remotePort>` through the tunnel, authenticated with the local
   token.
4. Toggling off deregisters the session and (when no remote sessions remain)
   tears down the tunnel.

One tunnel serves all remote sessions on that laptop: the local node exposes its
whole API on one port, and the cloud routes specific session ids to it.

## 7. Settings

Local node (`~/.config/shmakk/web.json`, mode 0600, extended in
`src/webui/store.js`):

```json
{
  "cloud": {
    "enabled": true,
    "url": "https://sh.makketing.com",
    "token": "the cloud access token",
    "label": "sh.makketing.com",
    "sshHost": "edge",
    "remotePort": 4291
  },
  "transfer": "copy"
}
```

- `transfer` is `"copy"` (default) or `"move"`.
- `sshHost` is an alias from `hosts.json`; the laptop's own port is its existing
  listen port.

Cloud node (env or settings): the gateway address for reaching tunneled endpoints,
for example `SHMAKK_REMOTE_GATEWAY=http://172.17.0.1` plus the remote registry
persisted under its `/data` state dir.

## 8. API additions

- `GET /api/nodes`: local node plus configured cloud node, with health/status.
- `ANY /api/node/:node/<rest>`: generic authenticated proxy to another node.
- `GET /api/nodes/:node/conversations`: list remote conversations.
- `POST /api/nodes/:node/export` / `POST /api/nodes/:node/import`: session bundles.
- `POST /api/remote/register` / `POST /api/remote/unregister`: remote registry.
- Existing `/api/conversations*` and workspace/terminal routes gain an optional
  node routing parameter, or the proxy prefix above is used uniformly.

The server keeps the current single-origin model: the browser only ever calls the
local node; node-to-node traffic is server-side and Bearer-authenticated.

## 9. Security

- Single user, so no per-user isolation is required, but every node-to-node hop is
  authenticated with the target node's token via `safeEqual`, same as today.
- The cloud token stays in settings (0600) and is never exposed to the browser.
- The reverse tunnel binds to the Docker bridge gateway (not the public
  interface) where possible; the local token is the only credential on that hop.
- Import validates the bundle: conversation ids and workspace paths are checked
  before anything is written, and workspace tar entries are sanitized against
  path traversal.

## 10. Risks and unknowns

- Docker bridge gateway vs host loopback for the reverse tunnel (spike first).
- Resume-after-pause fidelity for a run that is mid-tool when paused; worst case
  a paused tool is re-run once on resume, which is acceptable.
- Large workspaces: streaming tar and a progress indicator, not a blocking copy.
- WebSocket relay backpressure and the 4 MB message cap when proxying live output.

## 11. Plan

Phased breakdown with concrete tasks lives in `TASKS.md` under
"Local + cloud session sync".
