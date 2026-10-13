const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  openFile: (filters, binary) => ipcRenderer.invoke('open-file', { filters, binary }),
  saveDialog: (name, filters) => ipcRenderer.invoke('save-dialog', { name, filters }),
  writeFile: (path, data) => ipcRenderer.invoke('write-file', { path, data }),
  confirmDiscard: () => ipcRenderer.invoke('confirm-discard'),
  version: () => ipcRenderer.invoke('app-version'),
  setTitle: (t) => ipcRenderer.send('set-title', t),
  reallyClose: () => ipcRenderer.send('really-close'),
  onMenu: (fn) => ipcRenderer.on('menu', (_e, cmd) => fn(cmd)),
  onFileOpened: (fn) => ipcRenderer.on('file-opened', (_e, f) => fn(f)),
});
