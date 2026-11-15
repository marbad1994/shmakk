# shmakk SSH

shmakk can run commands and transfer files on configured remote hosts. SSH tools are available to the agent as:

| Tool | Purpose |
|------|---------|
| `ssh_run` | Run a shell command on a remote host |
| `ssh_push` | Copy a local workspace file to a remote path |
| `ssh_pull` | Copy a remote file into the local workspace |

## Configuration

Hosts are loaded from:

1. `.shmakk/hosts.json` in the workspace
2. `~/.config/shmakk/hosts.json` globally

Example:

```json
{
  "hosts": {
    "devbox": {
      "host": "marcus@192.168.1.100",
      "port": 22,
      "auto_approve": false,
      "timeout_sec": 30
    },
    "staging": {
      "host": "deploy@10.0.0.5",
      "port": 2247
    }
  },
  "allow_ssh_config": false,
  "default_timeout_sec": 30
}
```

Fields:

| Field | Purpose |
|-------|---------|
| `host` | SSH target, usually `user@host` |
| `port` | SSH port, default `22` |
| `auto_approve` | Allow the agent to use this host with fewer confirmations when safety allows |
| `timeout_sec` | Per-host command timeout |
| `allow_ssh_config` | Also import host aliases from `~/.ssh/config` |
| `default_timeout_sec` | Default timeout for hosts without `timeout_sec` |

## SSH config import

If `allow_ssh_config` is true, shmakk reads `~/.ssh/config` and imports simple `Host`, `HostName`, `Port`, and `User` entries as named targets. Wildcard `Host *` entries are ignored as targets.

## Authentication

SSH key authentication via your normal `~/.ssh` setup is assumed. Commands use non-interactive options:

```text
BatchMode=yes
StrictHostKeyChecking=accept-new
ConnectTimeout=10
```

For persistent connections, add this to `~/.ssh/config`:

```sshconfig
Host *
  ControlMaster auto
  ControlPath ~/.ssh/controlmasters/%r@%h:%p
  ControlPersist 600
```

Then create the control socket directory once:

```bash
mkdir -p ~/.ssh/controlmasters
```

## Safety

Remote commands are still proposed through the agent tool system. Review mode and unsafe-command confirmations continue to apply.

