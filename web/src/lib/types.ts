// Wire types shared with the server (src/webui/*.js).

export type Safety = 'safe' | 'uncertain' | 'unsafe';
export type AskStatus = 'pending' | 'yes' | 'no' | 'expired';

interface Base { id: string; at: number }

export interface UserItem extends Base { type: 'user'; text: string; mode?: 'ask' | 'shell' }
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
  type: 'ask'; kind: 'tool' | 'plan' | 'confirm' | 'correction'; status: AskStatus; question: string;
  defaultYes?: boolean; name?: string; args?: Record<string, unknown>; safety?: Safety; description?: string;
  diff?: string | null; what?: string; why?: string; detail?: string; input?: string; proposed?: string; reason?: string;
}
export interface PlanTask { id: string; title: string; description: string; status: string; completedAt?: string | null }
export interface Plan { id: string; title: string; status: string; tasks: PlanTask[]; updatedAt?: string; originalRequest?: string }
export interface PlanItem extends Base { type: 'plan'; plan: Plan }
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

export interface ConvMeta {
  id: string; title: string; createdAt: number; updatedAt: number; pinned: boolean;
  workspace: string | null; preview: string; running?: boolean;
}
export interface ConvSnapshot extends ConvMeta { cwd: string; items: Item[]; running: boolean; activity: string | null }

export interface Settings {
  review: boolean; yesFiles: boolean; noCorrection: boolean; noAi: boolean; debug: boolean;
  profile: string | null; ttsAuto: boolean; ttsVoice: string | null; voiceLanguage: string | null;
  voiceHandsFree: boolean; recentWorkspaces: string[];
}
export interface Provider {
  configured: boolean; endpoint: string | null; endpoints: string[]; baseUrl: string; model: string;
  apiKeyMasked: string | null; hasApiKey: boolean; headers: string; registry: string;
}
export interface Features {
  terminal: boolean; terminalReason: string | null; sessionSearch: boolean; stt: boolean; tts: boolean;
  browser: boolean; desktop: boolean;
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
  conversations: ConvMeta[]; status: Status;
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
  | { t: 'toast'; level: 'error' | 'info' | 'ok'; text: string }
  | { t: 'term.data'; id: string; data: string }
  | { t: 'term.exit'; id: string; code: number; error?: string }
  | { t: 'pong' };

export type ViewId = 'chat' | 'skills' | 'memory' | 'plan' | 'changes' | 'recall' | 'team' | 'mcp' | 'activity' | 'settings';
