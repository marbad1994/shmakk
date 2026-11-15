# shmakk MCP

shmakk can connect to Model Context Protocol servers over stdio and expose their tools to the agent.

## Configuration

Config files are loaded from:

1. `.shmakk/mcp.json` in the workspace
2. `~/.config/shmakk/mcp.json` globally

Example:

```json
{
  "mcpServers": {
    "browser": {
      "command": "npx",
      "args": ["-y", "@example/mcp-server-browser"],
      "env": {
        "BROWSER_TOKEN": "${BROWSER_TOKEN}"
      },
      "safety": "uncertain",
      "safeTools": ["read_page", "screenshot"],
      "unsafeTools": ["delete_cookies"],
      "timeout": 30000,
      "disabled": false
    }
  }
}
```

Fields:

| Field | Purpose |
|-------|---------|
| `command` | Executable to spawn |
| `args` | Command arguments |
| `env` | Extra environment variables; `${NAME}` is interpolated from the current environment |
| `safety` | Default safety classification for tools: `safe`, `uncertain`, or `unsafe` |
| `safeTools` | Tool names that are always considered safe |
| `unsafeTools` | Tool names that always require confirmation |
| `timeout` | Tool-call timeout in milliseconds |
| `disabled` | Skip this server when true |

## Status

From outside a session:

```bash
shmakk --mcp-status
```

From inside a session:

```text
mcp status
```

## Tool behavior

MCP servers start when a shmakk session starts. shmakk performs the MCP initialize handshake, discovers tools with `tools/list`, and calls tools with `tools/call`.

Text content is returned to the agent directly. Image content is preserved as base64 with a size cap so vision-capable providers can use it without blowing out context.

MCP tools go through the same review/safety flow as built-in tools. Use `safeTools` and `unsafeTools` when a server's default safety level is too broad.

## Browser automation

shmakk also has built-in browser automation tools. If your setup uses Playwright, install it separately:

```bash
npm install playwright
npx playwright install chromium
```

Browser commands include navigation, clicking, typing, page reading, screenshots, evaluating JavaScript, selecting, waiting, scrolling, and closing.

