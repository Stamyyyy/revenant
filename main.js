const { app, BrowserWindow, ipcMain, shell, clipboard, dialog } = require('electron');
const path = require('path');
const mft = require('./lib/mft');
const { createSnapshotStore, DEBOUNCE_MS } = require('./lib/snapshots');
const { loadSettings, saveSettings } = require('./lib/settings');

let win = null;

// The volume handle stays open for the app's lifetime — live updates poll
// the USN journal against this same handle, and layout (geometry + $MFT
// data runs) is reused for re-reading individual records after a change.
let volumeHandle = null;
let layout = null;
let driveIndex = null;
let indexError = null;
let indexingStats = null;

const POLL_INTERVAL_MS = 1000;
let journalId = null;
let usnCursor = null;
let pollTimer = null;

// ---- delete/edit safety net ----
// Watched folders are user-configurable (Settings panel), defaulting to
// Desktop + Documents on first run — not the whole drive, since
// snapshotting every write anywhere (build output, browser cache, game
// saves...) would be both wasteful and mostly noise nobody wants recovered.
let settings = null;
let settingsPath = null;
let watchedFoldersLower = []; // settings.watchedFolders, lowercased + trailing sep, recomputed whenever settings change — cheap prefix checks in the hot poll loop
let snapshotStore = null;
const debounceTimers = new Map(); // path -> Timeout, so a burst of writes to the same file snapshots once, not per-event

function recomputeWatchedFoldersLower() {
  watchedFoldersLower = settings.watchedFolders.map((p) => p.toLowerCase() + path.sep);
}

function isUnderWatchedFolder(filePath) {
  const lower = filePath.toLowerCase();
  return watchedFoldersLower.some((f) => lower.startsWith(f));
}

function scheduleSnapshot(filePath) {
  const existing = debounceTimers.get(filePath);
  if (existing) clearTimeout(existing);
  debounceTimers.set(filePath, setTimeout(() => {
    debounceTimers.delete(filePath);
    snapshotStore.snapshotFile(filePath);
  }, DEBOUNCE_MS));
}

function startIndexing() {
  const t0 = Date.now();
  try {
    volumeHandle = mft.openVolume('C');
    layout = mft.getMftLayout(volumeHandle);
    driveIndex = mft.scanIndex(volumeHandle, layout, (scanned, total) => {
      if (win && !win.isDestroyed()) {
        win.webContents.send('index-progress', { scanned, total });
      }
    });
    indexingStats = {
      recordCount: driveIndex.size,
      totalRecords: layout.totalRecords,
      elapsedMs: Date.now() - t0
    };
    startSafetyNet();
    startLiveUpdates();
  } catch (err) {
    // Most likely cause: the app isn't running elevated. Raw volume access
    // (\\.\C:) requires it — this isn't optional the way it is for a normal
    // file browser, since without it there's no whole-drive index to search.
    indexError = String(err && err.message || err);
  }
  if (win && !win.isDestroyed()) {
    win.webContents.send('index-done', { error: indexError, stats: indexingStats });
  }
}

function startSafetyNet() {
  settingsPath = path.join(app.getPath('userData'), 'settings.json');
  settings = loadSettings(settingsPath, {
    watchedFolders: [app.getPath('desktop'), app.getPath('documents')]
  });
  recomputeWatchedFoldersLower();
  snapshotStore = createSnapshotStore(path.join(app.getPath('userData'), 'snapshots'));
  snapshotStore.purgeExpired();
  setInterval(() => snapshotStore.purgeExpired(), 60 * 60 * 1000);
}

function startLiveUpdates() {
  const journal = mft.ensureUsnJournal(volumeHandle);
  journalId = journal.journalId;
  usnCursor = journal.nextUsn; // only care about changes from this point on — the scan above already reflects everything before it
  pollTimer = setInterval(() => {
    try {
      const { nextUsn, changedCount, records } = mft.pollUsnJournal(volumeHandle, layout, journalId, usnCursor, driveIndex);
      usnCursor = nextUsn;

      // Safety net: for anything that changed (not deleted — nothing to
      // read there) and resolves under a watched folder, debounce a
      // snapshot of its current content. Deletes need no action here; the
      // most recent snapshot already on file (from whenever this file was
      // last edited while it existed) is already the recovery point.
      for (const rec of records) {
        if (rec.isDirectory) continue;
        const currentPath = mft.resolvePath(driveIndex, rec.recordNum, 'C');
        if (!currentPath || !isUnderWatchedFolder(currentPath)) continue;
        scheduleSnapshot(currentPath);
      }

      if (changedCount > 0 && win && !win.isDestroyed()) {
        win.webContents.send('index-live-update', { changedCount, recordCount: driveIndex.size });
      }
    } catch (err) {
      // A single failed poll (e.g. a transient volume hiccup) shouldn't kill
      // the whole live-update loop — just skip this tick and try again next.
    }
  }, POLL_INTERVAL_MS);
}

app.on('before-quit', () => {
  if (pollTimer) clearInterval(pollTimer);
  if (volumeHandle !== null) mft.closeVolume(volumeHandle);
});

ipcMain.handle('search-query', (e, query) => {
  if (!driveIndex) return { error: indexError || 'index not ready' };
  if (!query || !query.trim()) return { results: [] };
  const results = mft.search(driveIndex, query.trim(), 'C', 200);
  return { results };
});

ipcMain.handle('index-status', () => {
  if (indexError) return { error: indexError };
  if (!driveIndex) return { indexing: true };
  return { stats: indexingStats };
});

ipcMain.handle('recovery-list', () => {
  if (!snapshotStore) return { files: [] };
  return { files: snapshotStore.listTrackedFiles() };
});

ipcMain.handle('recovery-history', (e, originalPath) => {
  if (!snapshotStore) return { history: [] };
  return { history: snapshotStore.historyForPath(originalPath) };
});

ipcMain.handle('recovery-restore', (e, { id, destPath }) => {
  try {
    const restoredTo = snapshotStore.restore(id, destPath);
    return { ok: true, restoredTo };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

// A result is only useful if you can actually do something with it once
// you've found it — open it, or jump to it in Explorer for anything that
// needs more than a double-click (rename, drag elsewhere, properties...).
ipcMain.handle('shell-open-path', async (e, targetPath) => {
  const err = await shell.openPath(targetPath); // resolves to '' on success, an error string on failure
  return { ok: !err, error: err || null };
});

ipcMain.handle('shell-show-in-folder', (e, targetPath) => {
  shell.showItemInFolder(targetPath);
  return { ok: true };
});

// Electron's clipboard module (main process) rather than the renderer's
// navigator.clipboard — the web API throws NotAllowedError whenever the
// document isn't focused (confirmed while testing this via CDP, but it's a
// real everyday case too: right-clicking a background/non-focused window),
// and it failed *silently*, no error shown to the user. This has no such
// restriction.
ipcMain.handle('clipboard-write-text', (e, text) => {
  clipboard.writeText(text);
  return { ok: true };
});

ipcMain.handle('settings-get', () => settings || { watchedFolders: [] });

ipcMain.handle('settings-add-folder', async () => {
  const res = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  if (res.canceled || !res.filePaths[0]) return { ok: false, watchedFolders: settings.watchedFolders };
  const folder = res.filePaths[0];
  if (!settings.watchedFolders.some((f) => f.toLowerCase() === folder.toLowerCase())) {
    settings.watchedFolders.push(folder);
    saveSettings(settingsPath, settings);
    recomputeWatchedFoldersLower();
  }
  return { ok: true, watchedFolders: settings.watchedFolders };
});

ipcMain.handle('settings-remove-folder', (e, folder) => {
  settings.watchedFolders = settings.watchedFolders.filter((f) => f !== folder);
  saveSettings(settingsPath, settings);
  recomputeWatchedFoldersLower();
  return { ok: true, watchedFolders: settings.watchedFolders };
});

function createWindow() {
  win = new BrowserWindow({
    width: 900,
    height: 640,
    backgroundColor: '#14141a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  createWindow();
  startIndexing();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
