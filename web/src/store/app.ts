import { create } from 'zustand';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { socket } from '@/lib/ws';
import { queryClient } from '@/lib/query';
import type { AttachmentRef, Bootstrap, ConvMeta, ConvSnapshot, DocPane, Features, Item, Mode, Project, Provider, ServerMsg, Settings, Status, ViewId } from '@/lib/types';

const VIEWS: ViewId[] = ['chat', 'automations', 'github', 'skills', 'memory', 'plan', 'changes', 'recall', 'team', 'mcp', 'activity', 'artefacts', 'settings'];

function readHash(): { view: ViewId; conv: string | null; project: string | null } {
  const h = location.hash.replace(/^#\/?/, '');
  const [a, b] = h.split('/');
  if (a === 'c' && b) return { view: 'chat', conv: b, project: null };
  if (a === 'p' && b) return { view: 'project', conv: null, project: b };
  return { view: (VIEWS as string[]).includes(a) ? (a as ViewId) : 'chat', conv: null, project: null };
}

const MODE_IDS: Mode[] = ['chat', 'code', 'design', 'cowork'];
const savedMode = (): Mode => { const m = localStorage.getItem('shmakk.mode') as Mode | null; return m && MODE_IDS.includes(m) ? m : 'code'; };
const PANES: DocPane[] = ['browser', 'changes', 'plan'];
const savedPane = (): DocPane => { const p = localStorage.getItem('shmakk.rightPane') as DocPane | null; return p && PANES.includes(p) ? p : 'browser'; };

// Inspector width: a comfortable default, clamped so the chat never collapses.
export const RIGHT_MIN = 300;
export const rightMax = () => Math.max(RIGHT_MIN, Math.min(760, window.innerWidth - 380));
export const clampRight = (w: number) => Math.round(Math.max(RIGHT_MIN, Math.min(rightMax(), w)));
const savedWidth = (): number => {
  const n = Number(localStorage.getItem('shmakk.rightWidth'));
  return clampRight(Number.isFinite(n) && n > 0 ? n : Math.min(560, Math.max(400, window.innerWidth * 0.32)));
};

/**
 * The inspector is per session: opening "Changes" in one chat must not follow
 * you into the next. A session without an entry of its own starts from the
 * pre-per-session preference, so upgrading does not reset anyone's layout.
 */
export type RightState = { open: boolean; pane: DocPane };
const RIGHT_KEY = 'shmakk.rightByConv';
export const rightScope = (convId: string | null) => convId ?? '';

const legacyRight = (): RightState => ({ open: localStorage.getItem('shmakk.right') === '1', pane: savedPane() });

function loadRight(): Record<string, RightState> {
  try {
    const raw = JSON.parse(localStorage.getItem(RIGHT_KEY) || '{}') as Record<string, Partial<RightState> | null>;
    const out: Record<string, RightState> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (v && typeof v.open === 'boolean' && PANES.includes(v.pane as DocPane)) out[k] = { open: v.open, pane: v.pane as DocPane };
    }
    return out;
  } catch { return {}; }
}

function persistRight(map: Record<string, RightState>) {
  try { localStorage.setItem(RIGHT_KEY, JSON.stringify(map)); } catch { /* private mode / quota */ }
}

interface AppState {
  ready: boolean;
  online: boolean;
  version: string;
  home: string;
  platform: string;
  hosted: boolean;
  workspace: string;
  settings: Settings;
  provider: Provider;
  features: Features;
  profiles: Bootstrap['profiles'];
  status: Status | null;

  mode: Mode;                       // which space the sidebar and new chats belong to
  projects: Project[];
  projectId: string | null;         // project shown in the Project view
  pendingProjectId: string | null;  // project a not-yet-created chat will join
  designTick: Record<string, number>;

  view: ViewId;
  activeId: string | null;
  convs: ConvMeta[];
  items: Record<string, Item[]>;
  runs: Record<string, string>; // convId → activity label (present while running)
  loading: boolean;

  sidebarOpen: boolean;
  dockOpen: boolean;
  rightOpen: boolean;               // projection of the active session's inspector
  rightPane: DocPane;
  rightMap: Record<string, RightState>;  // per-session inspector state, keyed by conv id ('' = draft)
  rightDefault: RightState;         // what a session that was never touched starts with
  rightWidth: number;               // inspector width in px, drag-resizable, shared by all sessions
  paletteOpen: boolean;
  settingsOpen: boolean;
  folderPickerOpen: boolean;
  keyboardOpen: boolean;
  show2planOpen: boolean;
  focusPlanId: string | null;      // plan the Plans view opens on
  draft: { text: string; mode: 'ask' | 'shell'; nonce: number } | null;

  init(): Promise<void>;
  setView(v: ViewId): void;
  openSettings(open?: boolean): void;
  setMode(m: Mode): void;
  openProject(id: string): void;
  refreshProjects(): Promise<void>;
  moveConv(id: string, projectId: string | null): Promise<void>;
  openConv(id: string): Promise<void>;
  newChat(opts?: { mode?: Mode; projectId?: string | null }): void;
  send(text: string, mode: 'ask' | 'shell', attachments?: AttachmentRef[]): Promise<void>;
  stop(): void;
  answer(askId: string, value: boolean): void;
  renameConv(id: string, title: string): Promise<void>;
  pinConv(id: string, pinned: boolean): Promise<void>;
  deleteConv(id: string): Promise<void>;
  resetConv(): Promise<void>;
  patchSettings(patch: Partial<Settings>): Promise<void>;
  refreshStatus(): Promise<void>;
  setWorkspace(path: string): Promise<void>;
  createWorkspace(name: string): Promise<string>;
  setDraft(text: string, mode?: 'ask' | 'shell'): void;
  clearDraft(): void;
  toggleSidebar(open?: boolean): void;
  toggleDock(open?: boolean): void;
  toggleRight(open?: boolean): void;
  setRightPane(pane: DocPane): void;
  setRightWidth(width: number, persist?: boolean): void;
  setPalette(open: boolean): void;
  setFolderPicker(open: boolean): void;
  setKeyboard(open: boolean): void;
  setShow2plan(open: boolean): void;
  openPlan(id: string | null): void;
  startSession(opts: { repo: string; branch?: string; newBranch?: string; prompt?: string }): Promise<void>;
}

function upsertMeta(list: ConvMeta[], conv: ConvMeta) {
  const next = list.filter((c) => c.id !== conv.id);
  next.push(conv);
  return next.sort((a, b) => b.updatedAt - a.updatedAt);
}

export const useApp = create<AppState>((set, get) => {
  function onMessage(msg: ServerMsg) {
    switch (msg.t) {
      case 'item': {
        const list = get().items[msg.convId];
        if (!list) return;
        const i = list.findIndex((x) => x.id === msg.item.id);
        const next = i === -1 ? [...list, msg.item] : list.map((x, j) => (j === i ? msg.item : x));
        set((s) => ({ items: { ...s.items, [msg.convId]: next } }));
        break;
      }
      case 'delta': {
        const list = get().items[msg.convId];
        if (!list) return;
        const next = list.map((x) => (x.id === msg.id ? ({ ...x, [msg.field]: `${(x as unknown as Record<string, string>)[msg.field] || ''}${msg.text}` } as Item) : x));
        set((s) => ({ items: { ...s.items, [msg.convId]: next } }));
        break;
      }
      case 'remove': {
        const list = get().items[msg.convId];
        if (list) set((s) => ({ items: { ...s.items, [msg.convId]: list.filter((x) => x.id !== msg.id) } }));
        break;
      }
      case 'run':
        set((s) => {
          const runs = { ...s.runs };
          if (msg.running) runs[msg.convId] = msg.activity || runs[msg.convId] || 'working';
          else delete runs[msg.convId];
          return { runs };
        });
        if (!msg.running) {
          void get().refreshStatus();
          if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
            const conv = get().convs.find((c) => c.id === msg.convId);
            new Notification('shmakk finished', { body: conv?.title || 'Your task is done.', silent: true });
          }
        }
        break;
      case 'conv':
        set((s) => ({ convs: upsertMeta(s.convs, msg.conv) }));
        break;
      case 'conv.deleted':
        set((s) => {
          const items = { ...s.items };
          delete items[msg.id];
          // Forget the session's inspector state so ids are not kept forever.
          const rightMap = { ...s.rightMap };
          delete rightMap[msg.id];
          persistRight(rightMap);
          return { convs: s.convs.filter((c) => c.id !== msg.id), items, rightMap, activeId: s.activeId === msg.id ? null : s.activeId };
        });
        break;
      case 'settings': set({ settings: msg.settings }); break;
      case 'provider': set({ provider: msg.provider }); break;
      case 'workspace': set({ workspace: msg.workspace }); void get().refreshStatus(); break;
      case 'status.changed': void get().refreshStatus(); break;
      case 'projects.changed': void get().refreshProjects(); void queryClient.invalidateQueries({ queryKey: ['project'] }); break;
      case 'automations.changed': void queryClient.invalidateQueries({ queryKey: ['automations'] }); break;
      case 'artefacts.changed': void queryClient.invalidateQueries({ queryKey: ['artefacts'] }); break;
      case 'automation.finished': {
        const open = { label: 'Open', onClick: () => void get().openConv(msg.convId) };
        if (msg.status === 'ok') toast.success(`${msg.name} finished`, { action: open });
        else toast.error(`${msg.name} ${msg.status === 'stopped' ? 'was stopped' : 'failed'}`, { action: open });
        break;
      }
      case 'design.changed':
        set((s) => ({ designTick: { ...s.designTick, [msg.convId]: (s.designTick[msg.convId] || 0) + 1 } }));
        break;
      case 'plans.changed':
        void queryClient.invalidateQueries({ queryKey: ['plans'] });
        void queryClient.invalidateQueries({ queryKey: ['plan-full', msg.planId] });
        break;
      case 'show2plan': void queryClient.invalidateQueries({ queryKey: ['show2plan', msg.id] }); break;
      case 'toast': (msg.level === 'error' ? toast.error : toast)(msg.text); break;
      default:
    }
  }

  function syncHash() {
    const { view, activeId, projectId } = get();
    const target = view === 'chat' ? (activeId ? `#/c/${activeId}` : '#/') : view === 'project' && projectId ? `#/p/${projectId}` : `#/${view}`;
    if (location.hash !== target) history.replaceState(null, '', target);
  }

  const rightMap = loadRight();
  const rightDefault = legacyRight();
  const draftRight = rightMap[rightScope(null)] ?? rightDefault;

  return {
    ready: false,
    online: false,
    version: '',
    home: '',
    platform: '',
    hosted: false,
    workspace: '',
    settings: {} as Settings,
    provider: {} as Provider,
    features: {} as Features,
    profiles: [],
    status: null,
    mode: savedMode(),
    projects: [],
    projectId: null,
    pendingProjectId: null,
    designTick: {},
    view: 'chat',
    activeId: null,
    convs: [],
    items: {},
    runs: {},
    loading: false,
    sidebarOpen: window.innerWidth >= 1024 && localStorage.getItem('shmakk.sidebar') !== '0',
    keyboardOpen: false,
    show2planOpen: false,
    focusPlanId: null,
    dockOpen: false,
    rightOpen: draftRight.open,
    rightPane: draftRight.pane,
    rightMap,
    rightDefault,
    rightWidth: savedWidth(),
    paletteOpen: false,
    settingsOpen: false,
    folderPickerOpen: false,
    draft: null,

    async init() {
      const boot = await api.get<Bootstrap>('/api/bootstrap');
      const runs: Record<string, string> = {};
      for (const c of boot.conversations) if (c.running) runs[c.id] = 'working';
      set({
        ready: true, version: boot.version, home: boot.home, platform: boot.platform, hosted: boot.hosted, workspace: boot.workspace,
        settings: boot.settings, provider: boot.provider, features: boot.features, profiles: boot.profiles,
        status: boot.status, convs: boot.conversations, runs, projects: boot.projects,
      });
      socket.on(onMessage);
      socket.onStatus((online) => {
        set({ online });
        // After a reconnect the transcript may have moved on without us.
        const id = get().activeId;
        if (online && id) void get().openConv(id);
      });
      socket.connect();
      const { view, conv, project } = readHash();
      // Settings is a modal, not a screen: remember the intention, stay on the chat.
      const openingSettings = view === 'settings';
      set({
        view: openingSettings ? 'chat' : view === 'project' && !boot.projects.some((p) => p.id === project) ? 'chat' : view,
        projectId: project,
        settingsOpen: openingSettings,
      });
      if (conv && boot.conversations.some((c) => c.id === conv)) await get().openConv(conv);
      window.addEventListener('hashchange', () => {
        const h = readHash();
        if (h.conv && h.conv !== get().activeId) void get().openConv(h.conv);
        else if (h.project) get().openProject(h.project);
        else if (h.view === 'settings') get().openSettings(true);
        else if (h.view !== get().view) set({ view: h.view });
      });
    },

    setView(view) {
      // The settings screen is gone; its view id now opens the settings modal.
      if (view === 'settings') { get().openSettings(true); return; }
      set({ view });
      if (window.innerWidth < 1024) set({ sidebarOpen: false });
      syncHash();
    },

    openSettings(open = true) {
      set({ settingsOpen: open, ...(open && window.innerWidth < 1024 ? { sidebarOpen: false } : {}) });
      if (!open) syncHash();
    },

    setMode(mode) {
      localStorage.setItem('shmakk.mode', mode);
      // Land on the most recent chat of that space, or its empty state.
      const recent = get().convs.find((c) => c.mode === mode && !c.automationId);
      set({ mode, view: 'chat', activeId: null, pendingProjectId: null });
      syncHash();
      if (recent && window.innerWidth >= 1024) void get().openConv(recent.id);
    },

    openProject(id) {
      set({ view: 'project', projectId: id });
      if (window.innerWidth < 1024) set({ sidebarOpen: false });
      syncHash();
    },

    async refreshProjects() {
      try { set({ projects: (await api.get<{ projects: Project[] }>('/api/projects')).projects }); } catch { /* offline */ }
    },

    async moveConv(id, projectId) {
      await api.patch(`/api/conversations/${id}`, { projectId });
      // The sidebar history hides project chats, so reflect the move at once
      // instead of waiting for the server's broadcast.
      set((s) => ({ convs: s.convs.map((c) => (c.id === id ? { ...c, projectId } : c)) }));
      void get().refreshProjects();
      void queryClient.invalidateQueries({ queryKey: ['project'] });
    },

    async openConv(id) {
      const meta = get().convs.find((c) => c.id === id);
      if (meta && meta.mode !== get().mode) { localStorage.setItem('shmakk.mode', meta.mode); set({ mode: meta.mode }); }
      set({ view: 'chat', activeId: id, pendingProjectId: null, loading: !get().items[id] });
      if (window.innerWidth < 1024) set({ sidebarOpen: false });
      syncHash();
      try {
        const snap = await api.get<ConvSnapshot>(`/api/conversations/${id}`);
        set((s) => {
          const runs = { ...s.runs };
          if (snap.running) runs[id] = snap.activity || 'working'; else delete runs[id];
          return { items: { ...s.items, [id]: snap.items }, runs, loading: false, convs: upsertMeta(s.convs, { ...snap, items: undefined, cwd: undefined } as unknown as ConvMeta) };
        });
        // Each conversation belongs to a workspace (cloud sessions have their own
        // clone). Follow it, so the terminal, changes and skills pages match.
        if (snap.workspace && snap.workspace !== get().workspace) {
          api.post<{ workspace: string }>('/api/workspace', { path: snap.workspace })
            .then((r) => { set({ workspace: r.workspace }); void get().refreshStatus(); })
            .catch(() => { /* folder no longer exists */ });
        }
      } catch {
        set({ activeId: null, loading: false });
        syncHash();
      }
    },

    newChat(opts = {}) {
      if (opts.mode && opts.mode !== get().mode) { localStorage.setItem('shmakk.mode', opts.mode); set({ mode: opts.mode }); }
      // A fresh draft starts from the layout you are looking at, then owns it.
      const { rightOpen, rightPane, rightMap } = get();
      const draft = { open: rightOpen, pane: rightPane };
      const nextRight = { ...rightMap, [rightScope(null)]: draft };
      persistRight(nextRight);
      set({ view: 'chat', activeId: null, pendingProjectId: opts.projectId ?? null, rightMap: nextRight });
      if (window.innerWidth < 1024) set({ sidebarOpen: false });
      syncHash();
    },

    async send(text, mode, attachments) {
      let id = get().activeId;
      if (!id) {
        const snap = await api.post<ConvSnapshot>('/api/conversations', { mode: get().mode, projectId: get().pendingProjectId });
        id = snap.id;
        set((s) => {
          // The draft became a real session: its inspector setup comes along.
          const draft = s.rightMap[rightScope(null)];
          const rightMap = draft ? { ...s.rightMap, [snap.id]: draft } : s.rightMap;
          if (rightMap !== s.rightMap) persistRight(rightMap);
          return { activeId: id, pendingProjectId: null, items: { ...s.items, [snap.id]: [] }, convs: upsertMeta(s.convs, snap), rightMap };
        });
        if (snap.projectId) { void get().refreshProjects(); void queryClient.invalidateQueries({ queryKey: ['project'] }); }
        syncHash();
      }
      if ('Notification' in window && Notification.permission === 'default') void Notification.requestPermission();
      socket.send({ t: 'chat.send', convId: id, text, mode, attachments });
    },

    stop() {
      const id = get().activeId;
      if (id) socket.send({ t: 'chat.stop', convId: id });
    },

    answer(askId, value) {
      const id = get().activeId;
      if (id) socket.send({ t: 'chat.answer', convId: id, askId, value });
    },

    async renameConv(id, title) { await api.patch(`/api/conversations/${id}`, { title }); },
    async pinConv(id, pinned) { await api.patch(`/api/conversations/${id}`, { pinned }); },
    async deleteConv(id) { await api.del(`/api/conversations/${id}`); syncHash(); },
    async resetConv() {
      const id = get().activeId;
      if (!id) return;
      try { await api.post(`/api/conversations/${id}/reset`); } catch (e) { toast.error((e as Error).message); }
    },

    async patchSettings(patch) {
      set((s) => ({ settings: { ...s.settings, ...patch } })); // optimistic
      try { set({ settings: await api.patch<Settings>('/api/settings', patch) }); }
      catch (e) { toast.error((e as Error).message); }
    },

    async refreshStatus() {
      try { set({ status: await api.get<Status>('/api/status') }); } catch { /* offline */ }
    },

    async setWorkspace(path) {
      const r = await api.post<{ workspace: string; warning: string | null }>('/api/workspace', { path });
      set({ workspace: r.workspace, activeId: null, view: 'chat', pendingProjectId: null });
      syncHash();
      if (r.warning) toast.warning(r.warning);
      else toast.success(`Workspace: ${r.workspace}`);
      void get().refreshStatus();
    },

    // Create a new workspace under the configured root (location handled server-side).
    async createWorkspace(name) {
      const r = await api.post<{ workspace: string; warning: string | null }>('/api/workspaces', { name });
      set({ workspace: r.workspace, activeId: null, view: 'chat', pendingProjectId: null });
      syncHash();
      if (r.warning) toast.warning(r.warning);
      else toast.success(`Workspace: ${r.workspace}`);
      void get().refreshStatus();
      return r.workspace;
    },

    setDraft(text, mode = 'ask') { set({ draft: { text, mode, nonce: Date.now() }, view: 'chat' }); syncHash(); },
    clearDraft() { if (get().draft) set({ draft: null }); },
    toggleSidebar(open) {
      const next = open ?? !get().sidebarOpen;
      if (window.innerWidth >= 1024) localStorage.setItem('shmakk.sidebar', next ? '1' : '0');
      set({ sidebarOpen: next });
    },
    toggleDock(open) { set({ dockOpen: open ?? !get().dockOpen }); },
    toggleRight(open) {
      set((s) => {
        const key = rightScope(s.activeId);
        const next = { ...(s.rightMap[key] ?? s.rightDefault), open: open ?? !(s.rightMap[key] ?? s.rightDefault).open };
        const map = { ...s.rightMap, [key]: next };
        persistRight(map);
        return { rightMap: map, rightOpen: next.open, rightPane: next.pane };
      });
    },
    setRightPane(rightPane) {
      set((s) => {
        const key = rightScope(s.activeId);
        const next = { ...(s.rightMap[key] ?? s.rightDefault), pane: rightPane, open: true };
        const map = { ...s.rightMap, [key]: next };
        persistRight(map);
        return { rightMap: map, rightOpen: true, rightPane };
      });
    },
    setRightWidth(width, persist = false) {
      const w = clampRight(width);
      if (persist) localStorage.setItem('shmakk.rightWidth', String(w));
      set({ rightWidth: w });
    },
    setPalette(open) { set({ paletteOpen: open }); },
    setFolderPicker(open) { set({ folderPickerOpen: open }); },
    setKeyboard(open) { set({ keyboardOpen: open }); },
    setShow2plan(open) { set({ show2planOpen: open }); },
    openPlan(id) { set({ focusPlanId: id }); get().setView('plan'); },

    // Clone a GitHub repository on the server and open a conversation on it.
    async startSession(opts) {
      const snap = await api.post<ConvSnapshot>('/api/github/sessions', opts);
      set((s) => {
        const runs = { ...s.runs };
        if (snap.running) runs[snap.id] = snap.activity || 'working';
        localStorage.setItem('shmakk.mode', 'code');
        return { mode: 'code' as Mode, view: 'chat', activeId: snap.id, workspace: snap.workspace || s.workspace, items: { ...s.items, [snap.id]: snap.items }, runs, convs: upsertMeta(s.convs, snap) };
      });
      syncHash();
      void get().refreshStatus();
    },
  };
});

// Switching sessions swaps in that session's inspector state. Doing it here
// means every path that changes activeId (open, new chat, delete) is covered.
useApp.subscribe((s, prev) => {
  if (s.activeId === prev.activeId) return;
  const next = s.rightMap[rightScope(s.activeId)] ?? s.rightDefault;
  if (next.open !== s.rightOpen || next.pane !== s.rightPane) useApp.setState({ rightOpen: next.open, rightPane: next.pane });
});

/** Pick a workspace: native dialog in the desktop app, in-app browser otherwise. */
export async function chooseWorkspace() {
  const bridge = window.shmakkDesktop;
  if (bridge) {
    const dir = await bridge.pickFolder();
    if (dir) await useApp.getState().setWorkspace(dir).catch((e: Error) => toast.error(e.message));
  } else {
    useApp.getState().setFolderPicker(true);
  }
}
