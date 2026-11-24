// A tray indicator for `shmakk windows-daemon`: an org.kde.StatusNotifierItem
// plus a com.canonical.dbusmenu, so the Plasma panel can show what the daemon
// knows and drive it. The menu mirrors the daemon's own capabilities: cycle the
// layout (same as Ctrl+Alt+;), swap screens, pick the suggestion mode, clear
// muted pairs, focus an open window, quit.
//
// Needs the optional dependency dbus-next, which the daemon already requires.

const ITEM_PATH = '/StatusNotifierItem';
const MENU_PATH = '/MenuBar';
const ICON = 'preferences-system-windows';
const WATCHER_SERVICE = 'org.kde.StatusNotifierWatcher';
const WATCHER_PATH = '/StatusNotifierWatcher';
const ITEM_ID = 'shmakk-windows';

// Stable menu ids. Plasma keeps its own cache of the tree, so entries have to
// keep their id across rebuilds for clicks to land on the right action.
const ID = {
  windowsHeader: 10,
  screensHeader: 11,
  sep1: 12,
  arrange: 20,
  swap: 21,
  sep2: 22,
  windows: 30,
  sep3: 31,
  suggestions: 40,
  sep4: 41,
  muted: 50,
  unmute: 51,
  sep5: 60,
  status: 70,
  quit: 80,
};
const WINDOW_BASE = 1000;
const MUTED_BASE = 600;
const MODE_LABEL = { off: 'Off', suggest: 'Suggest', auto: 'Auto' };
const MODES = ['off', 'suggest', 'auto'];

function itemName(pid = process.pid) {
  return `org.kde.StatusNotifierItem-${pid}-1`;
}

function node(id, label, extra = {}) {
  return { id, label, enabled: true, visible: true, type: 'standard', toggleType: null, toggleState: 0, children: [], ...extra };
}

const separator = (id) => node(id, '-', { type: 'separator', enabled: false });
const info = (id, label) => node(id, label, { enabled: false });

/**
 * Build the menu tree for the daemon state:
 *   mode    'off' | 'suggest' | 'auto'
 *   windows [{ id, app }]   most recently focused first
 *   screens [{ name, enabled }]
 *   muted   ['kate -> firefox']
 *   daemon  false when focus recording stopped
 * Returns a flat list of sibling nodes; children hang off each node.
 */
function buildMenu(state = {}) {
  const windows = (Array.isArray(state.windows) ? state.windows : []).filter((w) => w && w.id);
  const screens = (Array.isArray(state.screens) ? state.screens : []).filter((s) => s && s.name && s.enabled !== false);
  const muted = Array.isArray(state.muted) ? state.muted : [];
  const mode = MODES.includes(state.mode) ? state.mode : 'suggest';

  const header = windows.length === 1 ? '1 window open' : `${windows.length} windows open`;
  const windowItems = windows.map((w, i) =>
    node(WINDOW_BASE + i, w.app || 'window', { action: { kind: 'focus', windowId: w.id } }));
  if (!windowItems.length) windowItems.push(info(WINDOW_BASE, 'none open'));

  const suggestionItems = MODES.map((m, i) => node(ID.suggestions * 10 + i, MODE_LABEL[m], {
    type: 'radio',
    toggleType: 'radio',
    toggleState: m === mode ? 1 : 0,
    action: { kind: 'mode', mode: m },
  }));

  const mutedItems = muted.map((p, i) => info(MUTED_BASE + i, p));
  mutedItems.push(node(ID.unmute, 'Unmute all', {
    enabled: muted.length > 0,
    action: { kind: 'unmute' },
  }));

  return [
    info(ID.windowsHeader, state.daemon === false ? `${header}, not recording` : header),
    info(ID.screensHeader, screens.length
      ? screens.map((s, i) => (i === 0 ? `${s.name} (main)` : s.name)).join(', ')
      : 'no screens reported'),
    separator(ID.sep1),
    node(ID.arrange, 'Arrange windows', { action: { kind: 'arrange' } }),
    node(ID.swap, 'Swap screens', { enabled: screens.length > 1, action: { kind: 'swap' } }),
    separator(ID.sep2),
    node(ID.windows, windows.length ? `Windows (${windows.length})` : 'Windows', {
      enabled: windows.length > 0,
      children: windowItems,
    }),
    separator(ID.sep3),
    node(ID.suggestions, `Suggestions: ${MODE_LABEL[mode]}`, { children: suggestionItems }),
    separator(ID.sep4),
    node(ID.muted, muted.length ? `Muted pairs (${muted.length})` : 'Muted pairs', { children: mutedItems }),
    separator(ID.sep5),
    node(ID.status, 'Status', { action: { kind: 'status' } }),
    node(ID.quit, 'Quit', { action: { kind: 'quit' } }),
  ];
}

/** Index a built tree by id, so a menu click can find its action. */
function indexMenu(nodes, byId = new Map()) {
  for (const n of nodes) {
    byId.set(n.id, n);
    indexMenu(n.children, byId);
  }
  return byId;
}

function propsFor(n, Variant) {
  const props = {
    label: new Variant('s', String(n.label)),
    enabled: new Variant('b', n.enabled !== false),
    visible: new Variant('b', n.visible !== false),
    type: new Variant('s', n.type || 'standard'),
  };
  if (n.toggleType) {
    props['toggle-type'] = new Variant('s', n.toggleType);
    props['toggle-state'] = new Variant('i', n.toggleState ? 1 : 0);
  }
  if (n.children.length || n.type === 'submenu') props['children-display'] = new Variant('s', 'submenu');
  return props;
}

/** dbusmenu layout tuple (ia{sv}av) for one node and its children. */
function layoutTuple(n, Variant) {
  const children = n.children.map((c) => new Variant('(ia{sv}av)', layoutTuple(c, Variant)));
  return [n.id, propsFor(n, Variant), children];
}

function findNode(nodes, id) {
  if (id === 0) return { id: 0, label: 'root', type: 'submenu', enabled: true, visible: true, children: nodes };
  return indexMenu(nodes).get(id) || null;
}

function sanitizeWindowId(id) {
  const s = String(id == null ? '' : id).replace(/[^0-9A-Za-z_-]/g, '');
  return s;
}

/** KWin one-off script that raises the window with this internal id. */
function focusScript(shared, windowId) {
  const id = sanitizeWindowId(windowId);
  return `${shared}
(function () {
  var list = workspace.windowList();
  for (var i = 0; i < list.length; i++) {
    if (String(list[i].internalId) === "${id}") { workspace.activeWindow = list[i]; return; }
  }
})();
`;
}

function sleep(ms) {
  return new Promise((r) => { const t = setTimeout(r, ms); if (t.unref) t.unref(); });
}

/**
 * Export the indicator and its menu, register with the Plasma watcher, and
 * return { stop, refresh }. Resolves to null when the tray cannot start.
 *
 *   bus, dbus    a connected session bus and the dbus-next module
 *   W, P         src/services/windows.js and windows-proactive.js
 *   reorder      the reorder engine from src/services/windows-reorder.js
 *   getState     () => state object for buildMenu (may be async)
 *   log          line logger
 *   onQuit       called by the Quit entry
 */
async function startTray({ bus, dbus, db, W, P, reorder, getState, log = () => {}, onQuit }) {
  const { Interface } = dbus.interface;
  const { Variant } = dbus;
  const name = itemName();

  let nodes = buildMenu({});
  let byId = indexMenu(nodes);
  let revision = 1;
  let opened = false;
  let refreshing = null;

  function rebuild() {
    const state = typeof getState === 'function' ? getState() : getState || {};
    nodes = buildMenu(state || {});
    byId = indexMenu(nodes);
    return nodes;
  }

  async function act(action) {
    if (!action) return null;
    if (action.kind === 'arrange') return reorder.handle({ kind: 'command', command: 'reorder' });
    if (action.kind === 'swap') {
      const r = await W.runCommand('swap-screens', { keepAlive: true });
      return r && r.done ? r.done : r;
    }
    if (action.kind === 'mode') {
      W.setKv(db, 'proactiveMode', action.mode);
      return { mode: action.mode };
    }
    if (action.kind === 'unmute') return P.unmuteAll(db);
    if (action.kind === 'focus') return W.runKwinScript(focusScript(W.kwinShared(), action.windowId));
    if (action.kind === 'status') {
      const st = getState() || {};
      return P.notifySend({
        summary: 'shmakk windows',
        body: [
          st.windows ? `${st.windows.length} windows open` : 'no windows open',
          (st.screens || []).length ? `screens: ${st.screens.map((s) => s.name).join(', ')}` : null,
          `suggestions: ${st.mode || 'suggest'}`,
          (st.muted || []).length ? `muted: ${st.muted.length}` : null,
        ].filter(Boolean).join('\n'),
        actions: [],
        timeoutMs: 6000,
        icon: ICON,
      }).catch(() => {});
    }
    if (action.kind === 'quit' && onQuit) return onQuit();
    return null;
  }

  class ItemIface extends Interface {
    get Category() { return 'ApplicationStatus'; }
    get Id() { return ITEM_ID; }
    get Title() { return 'shmakk windows'; }
    get Status() { return 'Active'; }
    get IconName() { return ICON; }
    get IconThemePath() { return []; }
    get IconPixmap() { return []; }
    get ItemIsMenu() { return true; }
    get Menu() { return MENU_PATH; }
    get WindowId() { return 0; }
    get ToolTip() { return ['shmakk windows', [], 'Window awareness for KDE Plasma', 'Click for windows, layouts and suggestion mode']; }
    Activate() {}
    SecondaryActivate() {}
    ContextMenu() {}
    Scroll() {}
  }
  ItemIface.configureMembers({
    properties: {
      Category: { signature: 's', access: 'read' },
      Id: { signature: 's', access: 'read' },
      Title: { signature: 's', access: 'read' },
      Status: { signature: 's', access: 'read' },
      IconName: { signature: 's', access: 'read' },
      IconThemePath: { signature: 'as', access: 'read' },
      IconPixmap: { signature: 'a(iiay)', access: 'read' },
      ItemIsMenu: { signature: 'b', access: 'read' },
      Menu: { signature: 'o', access: 'read' },
      WindowId: { signature: 'i', access: 'read' },
      ToolTip: { signature: '(sa(iiay)ss)', access: 'read' },
    },
    methods: {
      Activate: { inSignature: 'ii', outSignature: '' },
      SecondaryActivate: { inSignature: 'ii', outSignature: '' },
      ContextMenu: { inSignature: 'ii', outSignature: '' },
      Scroll: { inSignature: 'is', outSignature: '' },
    },
    signals: {
      NewIcon: { signature: '' },
      NewStatus: { signature: 's' },
      NewTitle: { signature: '' },
      NewToolTip: { signature: '' },
    },
  });

  class MenuIface extends Interface {
    get Version() { return 3; }
    get TextDirection() { return 'ltr'; }
    get Status() { return 'normal'; }
    get IconThemePath() { return []; }

    GetLayout(parentId) {
      const tree = rebuild();
      const root = findNode(tree, Number(parentId) || 0);
      return [revision, root ? layoutTuple(root, Variant) : layoutTuple({ id: 0, children: [] }, Variant)];
    }

    GetGroupProperties(ids) {
      const tree = rebuild();
      const map = indexMenu(tree);
      return (ids && ids.length ? ids : [0]).map((id) => {
        const n = id === 0
          ? { id: 0, label: 'root', type: 'submenu', enabled: true, visible: true, children: tree }
          : map.get(id);
        return n ? [n.id, propsFor(n, Variant)] : [id, {}];
      });
    }

    GetProperty(id, prop) {
      const n = indexMenu(rebuild()).get(id);
      if (!n) return new Variant('s', '');
      const p = propsFor(n, Variant)[prop];
      return p || new Variant('s', '');
    }

    AboutToShow() {
      opened = true;
      return false;
    }

    AboutToShowGroup(ids) {
      opened = true;
      return [[], []];
    }

    Event(id) {
      const n = byId.get(Number(id));
      if (!n || !n.action) return;
      Promise.resolve(act(n.action)).catch((e) => log(`tray: ${n.action.kind} failed: ${e.message}`));
    }

    EventGroup(events) {
      for (const ev of events || []) {
        if (!Array.isArray(ev)) continue;
        const n = byId.get(Number(ev[0]));
        if (n && n.action && (ev[1] === 'clicked' || ev[1] === 'activated')) {
          Promise.resolve(act(n.action)).catch((e) => log(`tray: ${n.action.kind} failed: ${e.message}`));
        }
      }
      return [];
    }
  }
  MenuIface.configureMembers({
    properties: {
      Version: { signature: 'u', access: 'read' },
      TextDirection: { signature: 's', access: 'read' },
      Status: { signature: 's', access: 'read' },
      IconThemePath: { signature: 'as', access: 'read' },
    },
    methods: {
      GetLayout: { inSignature: 'iias', outSignature: 'u(ia{sv}av)' },
      GetGroupProperties: { inSignature: 'aias', outSignature: 'a(ia{sv})' },
      GetProperty: { inSignature: 'is', outSignature: 'v' },
      Event: { inSignature: 'isvu', outSignature: '' },
      EventGroup: { inSignature: 'a(isvu)', outSignature: 'ai' },
      AboutToShow: { inSignature: 'i', outSignature: 'b' },
      AboutToShowGroup: { inSignature: 'ai', outSignature: 'aiai' },
    },
    signals: {
      LayoutUpdated: { signature: 'ui' },
      ItemsPropertiesUpdated: { signature: 'a(ia{sv})a(ias)' },
    },
  });

  const itemIface = new ItemIface('org.kde.StatusNotifierItem');
  const menuIface = new MenuIface('com.canonical.dbusmenu');
  bus.export(ITEM_PATH, itemIface);
  bus.export(MENU_PATH, menuIface);

  const reply = await bus.requestName(name, dbus.NameFlag.DO_NOT_QUEUE);
  if (reply !== dbus.RequestNameReply.PRIMARY_OWNER) {
    log(`tray: could not own ${name}`);
    return null;
  }

  let registered = false;
  async function register(attempts) {
    let last = null;
    for (let i = 0; i < (attempts || 1); i++) {
      try {
        const obj = await bus.getProxyObject(WATCHER_SERVICE, WATCHER_PATH);
        await obj.getInterface(WATCHER_SERVICE).RegisterStatusNotifierItem(name);
        if (!registered) log('tray: registered with the Plasma panel');
        registered = true;
        return true;
      } catch (e) {
        last = e;
        if (i + 1 < (attempts || 1)) await sleep(2000);
      }
    }
    if (attempts > 1) log(`tray: ${WATCHER_SERVICE} unavailable (${last && last.message}); no indicator`);
    return false;
  }

  // Plasma may start after the daemon, and restarts the watcher on reconfigure.
  register(15).catch(() => {});
  try {
    bus.addMatch("type='signal',sender='org.freedesktop.DBus',member='NameOwnerChanged'");
    bus.on('message', (msg) => {
      if (!msg || msg.member !== 'NameOwnerChanged') return;
      if (msg.body && msg.body[0] === WATCHER_SERVICE && msg.body[2]) register(1).catch(() => {});
    });
  } catch {}

  function refresh() {
    if (refreshing) return;
    refreshing = setTimeout(() => {
      refreshing = null;
      revision++;
      try { menuIface.LayoutUpdated(revision, 0); } catch {}
    }, 500);
    if (refreshing.unref) refreshing.unref();
  }

  return {
    name,
    menuPath: MENU_PATH,
    itemPath: ITEM_PATH,
    refresh,
    registered: () => registered,
    menu: () => rebuild(),
    stop() {
      if (refreshing) { clearTimeout(refreshing); refreshing = null; }
      try { bus.unexport(ITEM_PATH); } catch {}
      try { bus.unexport(MENU_PATH); } catch {}
      try { bus.releaseName(name); } catch {}
    },
  };
}

/**
 * Text for `shmakk windows-daemon --tray-check`: is an indicator on the panel?
 */
async function describeTray(bus, Message, expected) {
  const name = expected || itemName();
  const lines = [];
  try {
    // dbus-next does not populate proxy properties, so ask for it directly.
    const reply = await bus.call(new Message({
      destination: WATCHER_SERVICE,
      path: WATCHER_PATH,
      interface: 'org.freedesktop.DBus.Properties',
      member: 'Get',
      signature: 'ss',
      body: [WATCHER_SERVICE, 'RegisteredStatusNotifierItems'],
    }));
    const items = (reply.body && reply.body[0] && reply.body[0].value) || [];
    const ours = items.find((i) => String(i).startsWith(name));
    lines.push(`item:   ${name}`);
    lines.push(`panel:  ${ours ? `registered (${ours})` : 'not registered'}`);
    lines.push(`total:  ${items.length} indicators on the panel`);
  } catch (e) {
    lines.push(`panel:  ${WATCHER_SERVICE} not reachable (${e.message})`);
  }
  return lines;
}

module.exports = {
  ITEM_PATH,
  MENU_PATH,
  ICON,
  WATCHER_SERVICE,
  WATCHER_PATH,
  ITEM_ID,
  ID,
  WINDOW_BASE,
  MUTED_BASE,
  MODES,
  itemName,
  buildMenu,
  indexMenu,
  propsFor,
  layoutTuple,
  findNode,
  focusScript,
  startTray,
  describeTray,
};
