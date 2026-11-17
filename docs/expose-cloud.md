# Exposing a local session to the cloud

"Expose to cloud" lets a session that runs on the desktop be opened and driven
from the cloud web UI (`https://sh.makketing.com`). The connection is an SSH
reverse tunnel: the desktop dials *out* to the cloud host, so nothing needs to
be opened on the desktop and no port is forwarded through a router.

## Direction

```
desktop (ssh client) ── outbound ──▶ cloud host (sshd)
        -R 0.0.0.0:<remotePort>:127.0.0.1:<desktopPort>
```

The desktop runs `ssh -N -R ...` and asks the cloud host's sshd to listen on
`remotePort`. The cloud *container* then dials `172.17.0.1:<remotePort>` (the
Docker bridge gateway, which is the host from inside the container), and that is
forwarded back through the tunnel to the desktop.

Two consequences worth stating up front:

- **No SSH in docker-compose.** The container never runs sshd; the tunnel
  terminates on the cloud *host* (the VM running Docker), which already runs
  sshd for deploys.
- **No public port is opened.** `remotePort` is only reached over the local
  Docker bridge, not the internet.

## Prerequisites

- Key-based SSH from the desktop to the cloud host must already work
  (`ssh <alias>` succeeds without a password). The tunnel runs `BatchMode=yes`,
  so there is no password prompt.

## 1. Cloud host (one-time sshd setting)

On the cloud host, edit `/etc/ssh/sshd_config`:

```sshconfig
AllowTcpForwarding yes
GatewayPorts yes
```

`GatewayPorts yes` is the part that bites. By default sshd forces `-R` listens
to loopback only, but the cloud *container* reaches the forwarded port through
`172.17.0.1:<remotePort>`, so the listen must bind `0.0.0.0`. Then:

```bash
sudo systemctl restart sshd
```

Pick a free port on the cloud host, e.g. `22022`. It does not need to be opened
in any external firewall; the container reaches it over the Docker bridge.

## 2. Desktop settings

In **Settings → Cloud node**:

| Field | Value |
|-------|-------|
| URL | `https://sh.makketing.com` |
| Access token | the cloud node's `SHMAKK_WEB_TOKEN` |
| SSH host | an alias from `~/.config/shmakk/hosts.json` (or `user@host`) pointing at the cloud host |
| Remote port | the free port from step 1, e.g. `22022` |
| Bind address | `0.0.0.0` (default) |

The SSH host is resolved the same way as the `ssh_run` tools: an alias in
`~/.config/shmakk/hosts.json`, or a bare `user@host` string.

## 3. Expose a session

With the cloud connection saved, hover a conversation row and choose
**Expose to cloud**. The desktop:

1. brings the reverse tunnel up (auto-reconnect + keepalive),
2. registers the session with the cloud node over HTTPS
   (`POST /api/remote/register`).

The session then shows in the cloud UI with a "remote" badge. **Stop exposing**
deregisters it and tears the tunnel down once no sessions remain.

## Docker bridge gateway

The cloud container reaches the tunneled port through the Docker bridge gateway,
which defaults to `http://172.17.0.1`. That is correct for the default bridge
network used by `docker-compose.yml`. If the deployment uses a custom network
or rootless Docker, set the gateway explicitly in the cloud's `.env`:

```dotenv
SHMAKK_REMOTE_GATEWAY=http://172.17.0.1
```

## Troubleshooting

| Symptom | Likely cause |
|---------|--------------|
| "reverse tunnel not configured" | `SSH host` and `Remote port` are empty in Cloud settings |
| "Expose to cloud" is greyed out | cloud node not configured, or no SSH host / remote port |
| Tunnel up but the cloud can't reach the session | `GatewayPorts yes` missing on the host sshd, or `remotePort` already in use |
| ssh exits immediately | key auth broken, or the `SSH host` alias doesn't resolve in `hosts.json` |
