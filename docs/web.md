# shmakk web & desktop interface

```bash
shmakk --web                      # browser, http://127.0.0.1:4317
shmakk --web --host 0.0.0.0       # also reachable from your phone (prints a "phone" link)
shmakk --desktop                  # Electron app (one-time: cd desktop && npm install)
```

All the usual launch flags apply: `--workspace`, `--profile`, `--review`, `--yes-files`,
`--no-correction`, `--no-ai`, `--debug`, `--endpoint`.

## The four modes

The switcher at the top of the sidebar moves between four separate spaces. Each keeps its own
list of chats and only shows the tools that make sense there.

| Mode | What it is | What the assistant can do |
|------|------------|---------------------------|
| **Chat** | A plain conversation | Talk, write and reason; search the web and read pages. No files, no shell. |
| **Code** | The agent in your workspace (everything the CLI does) | Read, edit, run commands, GitHub sessions, terminal, skills, plans, teams |
| **Design** | Build interfaces with a live preview | Writes self-contained HTML/CSS into the chat's own folder; preview, device sizes, version history with restore, view/copy code |
| **Cowork** | Hand work off | Everything Code can do, plus create and manage **automations** from the conversation |

Design previews are served from a signed `/artifact/…` URL into a sandboxed frame: the page can
run its own scripts and load fonts and images, but it has an opaque origin and cannot reach
shmakk's cookies, storage or API.

### Automations (Cowork)

An automation is a list of steps (each a self-contained instruction) plus a trigger:

- **On a schedule** — every few minutes, hourly, daily, weekdays, chosen days, monthly, or a raw
  5-field cron expression, in a time zone you pick
- **When called** — a private webhook URL; `POST` to it and the body is handed to the first step
- **By hand** — only when you press *Run now*

Each run becomes its own Cowork chat (listed under *Automation runs*), so you can read what
happened and continue from there. Because nobody is watching, each automation states what it
may do unattended: safe actions and file edits (default — risky actions are skipped and noted),
ask first (the run waits up to an hour for your answer), or everything.

You can build one in **Cowork → Automations**, or just ask in a Cowork chat ("every weekday at 9,
summarise yesterday's commits"); the assistant asks permission before saving it. Runs missed while
the server was stopped are not replayed. In Docker, schedules use the time zone stored on each
automation, not the container's.

## Projects

A project groups chats from **any** mode — design a page, build it in Code, automate its upkeep in
Cowork — and gives them:

- **Instructions** that every chat in the project always follows
- An optional **workspace folder** its Code and Cowork chats start in
- One switch, **Share context between chats**:
  - **On** — each chat is given a digest of the project's other chats (what was asked, the latest
    answer) and Code/Cowork chats can read the files made by its Design chats
  - **Off** — chats only know the project's name and instructions; nothing crosses between them

Create a project from the sidebar, start chats from its page, or move an existing chat in from the
chat's menu. Deleting a project keeps its chats.

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
src/webui/           server.js (HTTP/WS, auth) · api.js (REST) · chat.js (engine, all four modes) · terminal.js · store.js
                     projects.js · design.js (artifacts, versions) · automations.js (cron, scheduler, webhooks) · github.js
desktop/             Electron main + preload
```

```bash
SHMAKK_WEB_TOKEN=dev shmakk --web --no-open      # backend on :4317
SHMAKK_WEB_TOKEN=dev npm run dev:web             # Vite on :5173 with hot reload
npm run build:web                                # → src/webui/public (git-ignored, built on `npm pack`)
npm test && npm run test:web
```
