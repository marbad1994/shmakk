// MCP (Model Context Protocol) client for connecting to external tool servers.
// Implements JSON-RPC 2.0 over stdio transport.
//
// Configuration lives in:
//   ~/.config/shmakk/mcp.json   (global)
//   .shmakk/mcp.json            (workspace, overrides global)
//
// Format:
//   {
//     "mcpServers": {
//       "browser": {
//         "command": "npx",
//         "args": ["-y", "@anthropic/mcp-server-browser"],
//         "env": { "SOME_KEY": "${SOME_KEY}" },
//         "safety": "uncertain",
//         "safeTools": ["screenshot", "get_page_text"],
//         "unsafeTools": ["delete_cookies"],
//         "timeout": 30000,
//         "disabled": false
//       }
//     }
//   }

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const MCP_PROTOCOL_VERSION = '2024-11-05';
const DEFAULT_TIMEOUT_MS = 30000;
const INIT_TIMEOUT_MS = 15000;

function interpolateEnv(obj) {
  const result = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (typeof v === 'string') {
      result[k] = v.replace(/\$\{([^}]+)\}/g, (_, name) => process.env[name] || '');
    } else {
      result[k] = v;
    }
  }
  return result;
}

// ── Single MCP server connection ──────────────────────────────────────────

class MCPServer {
  constructor(name, config) {
    this.name = name;
    this.command = config.command;
    this.args = config.args || [];
    this.serverEnv = interpolateEnv(config.env);
    this.safety = config.safety || 'uncertain';
    this.safeTools = new Set(config.safeTools || []);
    this.unsafeTools = new Set(config.unsafeTools || []);
    this.timeoutMs = config.timeout || DEFAULT_TIMEOUT_MS;
    this.child = null;
    this.buffer = '';
    this.nextId = 1;
    this.pending = new Map();
    this.tools = [];
    this.serverInfo = null;
    this.running = false;
  }

  async start() {
    const env = { ...process.env, ...this.serverEnv };

    this.child = spawn(this.command, this.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      windowsHide: true,
    });

    // Wire stdout for JSON-RPC messages
    this.child.stdout.on('data', (chunk) => this._onData(chunk));

    // Stderr is server logging — forward in debug mode
    this.child.stderr.on('data', (chunk) => {
      if (process.env.SHMAKK_DEBUG) {
        process.stderr.write(`[mcp:${this.name}] ${chunk}`);
      }
    });

    // Handle process errors
    const startError = new Promise((_, reject) => {
      this.child.on('error', (err) => {
        this.running = false;
        this._rejectAll(`server error: ${err.message}`);
        reject(err);
      });
    });

    this.child.on('exit', (code) => {
      this.running = false;
      this._rejectAll(`server exited (code ${code})`);
    });

    // Race: initialize handshake vs spawn error
    const initResult = await Promise.race([
      this._initialize(),
      startError,
    ]);

    this.serverInfo = initResult?.serverInfo || null;
    this.running = true;

    // Send initialized notification
    this._notify('notifications/initialized');

    // Discover tools
    try {
      const toolsResult = await this._send('tools/list', {}, INIT_TIMEOUT_MS);
      this.tools = Array.isArray(toolsResult?.tools) ? toolsResult.tools : [];
    } catch {
      this.tools = [];
    }
  }

  _initialize() {
    let version;
    try { version = require('../package.json').version; } catch { version = '1.0.0'; }
    return this._send('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'shmakk', version },
    }, INIT_TIMEOUT_MS);
  }

  _onData(chunk) {
    this.buffer += chunk.toString('utf8');
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop(); // keep incomplete last line

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed);
        if (msg.id != null && this.pending.has(msg.id)) {
          const { resolve, reject, timer } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          clearTimeout(timer);
          if (msg.error) {
            reject(new Error(msg.error.message || JSON.stringify(msg.error)));
          } else {
            resolve(msg.result);
          }
        }
        // Server notifications (no id) are silently ignored for now
      } catch {
        // Invalid JSON line — skip
      }
    }
  }

  _send(method, params = {}, timeout) {
    return new Promise((resolve, reject) => {
      if (!this.child || !this.child.stdin.writable) {
        return reject(new Error(`MCP server ${this.name} not running`));
      }
      const id = this.nextId++;
      const msg = { jsonrpc: '2.0', id, method, params };
      const tm = timeout || this.timeoutMs;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP timeout: ${this.name}/${method} (${tm}ms)`));
      }, tm);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify(msg) + '\n');
    });
  }

  _notify(method, params = {}) {
    if (!this.child || !this.child.stdin.writable) return;
    const msg = { jsonrpc: '2.0', method, params };
    this.child.stdin.write(JSON.stringify(msg) + '\n');
  }

  _rejectAll(reason) {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new Error(reason));
    }
    this.pending.clear();
  }

  async callTool(toolName, args, signal) {
    if (!this.running) return { error: `MCP server ${this.name} not running` };
    if (signal && signal.aborted) return { error: 'aborted' };

    try {
      const result = await this._send('tools/call', {
        name: toolName,
        arguments: args || {},
      });

      if (!result) return { error: 'empty response from MCP server' };

      if (result.isError) {
        const errorText = (result.content || [])
          .filter((c) => c.type === 'text')
          .map((c) => c.text)
          .join('\n');
        return { error: errorText || 'MCP tool returned error' };
      }

      // Convert MCP content array to shmakk result format
      const texts = [];
      const images = [];
      for (const item of result.content || []) {
        if (item.type === 'text') {
          texts.push(item.text);
        } else if (item.type === 'image') {
          // Preserve base64 image data so vision-capable providers can process it.
          // Cap at ~2MB of base64 to avoid blowing out context windows.
          const raw = String(item.data || '');
          const capped = raw.length > 2_000_000 ? raw.slice(0, 2_000_000) : raw;
          images.push({
            mimeType: item.mimeType || 'image/png',
            data: capped,
            dataLength: raw.length,
            truncated: raw.length > 2_000_000,
          });
        } else if (item.type === 'resource') {
          texts.push(`[resource: ${item.resource?.uri || 'unknown'}]`);
        }
      }

      return {
        content: texts.join('\n'),
        ...(images.length ? { images } : {}),
      };
    } catch (e) {
      // Distinguish transport-level errors (retryable) from tool-level errors.
      const msg = e.message || '';
      const isRetryable = (
        msg.includes('timeout') ||
        msg.includes('ECONNREFUSED') ||
        msg.includes('ECONNRESET') ||
        msg.includes('EPIPE') ||
        msg.includes('server stopping') ||
        msg.includes('server error') ||
        msg.includes('server exited') ||
        msg.includes('not running')
      );
      return { error: `MCP call failed: ${msg}`, isRetryable };
    }
  }

  classifyTool(toolName) {
    if (this.unsafeTools.has(toolName)) return 'unsafe';
    if (this.safeTools.has(toolName)) return 'safe';
    return this.safety;
  }

  stop() {
    this.running = false;
    this._rejectAll('server stopping');
    if (this.child) {
      try { this.child.kill('SIGTERM'); } catch {}
      const c = this.child;
      setTimeout(() => {
        try { if (c && !c.killed) c.kill('SIGKILL'); } catch {}
      }, 2000);
      this.child = null;
    }
  }

  status() {
    return {
      name: this.name,
      running: this.running,
      tools: this.tools.map((t) => t.name),
      toolCount: this.tools.length,
      serverInfo: this.serverInfo,
      command: `${this.command} ${this.args.join(' ')}`,
    };
  }
}

// ── MCP Manager (holds all server connections) ────────────────────────────

class MCPManager {
  constructor() {
    this.servers = new Map();
    this.toolRegistry = new Map(); // fullName → { serverName, originalName, ... }
  }

  loadConfig(workspaceRoot) {
    const configs = {};
    const globalPath = path.join(os.homedir(), '.config', 'shmakk', 'mcp.json');
    const workspacePath = workspaceRoot
      ? path.join(workspaceRoot, '.shmakk', 'mcp.json')
      : null;

    // Global config
    try {
      if (fs.existsSync(globalPath)) {
        const raw = JSON.parse(fs.readFileSync(globalPath, 'utf8'));
        Object.assign(configs, raw.mcpServers || {});
      }
    } catch {}

    // Workspace config overrides global
    try {
      if (workspacePath && fs.existsSync(workspacePath)) {
        const raw = JSON.parse(fs.readFileSync(workspacePath, 'utf8'));
        Object.assign(configs, raw.mcpServers || {});
      }
    } catch {}

    for (const [name, cfg] of Object.entries(configs)) {
      if (cfg.disabled) continue;
      if (!cfg.command) continue;
      this.servers.set(name, new MCPServer(name, cfg));
    }

    return this.servers.size;
  }

  async startAll(write) {
    const results = [];
    for (const [name, server] of this.servers) {
      try {
        await server.start();
        const n = server.tools.length;
        if (write) write(`[mcp] ${name}: connected (${n} tool${n !== 1 ? 's' : ''})\n`);
        results.push({ name, ok: true, tools: n });
      } catch (e) {
        if (write) write(`[mcp] ${name}: failed — ${e.message}\n`);
        results.push({ name, ok: false, error: e.message });
        this.servers.delete(name);
      }
    }
    this._rebuildToolRegistry();
    return results;
  }

  _rebuildToolRegistry() {
    this.toolRegistry.clear();
    for (const [serverName, server] of this.servers) {
      for (const tool of server.tools) {
        const fullName = `mcp__${serverName}__${tool.name}`;
        this.toolRegistry.set(fullName, {
          serverName,
          originalName: tool.name,
          description: tool.description || '',
          inputSchema: tool.inputSchema || { type: 'object', properties: {} },
        });
      }
    }
  }

  // Returns OpenAI function-calling format tool definitions for all MCP tools.
  getToolDefinitions() {
    const defs = [];
    for (const [fullName, info] of this.toolRegistry) {
      defs.push({
        type: 'function',
        function: {
          name: fullName,
          description: `[MCP:${info.serverName}] ${info.description}`,
          parameters: info.inputSchema,
        },
      });
    }
    return defs;
  }

  hasTool(fullName) {
    return this.toolRegistry.has(fullName);
  }

  classifyTool(fullName) {
    const info = this.toolRegistry.get(fullName);
    if (!info) return 'uncertain';
    const server = this.servers.get(info.serverName);
    if (!server) return 'uncertain';
    return server.classifyTool(info.originalName);
  }

  describeTool(fullName, args) {
    const info = this.toolRegistry.get(fullName);
    if (!info) return fullName;
    return `mcp:${info.serverName}/${info.originalName} ${JSON.stringify(args || {}).slice(0, 80)}`;
  }

  async dispatchTool(fullName, args, signal) {
    const info = this.toolRegistry.get(fullName);
    if (!info) return { error: `unknown MCP tool: ${fullName}` };
    const server = this.servers.get(info.serverName);
    if (!server) return { error: `MCP server ${info.serverName} not available` };
    return server.callTool(info.originalName, args, signal);
  }

  async shutdown() {
    for (const server of this.servers.values()) {
      server.stop();
    }
    this.servers.clear();
    this.toolRegistry.clear();
  }

  status() {
    const servers = [];
    for (const server of this.servers.values()) {
      servers.push(server.status());
    }
    return {
      serverCount: this.servers.size,
      toolCount: this.toolRegistry.size,
      servers,
    };
  }
}

function createMCPManager() {
  return new MCPManager();
}

module.exports = { createMCPManager, MCPManager, MCPServer };
