// shmakk Browser Automator extension — background service worker
// Maintains the WebSocket connection to the shmakk browser-daemon
// and relays messages between content scripts and the server.

let ws = null;
let wsOpen = false;
let port = 3947; // default browser-daemon port
let reconnectTimer = null;
let connectedTabs = new Set(); // tab IDs that have an active automator content script

// Load saved port from storage. Keep the old key as a migration fallback.
chrome.storage.local.get(['browserAutomatorPort', 'vibeditPort'], (data) => {
  if (data['browserAutomatorPort']) port = data['browserAutomatorPort'];
  else if (data['vibeditPort']) port = data['vibeditPort'];
  connect();
});

function connect() {
  if (ws) {
    try { ws.close(); } catch {}
  }
  ws = new WebSocket(`ws://127.0.0.1:${port}`);

  ws.onopen = () => {
    wsOpen = true;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    // Notify all active tabs that the connection is live
    broadcastToAll({ type: 'connected' });
    sendActiveTabStatus();
  };

  ws.onclose = () => {
    wsOpen = false;
    broadcastToAll({ type: 'disconnected' });
    if (!reconnectTimer) reconnectTimer = setTimeout(connect, 1500);
  };

  ws.onerror = () => {
    // onclose fires after onerror, reconnect handled there
  };

  ws.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }

    if (msg.type === 'hello') {
      // Forward model/vision info to all tabs
      broadcastToAll(msg);
      return;
    }

    if (msg.type === 'automationResult' || msg.type === 'error' ||
        msg.type === 'status' || msg.type === 'executeActions') {
      broadcastToAll(msg);
    }
  };
}

function broadcastToAll(msg) {
  for (const tabId of connectedTabs) {
    chrome.tabs.sendMessage(tabId, msg).catch(() => {});
  }
}

function send(msg) {
  if (wsOpen) {
    try { ws.send(JSON.stringify(msg)); } catch {}
  }
}

async function activeTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs && tabs[0] ? tabs[0] : null;
}

async function sendActiveTabStatus() {
  if (!wsOpen) return;
  const tab = await activeTab().catch(() => null);
  if (!tab) return;
  send({
    type: 'tabStatus',
    tab: {
      id: tab.id,
      url: tab.url || '',
      title: tab.title || '',
      windowId: tab.windowId,
      groupId: tab.groupId,
    },
  });
}

async function executeTabAction(action, senderTabId) {
  const tab = senderTabId ? await chrome.tabs.get(senderTabId).catch(() => null) : await activeTab();
  const tabId = tab && tab.id;
  switch (action.action) {
    case 'newTab': {
      const created = await chrome.tabs.create({ url: action.url || 'about:blank', active: action.active !== false });
      return { ok: true, tabId: created.id, url: created.url };
    }
    case 'reload': {
      if (!tabId) throw new Error('No active tab to reload');
      await chrome.tabs.reload(tabId);
      return { ok: true, tabId };
    }
    case 'closeTab': {
      if (!tabId) throw new Error('No active tab to close');
      await chrome.tabs.remove(tabId);
      return { ok: true, tabId };
    }
    case 'switchTab': {
      const target = action.tabId || tabId;
      if (!target) throw new Error('tabId required');
      await chrome.tabs.update(target, { active: true });
      return { ok: true, tabId: target };
    }
    case 'createGroup': {
      if (!tabId) throw new Error('No active tab to group');
      const groupId = await chrome.tabs.group({ tabIds: [tabId] });
      const update = {};
      if (action.title) update.title = String(action.title);
      if (action.color) update.color = String(action.color);
      if (Object.keys(update).length) await chrome.tabGroups.update(groupId, update);
      return { ok: true, groupId, tabId };
    }
    case 'moveToGroup': {
      if (!tabId) throw new Error('No active tab to move');
      if (action.groupId == null) throw new Error('groupId required');
      const groupId = await chrome.tabs.group({ tabIds: [tabId], groupId: action.groupId });
      return { ok: true, groupId, tabId };
    }
    case 'ungroup': {
      if (!tabId) throw new Error('No active tab to ungroup');
      await chrome.tabs.ungroup(tabId);
      return { ok: true, tabId };
    }
    default:
      throw new Error(`Unknown tab action: ${action.action}`);
  }
}

// Listen for messages from content scripts
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab ? sender.tab.id : null;

  if (msg.type === 'register') {
    if (tabId) connectedTabs.add(tabId);
    // If we are connected, tell the tab right away
    if (wsOpen) {
      sendResponse({ connected: true, port, tabId });
      sendActiveTabStatus();
    } else {
      sendResponse({ connected: false, port, tabId });
    }
    return true; // keep channel open for async response
  }

  if (msg.type === 'unregister') {
    if (tabId) connectedTabs.delete(tabId);
    return;
  }

  // Forward messages to the control server
  if (msg.type === 'automation') {
    send(msg);
    return;
  }

  if (msg.type === 'executeTabAction') {
    executeTabAction(msg.action || {}, tabId)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  // Handle screenshot requests locally (chrome.tabs.captureVisibleTab)
  if (msg.type === 'captureScreenshot') {
    chrome.tabs.captureVisibleTab(null, { format: 'jpeg', quality: 60 }, (dataUrl) => {
      if (chrome.runtime.lastError) {
        sendResponse({ error: chrome.runtime.lastError.message });
        return;
      }
      // dataUrl is "data:image/jpeg;base64,..." — extract base64
      const b64 = dataUrl.split(',')[1] || '';
      sendResponse({ data: b64 });
    });
    return true; // async
  }
});

// Clean up disconnected tabs
chrome.tabs.onRemoved.addListener((tabId) => {
  connectedTabs.delete(tabId);
  const prefix = `browserAutomator:${tabId}:`;
  chrome.storage.local.get(null, (items) => {
    const keys = Object.keys(items || {}).filter((key) => key.startsWith(prefix));
    if (keys.length) chrome.storage.local.remove(keys);
  });
});

// Watch for port changes from popup or options
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes['browserAutomatorPort'] || changes['vibeditPort'])) {
    port = (changes['browserAutomatorPort'] || changes['vibeditPort']).newValue;
    connect();
  }
});
