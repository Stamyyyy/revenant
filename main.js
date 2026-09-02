const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { buildIndex, search } = require('./lib/mft');

let win = null;

// Built once at startup and kept in memory for the life of the app. There's
// no live-update (USN Journal) subsystem yet — see README — so this index
// silently drifts from reality as files change until the app is restarted.
// That's a known, temporary limitation of this build, not the final design.
let driveIndex = null;
let indexError = null;
let indexingStats = null;

function startIndexing() {
  const t0 = Date.now();
  try {
    const { index, totalRecords } = buildIndex('C', (scanned, total) => {
      if (win && !win.isDestroyed()) {
        win.webContents.send('index-progress', { scanned, total });
      }
    });
    driveIndex = index;
    indexingStats = {
      recordCount: index.size,
      totalRecords,
      elapsedMs: Date.now() - t0
    };
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

ipcMain.handle('search-query', (e, query) => {
  if (!driveIndex) return { error: indexError || 'index not ready' };
  if (!query || !query.trim()) return { results: [] };
  const results = search(driveIndex, query.trim(), 'C', 200);
  return { results };
});

ipcMain.handle('index-status', () => {
  if (indexError) return { error: indexError };
  if (!driveIndex) return { indexing: true };
  return { stats: indexingStats };
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
