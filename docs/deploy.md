# Deploying shmakk (Docker)

This runs the web interface as a container on **port 1029**, intended to be reached at
**sh.makketing.com**. Ports 80/443 are left alone for whatever else the machine serves.

## 1. Start it

```bash
git clone https://github.com/marbad1994/shmakk && cd shmakk
cp .env.docker.example .env
#   SHMAKK_WEB_TOKEN   → openssl rand -base64 32
#   SHMAKK_BASE_URL / SHMAKK_API_KEY / SHMAKK_MODEL → your model provider
docker compose up -d --build
docker compose logs shmakk        # shows the sign-in link
```

Open the link once per device; the token is then kept in a cookie for 90 days.
Everything persistent — conversations, settings, the GitHub token, cloned repositories —
lives in the `shmakk-data` volume (`/data` in the container).

## 2. Put it behind your existing reverse proxy (recommended)

Port 1029 speaks plain HTTP. Since the token is effectively a password for a machine that
runs commands, serve it over HTTPS through the proxy that already owns 443, and stop
exposing 1029 publicly by changing the port mapping in `docker-compose.yml` to
`"127.0.0.1:1029:1029"`. HTTPS is also required for the microphone and for installing
the app on a phone.

**nginx**

```nginx
server {
    listen 443 ssl http2;
    server_name sh.makketing.com;
    # ssl_certificate / ssl_certificate_key … (e.g. certbot)

    client_max_body_size 50m;

    location / {
        proxy_pass http://127.0.0.1:1029;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header Upgrade $http_upgrade;       # WebSocket: live chat + terminal
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 1h;
        proxy_buffering off;
    }
}
```

**Caddy**

```
sh.makketing.com {
    reverse_proxy 127.0.0.1:1029
}
```

Keep `SHMAKK_TRUST_PROXY=1` and `SHMAKK_PUBLIC_URL=https://sh.makketing.com` in `.env`.

### Without a proxy

`http://sh.makketing.com:1029` works as-is (set `SHMAKK_TRUST_PROXY=0`). To get HTTPS on
1029 directly, mount a certificate into the volume and set `SHMAKK_TLS_CERT` /
`SHMAKK_TLS_KEY`; then `SHMAKK_PUBLIC_URL=https://sh.makketing.com:1029`.

## 3. Connect GitHub

In the app: **GitHub sessions → Connect**. Either

- paste a personal access token (`repo` scope, or fine-grained with *Contents* and
  *Pull requests* read/write), or
- set `SHMAKK_GITHUB_TOKEN` in `.env`, or
- set `SHMAKK_GITHUB_CLIENT_ID` (an OAuth app with device flow enabled) to get a
  "Sign in with GitHub" button.

Then pick a repository → **Start session**. shmakk clones it to
`/data/workspaces/<owner>/<repo>--<label>-<time>`, optionally on a new branch, and opens a
chat bound to that clone. The bar above the chat shows the branch and pending changes and
has **Commit & push** and **Open PR**. Deleting the session deletes its clone.

## Operations

```bash
docker compose logs -f shmakk                 # logs
docker compose pull && docker compose up -d --build   # update
docker compose exec shmakk shmakk --help      # the CLI is in the image too
docker run --rm -v shmakk_shmakk-data:/data -v "$PWD":/backup alpine tar czf /backup/shmakk-data.tgz -C /data .   # backup
```

Rotate the access token by changing `SHMAKK_WEB_TOKEN` and recreating the container.

## What the container can and cannot do

- Runs as the unprivileged `node` user, with all Linux capabilities dropped,
  `no-new-privileges`, a PID limit and a memory limit.
- The agent **can** run arbitrary commands and reach the network *inside* the container —
  that is its job. It cannot touch the host unless you mount host paths or the Docker
  socket into it; don't.
- The GitHub token is readable by processes in the container (git needs it to push). Use a
  fine-grained token limited to the repositories you want shmakk to work on.
- The image leaves out the multi-gigabyte local voice and browser-automation stacks; build
  with `--build-arg WITH_OPTIONAL=1` to include them. Voice otherwise uses the browser's
  own speech features.
