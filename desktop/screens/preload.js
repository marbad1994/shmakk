const { contextBridge, ipcRenderer } = require('electron');

// Four calls, nothing else: the page never gets Node access.
contextBridge.exposeInMainWorld('screenPriority', {
  state: () => ipcRenderer.invoke('screens:state'),
  set: (order, kscreen) => ipcRenderer.invoke('screens:set', { order, kscreen }),
  reset: () => ipcRenderer.invoke('screens:reset'),
  close: () => ipcRenderer.send('screens:close'),
});
