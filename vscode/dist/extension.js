"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/extension.ts
var extension_exports = {};
__export(extension_exports, {
  activate: () => activate,
  deactivate: () => deactivate
});
module.exports = __toCommonJS(extension_exports);
var vscode = __toESM(require("vscode"));
var path = __toESM(require("path"));
var fs = __toESM(require("fs"));
var os = __toESM(require("os"));
var import_child_process = require("child_process");
var PARTICIPANT_ID = "shmakk.agent";
function globalConfigDir() {
  return path.join(os.homedir(), ".config", "shmakk");
}
function workspaceConfigDir() {
  return path.join(workspaceRoot(), ".shmakk");
}
function workspaceRoot() {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir();
}
function sessionsDir() {
  const base = process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
  return path.join(base, "shmakk", "sessions");
}
function listSessions() {
  const dir = sessionsDir();
  if (!fs.existsSync(dir)) return [];
  const sessions = [];
  for (const f of fs.readdirSync(dir).filter((f2) => f2.endsWith(".json"))) {
    try {
      sessions.push(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));
    } catch {
    }
  }
  sessions.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  return sessions;
}
function saveSession(session) {
  const dir = sessionsDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${session.id}.json`), JSON.stringify(session, null, 2));
}
var serverProcess = null;
var serverCallbacks = /* @__PURE__ */ new Map();
function startServer() {
  if (serverProcess && !serverProcess.killed) return serverProcess;
  const serverPath = path.resolve(__dirname, "..", "..", "src", "shmakk-server.js");
  const state = readWorkspaceState();
  const env = { ...process.env };
  if (state.endpoint?.base_url) env.SHMAKK_BASE_URL = state.endpoint.base_url;
  if (state.endpoint?.api_key) env.SHMAKK_API_KEY = state.endpoint.api_key;
  if (state.model) env.SHMAKK_MODEL = state.model;
  env.FORCE_COLOR = "0";
  env.NO_COLOR = "1";
  env.SHMAKK_NO_SPINNER = "1";
  serverProcess = (0, import_child_process.spawn)(process.execPath, [serverPath], {
    cwd: workspaceRoot(),
    env,
    stdio: ["pipe", "pipe", "pipe"]
  });
  let buffer = "";
  serverProcess.stdout.on("data", (data) => {
    buffer += data.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        const cb = serverCallbacks.get(msg.id);
        if (!cb) continue;
        switch (msg.type) {
          case "chunk":
            cb.onChunk(msg.text);
            break;
          case "done":
            cb.resolve({ messages: msg.history || [] });
            serverCallbacks.delete(msg.id);
            break;
          case "error":
            cb.reject(new Error(msg.error));
            serverCallbacks.delete(msg.id);
            break;
          case "aborted":
            serverCallbacks.delete(msg.id);
            break;
        }
      } catch {
      }
    }
  });
  serverProcess.stderr.on("data", (data) => {
    console.error(`[shmakk-server] ${data.toString()}`);
  });
  serverProcess.on("exit", () => {
    for (const cb of serverCallbacks.values()) {
      cb.reject(new Error("shmakk server exited"));
    }
    serverCallbacks.clear();
    serverProcess = null;
  });
  return serverProcess;
}
function sendToServer(msg) {
  startServer().stdin.write(JSON.stringify(msg) + "\n");
}
function abortServerRequest(id) {
  sendToServer({ type: "abort", id });
}
function restartServer() {
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
}
function registerChatParticipant(context) {
  const handler = async (request, _chatContext, stream, token) => {
    const root = workspaceRoot();
    const sessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const session = {
      id: sessionId,
      workspace: root,
      startedAt: (/* @__PURE__ */ new Date()).toISOString(),
      updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
      messages: [],
      status: "running"
    };
    stream.progress("shmakk is thinking\u2026");
    try {
      let fullResponse = "";
      await new Promise((resolve2, reject) => {
        serverCallbacks.set(sessionId, {
          onChunk: (text) => {
            fullResponse += text;
            stream.markdown(text);
          },
          resolve: resolve2,
          reject
        });
        sendToServer({
          type: "agent",
          id: sessionId,
          prompt: request.prompt,
          workspaceRoot: root,
          history: [],
          profile: readWorkspaceState().profile || "balanced"
        });
        token.onCancellationRequested(() => {
          abortServerRequest(sessionId);
          serverCallbacks.delete(sessionId);
        });
      });
      session.messages = [
        { role: "user", content: request.prompt },
        { role: "assistant", content: fullResponse }
      ];
      session.status = "completed";
      session.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
      saveSession(session);
      return { metadata: { sessionId, command: "" } };
    } catch (err) {
      session.status = token.isCancellationRequested ? "aborted" : "completed";
      session.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
      saveSession(session);
      if (!token.isCancellationRequested) {
        stream.markdown(`**shmakk error:** ${err.message}`);
      }
      return { metadata: { sessionId, command: "" }, errorDetails: { message: err.message } };
    }
  };
  const participant = vscode.chat.createChatParticipant(PARTICIPANT_ID, handler);
  participant.iconPath = vscode.Uri.joinPath(context.extensionUri, "icon.png");
  participant.followupProvider = {
    provideFollowups() {
      return [
        { prompt: "explain the changes", label: "Explain changes" },
        { prompt: "run the tests", label: "Run tests" },
        { prompt: "summarize this session", label: "Summarize" }
      ];
    }
  };
  context.subscriptions.push(participant);
}
function loadEndpoints() {
  const merged = {};
  for (const dir of [globalConfigDir(), workspaceConfigDir()]) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, "endpoints.json"), "utf8"));
      Object.assign(merged, data);
    } catch {
    }
  }
  return merged;
}
function loadSkills() {
  const skills = [];
  let activeName = "";
  try {
    activeName = JSON.parse(fs.readFileSync(
      path.join(workspaceConfigDir(), "state", "active-skill.json"),
      "utf8"
    )).name || "";
  } catch {
  }
  for (const source of ["workspace", "global"]) {
    const dir = source === "global" ? path.join(globalConfigDir(), "skills") : path.join(workspaceConfigDir(), "skills");
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter((f2) => f2.endsWith(".md"))) {
      const name = f.replace(/\.md$/, "");
      let description = "";
      try {
        const content = fs.readFileSync(path.join(dir, f), "utf8");
        const m = /^---\n[\s\S]*?\ndescription:\s*(.+)\n[\s\S]*?\n---/.exec(content);
        if (m) description = m[1].trim();
      } catch {
      }
      skills.push({ name, active: name === activeName, description, source });
    }
  }
  return skills;
}
function stateFilePath() {
  return path.join(workspaceConfigDir(), "state", "vscode-state.json");
}
function readWorkspaceState() {
  try {
    const raw = fs.readFileSync(stateFilePath(), "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
function writeWorkspaceState(patch) {
  const dir = path.dirname(stateFilePath());
  fs.mkdirSync(dir, { recursive: true });
  const current = readWorkspaceState();
  const next = { ...current, ...patch };
  for (const k of Object.keys(next)) {
    if (next[k] === void 0) delete next[k];
  }
  fs.writeFileSync(stateFilePath(), JSON.stringify(next, null, 2));
}
function findOrCreateShmakkTerminal() {
  const name = "shmakk";
  for (const t of vscode.window.terminals) {
    if (t.name === name) return t;
  }
  const terminal = vscode.window.createTerminal({ name, location: vscode.TerminalLocation.Panel });
  terminal.show();
  return terminal;
}
function sendToShmakkTerminal(text) {
  const terminal = findOrCreateShmakkTerminal();
  terminal.show();
  terminal.shellIntegration?.executeCommand(text);
}
function activate(context) {
  registerChatParticipant(context);
  context.subscriptions.push(
    vscode.commands.registerCommand("shmakk.openSettings", () => {
      findOrCreateShmakkTerminal();
    }),
    vscode.commands.registerCommand("shmakk.toggleSettings", () => {
      findOrCreateShmakkTerminal();
    }),
    vscode.commands.registerCommand("shmakk.switchEndpoint", async () => {
      const eps = loadEndpoints();
      const names = Object.keys(eps);
      if (!names.length) {
        vscode.window.showInformationMessage(
          "No endpoints configured. Create ~/.config/shmakk/endpoints.json or .shmakk/endpoints.json"
        );
        return;
      }
      const picked = await vscode.window.showQuickPick(names, { placeHolder: "Select endpoint" });
      if (picked) {
        const cfg = eps[picked];
        writeWorkspaceState({
          endpointName: picked,
          endpoint: cfg,
          model: cfg.model || readWorkspaceState().model
        });
        restartServer();
        vscode.window.showInformationMessage(`Switched to: ${picked}`);
      }
    }),
    vscode.commands.registerCommand("shmakk.loadSkill", async () => {
      const skills = loadSkills();
      if (!skills.length) {
        vscode.window.showInformationMessage(
          "No skills found in ~/.config/shmakk/skills/ or .shmakk/skills/"
        );
        return;
      }
      const items = skills.map((s) => ({
        label: s.name,
        description: `${s.source}${s.active ? " $(check) active" : ""}`,
        detail: s.description
      }));
      const picked = await vscode.window.showQuickPick(items, { placeHolder: "Select a skill" });
      if (picked) {
        const stateDir = path.join(workspaceConfigDir(), "state");
        const activePath = path.join(stateDir, "active-skill.json");
        fs.mkdirSync(stateDir, { recursive: true });
        if (skills.find((s) => s.name === picked.label)?.active) {
          fs.writeFileSync(activePath, "{}");
          vscode.window.showInformationMessage(`Unloaded: ${picked.label}`);
        } else {
          fs.writeFileSync(activePath, JSON.stringify({ name: picked.label, active: true }));
          vscode.window.showInformationMessage(`Loaded: ${picked.label}`);
        }
      }
    }),
    vscode.commands.registerCommand("shmakk.listSessions", async () => {
      const sessions = listSessions();
      if (!sessions.length) {
        vscode.window.showInformationMessage("No sessions.");
        return;
      }
      const items = sessions.map((s) => ({
        label: `$(comment-discussion) ${s.id}`,
        description: `${s.status} \u2014 ${path.basename(s.workspace)}`,
        detail: `${s.messages.length} msgs \xB7 ${new Date(s.updatedAt).toLocaleString()}`,
        session: s
      }));
      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: "Select a session",
        matchOnDescription: true
      });
      if (picked) {
        const doc = await vscode.workspace.openTextDocument({
          content: formatSession(picked.session),
          language: "markdown"
        });
        await vscode.window.showTextDocument(doc);
      }
    }),
    vscode.commands.registerCommand("shmakk.clearSessions", async () => {
      const answer = await vscode.window.showWarningMessage(
        "Delete all shmakk sessions?",
        { modal: true },
        "Delete All"
      );
      if (answer === "Delete All") {
        const dir = sessionsDir();
        if (fs.existsSync(dir)) {
          for (const f of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, f));
        }
        vscode.window.showInformationMessage("All sessions cleared.");
      }
    }),
    vscode.commands.registerCommand("shmakk.fixCode", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const code = editor.selection.isEmpty ? editor.document.getText() : editor.document.getText(editor.selection);
      if (!code.trim()) {
        vscode.window.showWarningMessage("No code to send.");
        return;
      }
      const lang = editor.document.languageId;
      const prompt = `fix this ${lang} code:
\`\`\`${lang}
${code}
\`\`\``;
      await sendToShmakkTerminal(prompt);
    }),
    vscode.commands.registerCommand("shmakk.explainCode", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const code = editor.selection.isEmpty ? editor.document.getText() : editor.document.getText(editor.selection);
      if (!code.trim()) {
        vscode.window.showWarningMessage("No code to send.");
        return;
      }
      const lang = editor.document.languageId;
      const prompt = `explain this ${lang} code:
\`\`\`${lang}
${code}
\`\`\``;
      await sendToShmakkTerminal(prompt);
    }),
    vscode.commands.registerCommand("shmakk.sendToShmakk", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const code = editor.selection.isEmpty ? editor.document.getText() : editor.document.getText(editor.selection);
      if (!code.trim()) {
        vscode.window.showWarningMessage("No code to send.");
        return;
      }
      await sendToShmakkTerminal(code);
    })
  );
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider("*", {
      provideCodeActions(document, range, _context, _token) {
        const diagnostics = _context.diagnostics.filter((d) => d.range);
        if (!diagnostics.length) return [];
        const fixAll = new vscode.CodeAction(
          "Fix with shmakk",
          vscode.CodeActionKind.QuickFix
        );
        fixAll.command = {
          command: "shmakk.fixCode",
          title: "Fix with shmakk",
          arguments: []
        };
        fixAll.isPreferred = false;
        const explain = new vscode.CodeAction(
          "Explain in shmakk",
          vscode.CodeActionKind.QuickFix
        );
        explain.command = {
          command: "shmakk.explainCode",
          title: "Explain in shmakk",
          arguments: []
        };
        return [fixAll, explain];
      }
    })
  );
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.text = "$(comment-discussion) shmakk";
  statusBarItem.tooltip = "shmakk Settings";
  statusBarItem.command = "shmakk.toggleSettings";
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);
  vscode.window.showInformationMessage("shmakk ready \u2014 type @shmakk in chat");
}
function formatSession(session) {
  let md = `# shmakk session

`;
  md += `**ID:** ${session.id}
`;
  md += `**Workspace:** ${session.workspace}
`;
  md += `**Status:** ${session.status}
`;
  md += `**Started:** ${session.startedAt}
`;
  md += `**Updated:** ${session.updatedAt}

---

`;
  for (const msg of session.messages) {
    md += `### ${msg.role}

${msg.content}

`;
  }
  return md;
}
function deactivate() {
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  activate,
  deactivate
});
//# sourceMappingURL=extension.js.map
