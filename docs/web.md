# shmakk web & desktop interface

```bash
shmakk --web                      # browser, http://127.0.0.1:4317
shmakk --web --host 0.0.0.0       # also reachable from your phone (prints a "phone" link)
shmakk --desktop                  # Electron app (one-time: cd desktop && npm install)
```

All the usual launch flags apply: `--workspace`, `--profile`, `--review`, `--yes-files`,
`--no-correction`, `--no-ai`, `--debug`, `--endpoint`.

## CLI → interface map

| CLI | In the interface |
|-----|------------------|
| typing a command | **shell** mode in the composer, or prefix with `$ ` |
| typo correction | automatic for safe fixes; a "Did you mean…" card otherwise |
| natural-language task | **ask** mode (default) |
| `--review` | `review` chip · status bar · Settings → Behaviour · `/review` |
| `--yes-files` | `yes-files` chip · "Always allow file edits" on an approval card |
| `--no-correction`, `--no-ai`, `--debug` | Settings → Behaviour |
| `--profile`, `--profile-set` | profile chip in the composer · `/profile deep` |
| `--endpoint`, `set model …`, `set url …`, `set api key …` | Settings → Model provider · `/model`, `/endpoint` |
| `--list-skills`, `--load-skill`, `--unload-skill`, `--install-skill`, `--skill-status`, `-G` | **Skills** page · `/load-skill` … |
| `show memory`, `forget …`, `show rules` | **Memory** page · `/remember`, `/forget` |
| `--show-plan`, `--resume-status` | **Plan** page; plans also render live in the chat |
| `+task` / `!task` (force / skip planning) | same prefixes, or `/plan-first` |
| `review edits` | **Changes** page — diffs with per-edit revert |
| `recall …`, `find session …`, `last sessions` | **Recall** page · `/recall` |
| `list workflows`, `list agents` | **Team** page |
| `--mcp-status` | **MCP** page (edit config, restart servers) |
| `--stats`, `--status`, audit log | **Activity** page · `/stats` |
| `--reset`, `--compact` | eraser button in the title bar · `/reset` |
| `--restart` | close and reopen a terminal tab |
| `--exit` | Settings → About → Quit · `/exit` |
| `--workspace` | workspace switcher (bottom of the sidebar) · `/workspace` |
| `--update-command-glossary`, `--build-history`, `--completion`, `--print-config`, `--help` | Settings → Maintenance |
| `--stt` / `--voice` | mic button |
| `--tts` | speaker button · Settings → Voice |
| `--sts` | Settings → Voice → Hands-free conversation |
| `--tts-voice`, `--voice-language` | Settings → Voice |
| browser tool, MCP tools, web search | used by the agent exactly as in the CLI |
| anything else | the **terminal** dock runs the real `shmakk` CLI (`Ctrl+\``) |

Any natural-language self-command (`list skills`, `show config`, `use endpoint x`, …) also works
typed straight into the chat.

## Keyboard

`Enter` send · `Shift+Enter` newline · `/` commands · `$ ` shell · `↑` recall input · `Esc` stop ·
`Y` / `N` answer an approval · `Ctrl/⌘ K` palette · `Ctrl/⌘ N` new chat · `Ctrl/⌘ B` sidebar ·
`` Ctrl+` `` terminal · `Ctrl/⌘ ,` settings

## On a phone

Start with `--host 0.0.0.0`, open the printed link on the same network, then "Add to Home Screen".
The token is remembered on the device (and kept across restarts; `--new-token` rotates it).
Anyone with the link can run commands on your machine — only do this on a network you trust, or
put it behind a VPN/tunnel with TLS. Microphone access needs HTTPS or localhost.

## Security model

- Loopback-only by default; token required on every HTTP request and WebSocket upgrade
- Token travels once in the URL, then lives in an `HttpOnly; SameSite=Strict` cookie
- Cross-origin requests are refused; strict CSP; no third-party assets or network calls
- Tool safety is identical to the CLI: workspace confinement, secret-path checks, the same
  danger patterns, the same audit log (`~/.local/state/shmakk/audit.log`)

## Development

```
web/                 React 19 + TypeScript + Vite + Tailwind 4
  src/components/ui  Radix UI primitives styled as local components (shadcn pattern), cmdk palette
  src/components/…   chat (transcript, composer), layout (sidebar, dock, status bar, mobile nav)
  src/views          one file per page, data via TanStack Query
  src/store          live state (Zustand) fed by the WebSocket
src/webui/           server.js (HTTP/WS, auth) · api.js (REST) · chat.js (engine) · terminal.js · store.js
desktop/             Electron main + preload
```

```bash
SHMAKK_WEB_TOKEN=dev shmakk --web --no-open      # backend on :4317
SHMAKK_WEB_TOKEN=dev npm run dev:web             # Vite on :5173 with hot reload
npm run build:web                                # → src/webui/public (git-ignored, built on `npm pack`)
npm test && npm run test:web
```
