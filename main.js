const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const mft = require('./lib/mft');

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

function startLiveUpdates() {
  const journal = mft.ensureUsnJournal(volumeHandle);
  journalId = journal.journalId;
  usnCursor = journal.nextUsn; // only care about changes from this point on — the scan above already reflects everything before it
  pollTimer = setInterval(() => {
    try {
      const { nextUsn, changedCount } = mft.pollUsnJournal(volumeHandle, layout, journalId, usnCursor, driveIndex);
      usnCursor = nextUsn;
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
