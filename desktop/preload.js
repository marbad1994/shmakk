// Narrow, explicit bridge between the page and the desktop shell.
// The page runs with contextIsolation and no Node access.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('shmakkDesktop', {
  platform: process.platform,
  version: process.versions.electron,
  pickFolder: () => ipcRenderer.invoke('shmakk:pick-folder'),
  openExternal: (url) => ipcRenderer.send('shmakk:open-external', String(url)),
  onMenu: (handler) => {
    const listener = (_e, action) => handler(action);
    ipcRenderer.on('shmakk:menu', listener);
    return () => ipcRenderer.removeListener('shmakk:menu', listener);
  },
});
