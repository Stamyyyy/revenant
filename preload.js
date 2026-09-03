const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('revenant', {
  search: (query) => ipcRenderer.invoke('search-query', query),
  browseList: (targetPath) => ipcRenderer.invoke('browse-list', targetPath),
  recentFiles: () => ipcRenderer.invoke('recent-files'),
  knownFolders: () => ipcRenderer.invoke('known-folders'),
  listDrives: () => ipcRenderer.invoke('list-drives'),
  openInWraith: (targetPath) => ipcRenderer.invoke('open-in-wraith', targetPath),
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
  settingsSet: (patch) => ipcRenderer.invoke('settings-set', patch),
  settingsAddFolder: () => ipcRenderer.invoke('settings-add-folder'),
  settingsRemoveFolder: (folder) => ipcRenderer.invoke('settings-remove-folder', folder),
  tagsAdd: (fileId, tag) => ipcRenderer.invoke('tags-add', { fileId, tag }),
  tagsRemove: (fileId, tag) => ipcRenderer.invoke('tags-remove', { fileId, tag }),
  tagsAll: () => ipcRenderer.invoke('tags-all')
});
