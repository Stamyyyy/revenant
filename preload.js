const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('revenant', {
  search: (query) => ipcRenderer.invoke('search-query', query),
  indexStatus: () => ipcRenderer.invoke('index-status'),
  onIndexProgress: (cb) => ipcRenderer.on('index-progress', (_e, data) => cb(data)),
  onIndexDone: (cb) => ipcRenderer.on('index-done', (_e, data) => cb(data)),
  onIndexLiveUpdate: (cb) => ipcRenderer.on('index-live-update', (_e, data) => cb(data)),
  recoveryList: () => ipcRenderer.invoke('recovery-list'),
  recoveryHistory: (originalPath) => ipcRenderer.invoke('recovery-history', originalPath),
  recoveryRestore: (id, destPath) => ipcRenderer.invoke('recovery-restore', { id, destPath }),
  openPath: (targetPath) => ipcRenderer.invoke('shell-open-path', targetPath),
  showInFolder: (targetPath) => ipcRenderer.invoke('shell-show-in-folder', targetPath),
  copyText: (text) => ipcRenderer.invoke('clipboard-write-text', text),
  settingsGet: () => ipcRenderer.invoke('settings-get'),
  settingsAddFolder: () => ipcRenderer.invoke('settings-add-folder'),
  settingsRemoveFolder: (folder) => ipcRenderer.invoke('settings-remove-folder', folder)
});
