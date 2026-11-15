// Wire types shared with the server (src/webui/*.js).

export type Mode = 'chat' | 'code' | 'design' | 'cowork';
export type Safety = 'safe' | 'uncertain' | 'unsafe';
export type AskStatus = 'pending' | 'yes' | 'no' | 'expired';

interface Base { id: string; at: number }

export interface AttachmentRef { name: string; size: number; content: string; mimeType?: string; data?: string }
export interface UserItem extends Base { type: 'user'; text: string; mode?: 'ask' | 'shell'; attachments?: { name: string; size: number }[] }
export interface AssistantItem extends Base {
  type: 'assistant'; text: string; reasoning?: string; streaming?: boolean;
  agent?: string | null; cached?: boolean; interim?: boolean;
}
export interface ToolItem extends Base {
  type: 'tool'; name: string; args: Record<string, unknown>;
  status: 'running' | 'done' | 'error' | 'declined' | 'interrupted';
  summary?: string; error?: string | null; result?: Record<string, unknown> | null;
  diff?: string | null; created?: boolean; agent?: string | null; endedAt?: number;
}
export interface AskItem extends Base {
  type: 'ask'; kind: 'tool' | 'plan' | 'confirm' | 'correction'; status: AskStatus; question: string; auto?: boolean;
  defaultYes?: boolean; name?: string; args?: Record<string, unknown>; safety?: Safety; description?: string;
  diff?: string | null; what?: string; why?: string; detail?: string; input?: string; proposed?: string; reason?: string;
}
export interface PlanTask { id: string; title: string; description: string; status: string; completedAt?: string | null }
export interface Plan { id: string; title: string; status: string; tasks: PlanTask[]; updatedAt?: string; originalRequest?: string }
export interface PlanItem extends Base { type: 'plan'; plan: Plan; planId?: string }
export interface StepItem extends Base { type: 'step'; index: number; total: number; title: string; description?: string }
export interface TeamAgent {
  role: string; task: string; fileScope?: string | null; status: string; error?: string | null;
  toolCount?: number; elapsed?: number; skillUsed?: string | null;
}
export interface TeamItem extends Base { type: 'team'; topology: string; reason?: string; source?: string; agents: TeamAgent[] }
export interface ShellItem extends Base {
  type: 'shell'; cmd: string; cwd: string; output: string; running: boolean; exitCode: number | null;
  correctedFrom?: string | null; truncated?: boolean; cwdAfter?: string; interrupted?: boolean;
}
export interface OutputItem extends Base { type: 'output'; title: string; text: string }
export interface LogItem extends Base { type: 'log'; text: string }
export interface NoticeItem extends Base { type: 'notice'; level: 'info' | 'ok' | 'warn' | 'error'; text: string; action?: string }
export interface RouteItem extends Base { type: 'route'; specialist: string; indicator: string; profile: string }

export type Item =
  | UserItem | AssistantItem | ToolItem | AskItem | PlanItem | StepItem | TeamItem
  | ShellItem | OutputItem | LogItem | NoticeItem | RouteItem;

export interface RepoRef { fullName: string; url: string; private: boolean; baseBranch: string; branch: string; defaultBranch: string; canPush: boolean }
export interface ConvMeta {
  id: string; title: string; createdAt: number; updatedAt: number; pinned: boolean;
  workspace: string | null; preview: string; running?: boolean; repo?: RepoRef | null;
  mode: Mode; projectId: string | null; automationId: string | null;
}
export interface Project {
  id: string; name: string; description: string; instructions: string; shareContext: boolean; color: string;
  workspace: string | null; createdAt: number; updatedAt: number; conversations?: number; modes?: Mode[];
}
export interface AutomationStep { title: string; prompt: string }
export interface AutomationRun { id: string; at: number; trigger: string; status: 'running' | 'ok' | 'error' | 'stopped' | 'interrupted'; convId: string; durationMs: number; summary: string; step: number; steps: number }
export interface Automation {
  id: string; name: string; description: string; steps: AutomationStep[]; enabled: boolean; approval: 'auto' | 'ask' | 'full';
  trigger: { type: 'manual' } | { type: 'webhook' } | { type: 'schedule'; cron: string; timezone: string };
  schedule: string | null; nextRunAt: number | null; running: boolean; lastStatus?: string; lastRunAt?: number;
  workspace: string | null; projectId: string | null; runs: AutomationRun[]; updatedAt: number;
}
export interface ConvSnapshot extends ConvMeta { cwd: string; items: Item[]; running: boolean; activity: string | null }

export interface Artefact {
  id: string;
  name: string;
  path: string | null;
  relPath: string;
  mimeType: string;
  size: number;
  binary: boolean;
  truncated: boolean;
  note: string | null;
  mode: Mode;
  convId: string | null;
  workspace: string | null;
  createdAt: number;
  updatedAt: number;
  content?: string; // only present on the single-artefact endpoint
}

export interface Settings {
  review: boolean; yesFiles: boolean; noCorrection: boolean; noAi: boolean; debug: boolean;
  profile: string | null; ttsAuto: boolean; ttsVoice: string | null; voiceLanguage: string | null;
  voiceHandsFree: boolean; recentWorkspaces: string[];
  modelByMode: Record<Mode, string | null>; // per-space model override (null = default)
  systemPrompt: string;                    // global instruction for every conversation
}
export interface RegistryModel {
  name: string; // preset name in ~/.config/shmakk/endpoints.json
  model: string; // model id sent to the provider
  provider: string | null; vision: boolean; hasApiKey: boolean; default: boolean; fast: boolean;
}
export interface Provider {
  configured: boolean; endpoint: string | null; endpoints: string[]; baseUrl: string; model: string;
  apiKeyMasked: string | null; hasApiKey: boolean; headers: string; modelList: string;
  models: string[]; // selectable model ids: the registry first, env vars only as fallback
  registry: RegistryModel[]; // parsed from ~/.config/shmakk/endpoints.json
  modelsSource: 'registry' | 'endpoint' | 'env';
}
export interface Features {
  terminal: boolean; terminalReason: string | null; sessionSearch: boolean; stt: boolean; tts: boolean;
  browser: boolean; desktop: boolean; preview?: boolean;
}
export interface Status {
  pid: number; version: string; workspace: string; workspaceWarning: string | null; uptimeSec: number;
  journal: { status: string; input: string; profile: string; updatedAt: string; startedAt: string; touchedFiles: string[] } | null;
  activeSkill: { name: string; version: string; loadedAt: string | null } | null;
  auditEvents: number; auditPath: string; edits: number; plan: Plan | null;
  mcp: { servers: number; tools: number };
  glossary: { exists: boolean; path?: string; updatedAt?: number; commands?: number };
}
export interface Bootstrap {
  version: string; workspace: string; home: string; platform: string; settings: Settings; provider: Provider;
  profiles: { name: string; contextMode: string; maxToolIters: number }[]; features: Features;
  conversations: ConvMeta[]; status: Status; hosted: boolean; projects: Project[];
}

export type ServerMsg =
  | { t: 'hello'; version: string; workspace: string }
  | { t: 'item'; convId: string; item: Item }
  | { t: 'delta'; convId: string; id: string; field: string; text: string }
  | { t: 'remove'; convId: string; id: string }
  | { t: 'run'; convId: string; running: boolean; activity?: string }
  | { t: 'conv'; conv: ConvMeta }
  | { t: 'conv.deleted'; id: string }
  | { t: 'settings'; settings: Settings }
  | { t: 'provider'; provider: Provider }
  | { t: 'workspace'; workspace: string }
  | { t: 'status.changed' }
  | { t: 'projects.changed' }
  | { t: 'automations.changed' }
  | { t: 'artefacts.changed' }
  | { t: 'automation.finished'; id: string; name: string; status: string; convId: string }
  | { t: 'design.changed'; convId: string }
  | { t: 'toast'; level: 'error' | 'info' | 'ok'; text: string }
  | { t: 'term.data'; id: string; data: string }
  | { t: 'term.exit'; id: string; code: number; error?: string }
  | { t: 'plans.changed'; planId: string }
  | { t: 'show2plan'; id: string; stage: string }
  | { t: 'pong' };

export type ViewId = 'chat' | 'project' | 'automations' | 'github' | 'skills' | 'memory' | 'plan' | 'changes' | 'recall' | 'team' | 'mcp' | 'activity' | 'artefacts' | 'settings';

/** Panes of the right-hand inspector, in tab order. */
export type DocPane = 'browser' | 'changes' | 'plan';
