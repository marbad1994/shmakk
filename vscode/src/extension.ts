import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { spawn, ChildProcess } from 'child_process';

const PARTICIPANT_ID = 'shmakk.agent';

// ── Paths ──────────────────────────────────────────────────────────────────

function globalConfigDir(): string {
  return path.join(os.homedir(), '.config', 'shmakk');
}

function workspaceConfigDir(): string {
  return path.join(workspaceRoot(), '.shmakk');
}

function workspaceRoot(): string {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir();
}

function sessionsDir(): string {
  const base = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  return path.join(base, 'shmakk', 'sessions');
}

// ── Session storage ────────────────────────────────────────────────────────

interface ShmakkMessage {
  role: string;
  content: string;
}

interface ShmakkSession {
  id: string;
  workspace: string;
  startedAt: string;
  updatedAt: string;
  messages: ShmakkMessage[];
  status: 'running' | 'completed' | 'aborted';
}

function listSessions(): ShmakkSession[] {
  const dir = sessionsDir();
  if (!fs.existsSync(dir)) return [];
  const sessions: ShmakkSession[] = [];
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
    try {
      sessions.push(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
    } catch { }
  }
  sessions.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  return sessions;
}

function saveSession(session: ShmakkSession): void {
  const dir = sessionsDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${session.id}.json`), JSON.stringify(session, null, 2));
}

// ── shmakk server manager ──────────────────────────────────────────────────

let serverProcess: ChildProcess | null = null;
let serverCallbacks: Map<string, {
  onChunk: (text: string) => void;
  resolve: (result: { messages: ShmakkMessage[] }) => void;
  reject: (err: Error) => void;
}> = new Map();

function startServer(): ChildProcess {
  if (serverProcess && !serverProcess.killed) return serverProcess;

  const serverPath = path.resolve(__dirname, '..', '..', 'src', 'shmakk-server.js');

  // Build env from shmakk state files (not VS Code settings)
  const state = readWorkspaceState();
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  if (state.endpoint?.base_url) env.SHMAKK_BASE_URL = state.endpoint.base_url;
  if (state.endpoint?.api_key)  env.SHMAKK_API_KEY  = state.endpoint.api_key;
  if (state.model)              env.SHMAKK_MODEL    = state.model;
  // Always disable spinners for the server mode
  env.FORCE_COLOR = '0';
  env.NO_COLOR = '1';
  env.SHMAKK_NO_SPINNER = '1';

  serverProcess = spawn(process.execPath, [serverPath], {
    cwd: workspaceRoot(),
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let buffer = '';
  serverProcess.stdout!.on('data', (data: Buffer) => {
    buffer += data.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        const cb = serverCallbacks.get(msg.id);
        if (!cb) continue;
        switch (msg.type) {
          case 'chunk': cb.onChunk(msg.text); break;
          case 'done': cb.resolve({ messages: msg.history || [] }); serverCallbacks.delete(msg.id); break;
          case 'error': cb.reject(new Error(msg.error)); serverCallbacks.delete(msg.id); break;
          case 'aborted': serverCallbacks.delete(msg.id); break;
        }
      } catch { }
    }
  });

  serverProcess.stderr!.on('data', (data: Buffer) => {
    console.error(`[shmakk-server] ${data.toString()}`);
  });

  serverProcess.on('exit', () => {
    for (const cb of serverCallbacks.values()) {
      cb.reject(new Error('shmakk server exited'));
    }
    serverCallbacks.clear();
    serverProcess = null;
  });

  return serverProcess;
}

function sendToServer(msg: Record<string, unknown>): void {
  startServer().stdin!.write(JSON.stringify(msg) + '\n');
}

function abortServerRequest(id: string): void {
  sendToServer({ type: 'abort', id });
}

function restartServer(): void {
  if (serverProcess) { serverProcess.kill(); serverProcess = null; }
}

// ── Chat participant ───────────────────────────────────────────────────────

function registerChatParticipant(context: vscode.ExtensionContext) {
  const handler: vscode.ChatRequestHandler = async (
    request: vscode.ChatRequest,
    _chatContext: vscode.ChatContext,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
  ): Promise<vscode.ChatResult> => {
    const root = workspaceRoot();
    const sessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const session: ShmakkSession = {
      id: sessionId, workspace: root,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [], status: 'running',
    };

    stream.progress('shmakk is thinking…');

    try {
      let fullResponse = '';

      await new Promise<{ messages: ShmakkMessage[] }>((resolve, reject) => {
        serverCallbacks.set(sessionId, {
          onChunk: (text: string) => { fullResponse += text; stream.markdown(text); },
          resolve, reject,
        });

        sendToServer({
          type: 'agent', id: sessionId,
          prompt: request.prompt, workspaceRoot: root, history: [],
          profile: readWorkspaceState().profile || 'balanced',
        });

        token.onCancellationRequested(() => {
          abortServerRequest(sessionId);
          serverCallbacks.delete(sessionId);
        });
      });

      session.messages = [
        { role: 'user', content: request.prompt },
        { role: 'assistant', content: fullResponse },
      ];
      session.status = 'completed';
      session.updatedAt = new Date().toISOString();
      saveSession(session);

      return { metadata: { sessionId, command: '' } };
    } catch (err: any) {
      session.status = token.isCancellationRequested ? 'aborted' : 'completed';
      session.updatedAt = new Date().toISOString();
      saveSession(session);

      if (!token.isCancellationRequested) {
        stream.markdown(`**shmakk error:** ${err.message}`);
      }
      return { metadata: { sessionId, command: '' }, errorDetails: { message: err.message } };
    }
  };

  const participant = vscode.chat.createChatParticipant(PARTICIPANT_ID, handler);
  participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'icon.png');
  participant.followupProvider = {
    provideFollowups() {
      return [
        { prompt: 'explain the changes', label: 'Explain changes' },
        { prompt: 'run the tests', label: 'Run tests' },
        { prompt: 'summarize this session', label: 'Summarize' },
      ];
    },
  };
  context.subscriptions.push(participant);
}

// ── Endpoints ─────────────────────────────────────────────────────────────

function loadEndpoints(): Record<string, any> {
  // Merge: global then workspace (workspace overrides global)
  const merged: Record<string, any> = {};

  for (const dir of [globalConfigDir(), workspaceConfigDir()]) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, 'endpoints.json'), 'utf8'));
      Object.assign(merged, data);
    } catch { }
  }
  return merged;
}

// ── Skills ─────────────────────────────────────────────────────────────────

interface SkillEntry {
  name: string;
  active: boolean;
  description?: string;
  source: 'global' | 'workspace';
}

function loadSkills(): SkillEntry[] {
  const skills: SkillEntry[] = [];

  // Workspace active skill
  let activeName = '';
  try {
    activeName = JSON.parse(fs.readFileSync(
      path.join(workspaceConfigDir(), 'state', 'active-skill.json'), 'utf8'
    )).name || '';
  } catch { }

  for (const source of ['workspace', 'global'] as const) {
    const dir = source === 'global'
      ? path.join(globalConfigDir(), 'skills')
      : path.join(workspaceConfigDir(), 'skills');
    if (!fs.existsSync(dir)) continue;

    for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.md'))) {
      const name = f.replace(/\.md$/, '');
      let description = '';
      try {
        const content = fs.readFileSync(path.join(dir, f), 'utf8');
        const m = /^---\n[\s\S]*?\ndescription:\s*(.+)\n[\s\S]*?\n---/.exec(content);
        if (m) description = m[1].trim();
      } catch { }
      skills.push({ name, active: name === activeName, description, source });
    }
  }

  return skills;
}

// ── Workspace state ────────────────────────────────────────────────────────

interface WorkspaceState {
  endpointName?: string;
  endpoint?: { base_url?: string; api_key?: string; model?: string };
  model?: string;
  profile?: string;
}

function stateFilePath(): string {
  return path.join(workspaceConfigDir(), 'state', 'vscode-state.json');
}

function readWorkspaceState(): WorkspaceState {
  try {
    const raw = fs.readFileSync(stateFilePath(), 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function writeWorkspaceState(patch: Partial<WorkspaceState>): void {
  const dir = path.dirname(stateFilePath());
  fs.mkdirSync(dir, { recursive: true });
  const current = readWorkspaceState();
  const next = { ...current, ...patch };
  // Remove undefined keys
  for (const k of Object.keys(next)) {
    if ((next as any)[k] === undefined) delete (next as any)[k];
  }
  fs.writeFileSync(stateFilePath(), JSON.stringify(next, null, 2));
}


// ── Terminal helper ────────────────────────────────────────────────────────

function findOrCreateShmakkTerminal(): vscode.Terminal {
  const name = 'shmakk';
  for (const t of vscode.window.terminals) {
    if (t.name === name) return t;
  }
  const terminal = vscode.window.createTerminal({ name, location: vscode.TerminalLocation.Panel });
  terminal.show();
  
  return terminal;
}

function sendToShmakkTerminal(text: string) {
  const terminal = findOrCreateShmakkTerminal();
  terminal.show();
  terminal.shellIntegration?.executeCommand(text);
  // terminal.sendText(text);
}

// ── Activation ─────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext) {
  registerChatParticipant(context);

  context.subscriptions.push(
    vscode.commands.registerCommand('shmakk.openSettings', () => {
      findOrCreateShmakkTerminal();
    }),
    vscode.commands.registerCommand('shmakk.toggleSettings', () => {
      findOrCreateShmakkTerminal();
    }),
    vscode.commands.registerCommand('shmakk.switchEndpoint', async () => {
      const eps = loadEndpoints();
      const names = Object.keys(eps);
      if (!names.length) {
        vscode.window.showInformationMessage(
          'No endpoints configured. Create ~/.config/shmakk/endpoints.json or .shmakk/endpoints.json'
        );
        return;
      }
      const picked = await vscode.window.showQuickPick(names, { placeHolder: 'Select endpoint' });
      if (picked) {
        const cfg = eps[picked];
        writeWorkspaceState({
          endpointName: picked,
          endpoint: cfg,
          model: cfg.model || readWorkspaceState().model,
        });
        restartServer();
        vscode.window.showInformationMessage(`Switched to: ${picked}`);
      }
    }),
    vscode.commands.registerCommand('shmakk.loadSkill', async () => {
      const skills = loadSkills();
      if (!skills.length) {
        vscode.window.showInformationMessage(
          'No skills found in ~/.config/shmakk/skills/ or .shmakk/skills/'
        );
        return;
      }
      const items = skills.map(s => ({
        label: s.name,
        description: `${s.source}${s.active ? ' $(check) active' : ''}`,
        detail: s.description,
      }));
      const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Select a skill' });
      if (picked) {
        const stateDir = path.join(workspaceConfigDir(), 'state');
        const activePath = path.join(stateDir, 'active-skill.json');
        fs.mkdirSync(stateDir, { recursive: true });

        if (skills.find(s => s.name === picked.label)?.active) {
          fs.writeFileSync(activePath, '{}');
          vscode.window.showInformationMessage(`Unloaded: ${picked.label}`);
        } else {
          fs.writeFileSync(activePath, JSON.stringify({ name: picked.label, active: true }));
          vscode.window.showInformationMessage(`Loaded: ${picked.label}`);
        }
      }
    }),
    vscode.commands.registerCommand('shmakk.listSessions', async () => {
      const sessions = listSessions();
      if (!sessions.length) { vscode.window.showInformationMessage('No sessions.'); return; }
      const items = sessions.map(s => ({
        label: `$(comment-discussion) ${s.id}`,
        description: `${s.status} — ${path.basename(s.workspace)}`,
        detail: `${s.messages.length} msgs · ${new Date(s.updatedAt).toLocaleString()}`,
        session: s,
      }));
      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select a session', matchOnDescription: true,
      });
      if (picked) {
        const doc = await vscode.workspace.openTextDocument({
          content: formatSession(picked.session), language: 'markdown',
        });
        await vscode.window.showTextDocument(doc);
      }
    }),
    vscode.commands.registerCommand('shmakk.clearSessions', async () => {
      const answer = await vscode.window.showWarningMessage(
        'Delete all shmakk sessions?', { modal: true }, 'Delete All',
      );
      if (answer === 'Delete All') {
        const dir = sessionsDir();
        if (fs.existsSync(dir)) {
          for (const f of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, f));
        }
        vscode.window.showInformationMessage('All sessions cleared.');
      }
    }),

    vscode.commands.registerCommand('shmakk.fixCode', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const code = editor.selection.isEmpty
        ? editor.document.getText()
        : editor.document.getText(editor.selection);
      if (!code.trim()) {
        vscode.window.showWarningMessage('No code to send.');
        return;
      }
      const lang = editor.document.languageId;
      const prompt = `fix this ${lang} code:\n\`\`\`${lang}\n${code}\n\`\`\``;
      await sendToShmakkTerminal(prompt);
    }),

    vscode.commands.registerCommand('shmakk.explainCode', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const code = editor.selection.isEmpty
        ? editor.document.getText()
        : editor.document.getText(editor.selection);
      if (!code.trim()) {
        vscode.window.showWarningMessage('No code to send.');
        return;
      }
      const lang = editor.document.languageId;
      const prompt = `explain this ${lang} code:\n\`\`\`${lang}\n${code}\n\`\`\``;
      await sendToShmakkTerminal(prompt);
    }),

    vscode.commands.registerCommand('shmakk.sendToShmakk', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const code = editor.selection.isEmpty
        ? editor.document.getText()
        : editor.document.getText(editor.selection);
      if (!code.trim()) {
        vscode.window.showWarningMessage('No code to send.');
        return;
      }
      await sendToShmakkTerminal(code);
    }),
  );

  // ── Code action provider: quick fix via shmakk ───────────────────────────

  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider('*', {
      provideCodeActions(document, range, _context, _token): vscode.CodeAction[] {
        // Only provide quick fixes for the whole file or selections
        // Filter to diagnostics that have a range
        const diagnostics = _context.diagnostics.filter(d => d.range);
        if (!diagnostics.length) return [];

        const fixAll = new vscode.CodeAction(
          'Fix with shmakk',
          vscode.CodeActionKind.QuickFix,
        );
        fixAll.command = {
          command: 'shmakk.fixCode',
          title: 'Fix with shmakk',
          arguments: [],
        };
        fixAll.isPreferred = false;

        const explain = new vscode.CodeAction(
          'Explain in shmakk',
          vscode.CodeActionKind.QuickFix,
        );
        explain.command = {
          command: 'shmakk.explainCode',
          title: 'Explain in shmakk',
          arguments: [],
        };

        return [fixAll, explain];
      },
    }),
  );

  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.text = '$(comment-discussion) shmakk';
  statusBarItem.tooltip = 'shmakk Settings';
  statusBarItem.command = 'shmakk.toggleSettings';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  vscode.window.showInformationMessage('shmakk ready — type @shmakk in chat');
}

function formatSession(session: ShmakkSession): string {
  let md = `# shmakk session\n\n`;
  md += `**ID:** ${session.id}\n`;
  md += `**Workspace:** ${session.workspace}\n`;
  md += `**Status:** ${session.status}\n`;
  md += `**Started:** ${session.startedAt}\n`;
  md += `**Updated:** ${session.updatedAt}\n\n---\n\n`;
  for (const msg of session.messages) {
    md += `### ${msg.role}\n\n${msg.content}\n\n`;
  }
  return md;
}

export function deactivate() {
  if (serverProcess) { serverProcess.kill(); serverProcess = null; }
}
