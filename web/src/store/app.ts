import { create } from 'zustand';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { socket } from '@/lib/ws';
import type { Bootstrap, ConvMeta, ConvSnapshot, Features, Item, Provider, ServerMsg, Settings, Status, ViewId } from '@/lib/types';

const VIEWS: ViewId[] = ['chat', 'skills', 'memory', 'plan', 'changes', 'recall', 'team', 'mcp', 'activity', 'settings'];

function readHash(): { view: ViewId; conv: string | null } {
  const h = location.hash.replace(/^#\/?/, '');
  const [a, b] = h.split('/');
  if (a === 'c' && b) return { view: 'chat', conv: b };
  return { view: (VIEWS as string[]).includes(a) ? (a as ViewId) : 'chat', conv: null };
}

interface AppState {
  ready: boolean;
  online: boolean;
  version: string;
  home: string;
  platform: string;
  workspace: string;
  settings: Settings;
  provider: Provider;
  features: Features;
  profiles: Bootstrap['profiles'];
  status: Status | null;

  view: ViewId;
  activeId: string | null;
  convs: ConvMeta[];
  items: Record<string, Item[]>;
  runs: Record<string, string>; // convId → activity label (present while running)
  loading: boolean;

  sidebarOpen: boolean;
  dockOpen: boolean;
  paletteOpen: boolean;
  folderPickerOpen: boolean;
  keyboardOpen: boolean;
  draft: { text: string; mode: 'ask' | 'shell'; nonce: number } | null;

  init(): Promise<void>;
  setView(v: ViewId): void;
  openConv(id: string): Promise<void>;
  newChat(): void;
  send(text: string, mode: 'ask' | 'shell'): Promise<void>;
  stop(): void;
  answer(askId: string, value: boolean): void;
  renameConv(id: string, title: string): Promise<void>;
  pinConv(id: string, pinned: boolean): Promise<void>;
  deleteConv(id: string): Promise<void>;
  resetConv(): Promise<void>;
  patchSettings(patch: Partial<Settings>): Promise<void>;
  refreshStatus(): Promise<void>;
  setWorkspace(path: string): Promise<void>;
  setDraft(text: string, mode?: 'ask' | 'shell'): void;
  toggleSidebar(open?: boolean): void;
  toggleDock(open?: boolean): void;
  setPalette(open: boolean): void;
  setFolderPicker(open: boolean): void;
  setKeyboard(open: boolean): void;
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
          return { convs: s.convs.filter((c) => c.id !== msg.id), items, activeId: s.activeId === msg.id ? null : s.activeId };
        });
        break;
      case 'settings': set({ settings: msg.settings }); break;
      case 'provider': set({ provider: msg.provider }); break;
      case 'workspace': set({ workspace: msg.workspace }); void get().refreshStatus(); break;
      case 'status.changed': void get().refreshStatus(); break;
      case 'toast': (msg.level === 'error' ? toast.error : toast)(msg.text); break;
      default:
    }
  }

  function syncHash() {
    const { view, activeId } = get();
    const target = view === 'chat' ? (activeId ? `#/c/${activeId}` : '#/') : `#/${view}`;
    if (location.hash !== target) history.replaceState(null, '', target);
  }

  return {
    ready: false,
    online: false,
    version: '',
    home: '',
    platform: '',
    workspace: '',
    settings: {} as Settings,
    provider: {} as Provider,
    features: {} as Features,
    profiles: [],
    status: null,
    view: 'chat',
    activeId: null,
    convs: [],
    items: {},
    runs: {},
    loading: false,
    sidebarOpen: window.innerWidth >= 1024 && localStorage.getItem('shmakk.sidebar') !== '0',
    keyboardOpen: false,
    dockOpen: false,
    paletteOpen: false,
    folderPickerOpen: false,
    draft: null,

    async init() {
      const boot = await api.get<Bootstrap>('/api/bootstrap');
      const runs: Record<string, string> = {};
      for (const c of boot.conversations) if (c.running) runs[c.id] = 'working';
      set({
        ready: true, version: boot.version, home: boot.home, platform: boot.platform, workspace: boot.workspace,
        settings: boot.settings, provider: boot.provider, features: boot.features, profiles: boot.profiles,
        status: boot.status, convs: boot.conversations, runs,
      });
      socket.on(onMessage);
      socket.onStatus((online) => {
        set({ online });
        // After a reconnect the transcript may have moved on without us.
        const id = get().activeId;
        if (online && id) void get().openConv(id);
      });
      socket.connect();
      const { view, conv } = readHash();
      set({ view });
      if (conv && boot.conversations.some((c) => c.id === conv)) await get().openConv(conv);
      window.addEventListener('hashchange', () => {
        const h = readHash();
        if (h.conv && h.conv !== get().activeId) void get().openConv(h.conv);
        else if (h.view !== get().view) set({ view: h.view });
      });
    },

    setView(view) {
      set({ view });
      if (window.innerWidth < 1024) set({ sidebarOpen: false });
      syncHash();
    },

    async openConv(id) {
      set({ view: 'chat', activeId: id, loading: !get().items[id] });
      if (window.innerWidth < 1024) set({ sidebarOpen: false });
      syncHash();
      try {
        const snap = await api.get<ConvSnapshot>(`/api/conversations/${id}`);
        set((s) => {
          const runs = { ...s.runs };
          if (snap.running) runs[id] = snap.activity || 'working'; else delete runs[id];
          return { items: { ...s.items, [id]: snap.items }, runs, loading: false };
        });
      } catch {
        set({ activeId: null, loading: false });
        syncHash();
      }
    },

    newChat() {
      set({ view: 'chat', activeId: null });
      if (window.innerWidth < 1024) set({ sidebarOpen: false });
      syncHash();
    },

    async send(text, mode) {
      let id = get().activeId;
      if (!id) {
        const snap = await api.post<ConvSnapshot>('/api/conversations', {});
        id = snap.id;
        set((s) => ({ activeId: id, items: { ...s.items, [snap.id]: [] }, convs: upsertMeta(s.convs, snap) }));
        syncHash();
      }
      if ('Notification' in window && Notification.permission === 'default') void Notification.requestPermission();
      socket.send({ t: 'chat.send', convId: id, text, mode });
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
      set({ workspace: r.workspace, activeId: null, view: 'chat' });
      syncHash();
      if (r.warning) toast.warning(r.warning);
      else toast.success(`Workspace: ${r.workspace}`);
      void get().refreshStatus();
    },

    setDraft(text, mode = 'ask') { set({ draft: { text, mode, nonce: Date.now() }, view: 'chat' }); syncHash(); },
    toggleSidebar(open) {
      const next = open ?? !get().sidebarOpen;
      if (window.innerWidth >= 1024) localStorage.setItem('shmakk.sidebar', next ? '1' : '0');
      set({ sidebarOpen: next });
    },
    toggleDock(open) { set({ dockOpen: open ?? !get().dockOpen }); },
    setPalette(open) { set({ paletteOpen: open }); },
    setFolderPicker(open) { set({ folderPickerOpen: open }); },
    setKeyboard(open) { set({ keyboardOpen: open }); },
  };
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
