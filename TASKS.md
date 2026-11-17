# Tasks

## shmakk plans

## Local + cloud session sync

Spec: `docs/local-cloud.md`. Single user. Transport: HTTPS proxy for
cloud-to-desktop and moves, SSH reverse tunnel for remote (local) sessions.

### Phase 0: spike, validate the reverse tunnel

- [ ] Confirm the cloud host SSH alias in `~/.config/shmakk/hosts.json`
- [ ] Establish a reverse tunnel from laptop to cloud host and verify the shmakk
      container can reach it via the Docker bridge gateway
- [ ] Record the working `ssh -N -R` bind address and container gateway in the spec

### Phase 1: node identity and settings

- [x] Add a stable `nodeId` to each instance (persisted in settings)
- [x] Extend `DEFAULT_SETTINGS` in `src/webui/store.js` with `cloud` and `transfer`
- [x] Keep `cloud.token` out of `publicSettings()` in `src/webui/api.js`
- [x] Extend the `PATCH /api/settings` route to accept the new fields
- [x] Add Settings UI: cloud url, token, label, enabled, sshHost, remotePort, and
      the copy/move toggle (copy default)

### Phase 2: server-side node proxy (reach cloud locally)

- [x] Generic authenticated proxy route `ANY /api/node/:node/<rest>` in the server
- [x] Server-side WebSocket client to the cloud node, re-emitting events into
      local `/ws` with a `node` tag
- [x] `GET /api/nodes` with per-node health/status
- [x] List cloud conversations through the proxy

### Phase 3: frontend node switcher and remote-session routing

- [x] Sidebar node switcher (This computer / cloud label)
- [x] Owning-node badge on each conversation
- [x] Route a remote conversation's API and WebSocket traffic through the node layer
- [x] Guard against treating a cloud `workspace` path as local

### Phase 4: move / copy sessions

- [x] Define the session bundle format (`conversation.json` + workspace tar)
- [x] Add `pause` primitive to `ChatManager` in `src/webui/chat.js`
      (stop at a step boundary, persist `paused` items + a `resume` marker)
- [x] Export/import helpers in the server, with path-traversal-safe tar handling
- [x] Streaming tar upload/download over the authenticated channel
- [x] Move/copy endpoints in both directions; move deletes source after confirmed import
- [x] Per-session Move/Copy menu honoring the `transfer` setting (copy default)

### Phase 5: remote sessions (run local, reachable from cloud)

- [x] SSH reverse tunnel manager (auto-connect, keepalive, reconnect) reusing
      `src/ssh.js`
- [x] Remote registry on the cloud node (`sessionId` to `nodeId` + endpoint + token)
- [x] `POST /api/remote/register` and `unregister` endpoints
- [x] Cloud node proxies remote sessions through the tunnel
- [x] Frontend "Expose to cloud" toggle with tunnel status

### Phase 6: hardening

- [x] Bearer auth between nodes using `safeEqual`, matching `src/webui/server.js`
- [x] Origin and CSRF review for the proxy route
- [ ] Resume-after-pause behavior test (mid-conversation move)
- [x] Tests for bundle export/import round-trip and tar traversal rejection
