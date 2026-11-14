// One registry of everything the app can do. It backs both the composer's
// "/" menu and the Ctrl+K palette, and maps 1:1 onto the CLI's flags and
// natural-language self-commands.

import type { ReactNode } from 'react';
import {
  Activity, BookOpen, Code2, GitBranch, MessageCircle, Palette, Workflow, Brain, Bug, CircleHelp, Cpu, Eraser, FileDiff, FolderOpen, Gauge, History, ListChecks,
  MessageSquarePlus, Mic, Moon, Plug, Power, ScrollText, Search, Settings, ShieldCheck, Sparkles, SquareTerminal,
  TerminalSquare, Users, Wand2, Zap,
} from 'lucide-react';
import { toast } from 'sonner';
import { api } from './api';
import type { ViewId } from './types';
import { chooseWorkspace, useApp } from '@/store/app';

export interface Command {
  id: string;
  slash: string;              // typed as /slash in the composer
  title: string;
  hint: string;
  group: 'Chat' | 'Go to' | 'Mode' | 'Model' | 'Skills & memory' | 'Maintenance' | 'App';
  icon: ReactNode;
  arg?: string;               // placeholder when the command takes an argument
  argRequired?: boolean;
  run(arg: string): void | Promise<void>;
}

const app = () => useApp.getState();
const go = (v: ViewId) => () => app().setView(v);
/** Send a CLI self-command phrase through the chat so its output lands in the transcript. */
const say = (text: string) => app().send(text, 'ask');
const onOff = (arg: string, current: boolean) => (/^(on|true|yes|1)$/i.test(arg) ? true : /^(off|false|no|0)$/i.test(arg) ? false : !current);
const guard = async (fn: () => Promise<unknown>, ok?: string) => {
  try { await fn(); if (ok) toast.success(ok); } catch (e) { toast.error((e as Error).message); }
};

export const COMMANDS: Command[] = [
  // ── Chat ──
  { id: 'new', slash: 'new', title: 'New chat', hint: 'Start a fresh conversation', group: 'Chat', icon: <MessageSquarePlus />, run: () => app().newChat() },
  { id: 'reset', slash: 'reset', title: 'Reset conversation context', hint: 'Clear AI history, task journal and index (--reset)', group: 'Chat', icon: <Eraser />, run: () => app().resetConv() },
  { id: 'compact', slash: 'compact', title: 'Compact context', hint: 'Same as reset: drop history + journal (--compact)', group: 'Chat', icon: <Eraser />, run: () => app().resetConv() },
  { id: 'shell', slash: 'shell', title: 'Run a shell command', hint: 'Run in the workspace; failures get corrected or handed to the agent', group: 'Chat', icon: <TerminalSquare />, arg: 'command', argRequired: true, run: (a) => app().send(a, 'shell') },
  { id: 'plan-force', slash: 'plan-first', title: 'Plan first, then execute', hint: 'Generate a step-by-step plan for approval (+ prefix)', group: 'Chat', icon: <ListChecks />, arg: 'task', argRequired: true, run: (a) => app().send(`+${a}`, 'ask') },
  { id: 'recall', slash: 'recall', title: 'Recall from past sessions', hint: 'Full-text search across every session', group: 'Chat', icon: <History />, arg: 'query', argRequired: true, run: (a) => say(`recall ${a}`) },
  { id: 'help', slash: 'help', title: 'Help', hint: 'Show the full CLI reference', group: 'Chat', icon: <CircleHelp />, run: () => say('help') },

  { id: 'clone', slash: 'clone', title: 'Start a GitHub session', hint: 'Clone owner/repo on the server and open a session on it', group: 'Chat', icon: <GitBranch />, arg: 'owner/repo [branch]', argRequired: true, run: (a) => { const [repo, branch] = a.split(/\s+/); const id = toast.loading(`Cloning ${repo}…`); return app().startSession({ repo, branch }).then(() => { toast.success(`Session ready on ${repo}`, { id }); }).catch((e: Error) => { toast.error(e.message, { id }); }); } },

  { id: 'mode-chat', slash: 'chat', title: 'Switch to Chat', hint: 'A plain conversation', group: 'Go to', icon: <MessageCircle />, run: () => app().setMode('chat') },
  { id: 'mode-code', slash: 'code', title: 'Switch to Code', hint: 'The agent in your workspace', group: 'Go to', icon: <Code2 />, run: () => app().setMode('code') },
  { id: 'mode-design', slash: 'design', title: 'Switch to Design', hint: 'Build interfaces with a live preview', group: 'Go to', icon: <Palette />, run: () => app().setMode('design') },
  { id: 'mode-cowork', slash: 'cowork', title: 'Switch to Cowork', hint: 'Tasks, automations and schedules', group: 'Go to', icon: <Workflow />, run: () => app().setMode('cowork') },
  { id: 'v-automations', slash: 'automations', title: 'Automations', hint: 'Scheduled, webhook and manual jobs', group: 'Go to', icon: <Zap />, run: () => { app().setMode('cowork'); app().setView('automations'); } },

  // ── Go to ──
  { id: 'v-github', slash: 'github', title: 'GitHub', hint: 'Connect your account and start sessions on your repositories', group: 'Go to', icon: <GitBranch />, run: go('github') },
  { id: 'v-skills', slash: 'skills', title: 'Skills', hint: 'Browse, load and install skills (--list-skills)', group: 'Go to', icon: <Sparkles />, run: go('skills') },
  { id: 'v-memory', slash: 'memory', title: 'Memory & rules', hint: 'What shmakk remembers and must follow', group: 'Go to', icon: <Brain />, run: go('memory') },
  { id: 'v-plan', slash: 'plan', title: 'Plan & resume status', hint: 'Active plan and task journal (--show-plan, --resume-status)', group: 'Go to', icon: <ListChecks />, run: go('plan') },
  { id: 'v-changes', slash: 'changes', title: 'Review changes', hint: 'Diffs of every file the agent edited', group: 'Go to', icon: <FileDiff />, run: go('changes') },
  { id: 'v-recall', slash: 'sessions', title: 'Session recall', hint: 'Search and browse past sessions', group: 'Go to', icon: <Search />, run: go('recall') },
  { id: 'v-team', slash: 'team', title: 'Agents & workflows', hint: 'Specialist roster and workflow templates', group: 'Go to', icon: <Users />, run: go('team') },
  { id: 'v-mcp', slash: 'mcp', title: 'MCP servers', hint: 'External tool servers (--mcp-status)', group: 'Go to', icon: <Plug />, run: go('mcp') },
  { id: 'v-activity', slash: 'activity', title: 'Activity log', hint: 'Audit trail and session stats (--stats)', group: 'Go to', icon: <Activity />, run: go('activity') },
  { id: 'v-settings', slash: 'settings', title: 'Settings', hint: 'Model, behaviour, voice, appearance', group: 'Go to', icon: <Settings />, run: go('settings') },
  { id: 'terminal', slash: 'terminal', title: 'Toggle terminal', hint: 'The full shmakk CLI in a real terminal', group: 'Go to', icon: <SquareTerminal />, run: () => app().toggleDock() },

  // ── Mode ──
  { id: 'review', slash: 'review', title: 'Toggle review mode', hint: 'Confirm every AI action (--review)', group: 'Mode', icon: <ShieldCheck />, arg: 'on | off', run: (a) => app().patchSettings({ review: onOff(a, app().settings.review) }) },
  { id: 'yes-files', slash: 'yes-files', title: 'Toggle auto-accept file edits', hint: 'Skip confirmation for writes and edits (--yes-files)', group: 'Mode', icon: <Zap />, arg: 'on | off', run: (a) => app().patchSettings({ yesFiles: onOff(a, app().settings.yesFiles) }) },
  { id: 'correction', slash: 'correction', title: 'Toggle command correction', hint: 'Fix typos in failed commands (--no-correction)', group: 'Mode', icon: <Wand2 />, arg: 'on | off', run: (a) => app().patchSettings({ noCorrection: !onOff(a, !app().settings.noCorrection) }) },
  { id: 'debug', slash: 'debug', title: 'Toggle debug output', hint: 'Verbose errors (--debug)', group: 'Mode', icon: <Bug />, arg: 'on | off', run: (a) => app().patchSettings({ debug: onOff(a, app().settings.debug) }) },
  { id: 'profile', slash: 'profile', title: 'Set profile', hint: 'auto · tiny · balanced · deep · builder · large-app', group: 'Mode', icon: <Gauge />, arg: 'name', argRequired: true, run: (a) => app().patchSettings({ profile: a === 'auto' ? null : a }) },
  { id: 'voice', slash: 'voice', title: 'Toggle read-aloud', hint: 'Speak replies (--tts)', group: 'Mode', icon: <Mic />, run: () => app().patchSettings({ ttsAuto: !app().settings.ttsAuto }) },

  // ── Model ──
  { id: 'model', slash: 'model', title: 'Set model', hint: 'Switch the model for the next request', group: 'Model', icon: <Cpu />, arg: 'model id', argRequired: true, run: (a) => guard(() => api.put('/api/provider', { model: a }), `Model → ${a}`) },
  { id: 'endpoint', slash: 'endpoint', title: 'Use endpoint preset', hint: 'From ~/.config/shmakk/endpoints.js (--endpoint)', group: 'Model', icon: <Plug />, arg: 'name', argRequired: true, run: (a) => guard(() => api.post('/api/endpoints/use', { name: a }), `Endpoint → ${a}`) },
  { id: 'config', slash: 'config', title: 'Print config', hint: 'Resolved configuration (--print-config)', group: 'Model', icon: <ScrollText />, run: () => say('show config') },

  // ── Skills & memory ──
  { id: 'skill-load', slash: 'load-skill', title: 'Load skill', hint: 'Activate a skill for this workspace (--load-skill)', group: 'Skills & memory', icon: <Sparkles />, arg: 'name', argRequired: true, run: (a) => guard(() => api.post('/api/skills/load', { name: a }).then(() => app().refreshStatus()), `Loaded skill ${a}`) },
  { id: 'skill-unload', slash: 'unload-skill', title: 'Unload skill', hint: 'Remove a skill from the registry (--unload-skill)', group: 'Skills & memory', icon: <Sparkles />, arg: 'name', argRequired: true, run: (a) => guard(() => api.post('/api/skills/unload', { name: a }).then(() => app().refreshStatus()), `Unloaded skill ${a}`) },
  { id: 'skill-install', slash: 'install-skill', title: 'Install skill from URL', hint: 'Download, validate and load (--install-skill)', group: 'Skills & memory', icon: <Sparkles />, arg: 'url', argRequired: true, run: (a) => guard(() => api.post('/api/skills/install', { url: a }).then(() => app().refreshStatus()), 'Skill installed') },
  { id: 'remember', slash: 'remember', title: 'Remember a fact', hint: 'Save to workspace memory', group: 'Skills & memory', icon: <Brain />, arg: 'fact', argRequired: true, run: (a) => guard(() => api.post('/api/memory/add', { fact: a, scope: 'workspace' }), 'Saved to memory') },
  { id: 'forget', slash: 'forget', title: 'Forget memories', hint: 'Remove entries matching a phrase', group: 'Skills & memory', icon: <Brain />, arg: 'pattern', argRequired: true, run: (a) => guard(async () => { const r = await api.post<{ removed: number }>('/api/memory/forget', { pattern: a }); toast(`Forgot ${r.removed} entr${r.removed === 1 ? 'y' : 'ies'}`); }) },
  { id: 'rules', slash: 'rules', title: 'Show rules', hint: 'Print the active rule files', group: 'Skills & memory', icon: <BookOpen />, run: () => say('show rules') },

  // ── Maintenance ──
  { id: 'stats', slash: 'stats', title: 'Session stats', hint: 'Journal, audit and skill status (--stats)', group: 'Maintenance', icon: <Activity />, run: () => say('stats') },
  { id: 'status', slash: 'status', title: 'Status', hint: 'Is shmakk running? (--status)', group: 'Maintenance', icon: <Activity />, run: () => say('status') },
  { id: 'glossary', slash: 'glossary', title: 'Update command glossary', hint: 'Scan PATH for better corrections (--update-command-glossary)', group: 'Maintenance', icon: <Wand2 />, run: () => guard(async () => { const id = toast.loading('Scanning PATH…'); try { const r = await api.post<{ status: { commands?: number } }>('/api/glossary/update'); toast.success(`Glossary updated — ${r.status.commands ?? 0} commands`, { id }); await app().refreshStatus(); } catch (e) { toast.error((e as Error).message, { id }); } }) },
  { id: 'history', slash: 'build-history', title: 'Build history frequency map', hint: 'Learn from your shell history (--build-history)', group: 'Maintenance', icon: <History />, run: () => guard(async () => { const r = await api.post<{ unique: number; total: number }>('/api/history/build'); toast.success(`${r.unique} unique commands from ${r.total} uses`); }) },

  // ── App ──
  { id: 'workspace', slash: 'workspace', title: 'Switch workspace', hint: 'Change the folder shmakk works in (--workspace)', group: 'App', icon: <FolderOpen />, arg: 'path (optional)', run: (a) => (a ? guard(() => app().setWorkspace(a)) : chooseWorkspace()) },
  { id: 'theme', slash: 'theme', title: 'Toggle light / dark theme', hint: 'Switch appearance', group: 'App', icon: <Moon />, run: () => { const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; localStorage.setItem('shmakk.theme', next); document.documentElement.dataset.theme = next; window.dispatchEvent(new Event('shmakk:theme')); } },
  { id: 'exit', slash: 'exit', title: 'Quit shmakk', hint: 'Stop the server and close (--exit)', group: 'App', icon: <Power />, run: () => { if (confirm('Quit shmakk? Running tasks will be stopped.')) void api.post('/api/shutdown').then(() => { document.title = 'shmakk — stopped'; toast('shmakk has stopped. You can close this window.'); }); } },
];

export function matchSlash(input: string): { query: string; arg: string } | null {
  const m = /^\/([a-z-]*)(?:\s+([\s\S]*))?$/i.exec(input);
  return m ? { query: m[1].toLowerCase(), arg: (m[2] || '').trim() } : null;
}

export function filterCommands(query: string): Command[] {
  if (!query) return COMMANDS;
  const starts = COMMANDS.filter((c) => c.slash.startsWith(query));
  const rest = COMMANDS.filter((c) => !c.slash.startsWith(query) && (c.slash.includes(query) || c.title.toLowerCase().includes(query)));
  return [...starts, ...rest];
}
