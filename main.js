const { app, BrowserWindow, Tray, Menu, globalShortcut, nativeImage, ipcMain, shell, clipboard, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const mft = require('./lib/mft');
const { createSnapshotStore, DEBOUNCE_MS } = require('./lib/snapshots');
const { loadSettings, saveSettings } = require('./lib/settings');
const { createTagStore } = require('./lib/tags');
const seanceIntegration = require('./lib/seance');

// Electron's default File/Edit/View/Window/Help menu bar renders as plain
// unthemed OS chrome above the page — nothing in renderer/style.css can
// touch it. Revenant doesn't use it (no keyboard-menu-driven actions), so
// killing it outright removes one of the two "still white" bars.
Menu.setApplicationMenu(null);

let win = null;
let tray = null;
let isQuitting = false; // set once the tray's Quit item (or OS shutdown) actually wants the app gone — the window's own close ('X') button hides to tray instead, same convention as Wraith/Specter/Phantom

// The volume handle stays open for the app's lifetime — live updates poll
// the USN journal against this same handle, and layout (geometry + $MFT
// data runs) is reused for re-reading individual records after a change.
let volumeHandle = null;
let layout = null;
let driveIndex = null;
let driveChildrenIndex = null; // parentRecordNum -> Set<recordNum>, for directory listing (see lib/mft.js)
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
let tagStore = null;

// ---- Séance integration (read-only, badges only) ----
// See lib/seance.js for why this shells out to the CLI through wsl.exe
// instead of reading Séance's own userData files directly.
let seanceProjectFolders = []; // [{ name, winPath }]
function refreshSeanceProjects() {
  seanceIntegration.getTrackedFolders((folders) => { seanceProjectFolders = folders; });
}
function seanceProjectForPath(p) {
  const lower = p.toLowerCase();
  for (const f of seanceProjectFolders) {
    const prefix = f.winPath.toLowerCase() + '\\';
    if (lower === f.winPath.toLowerCase() || lower.startsWith(prefix)) return f.name;
  }
  return null;
}

function recomputeWatchedFoldersLower() {
  watchedFoldersLower = settings.watchedFolders.map((p) => p.toLowerCase() + path.sep);
}

function isUnderWatchedFolder(filePath) {
  const lower = filePath.toLowerCase();
  return watchedFoldersLower.some((f) => lower.startsWith(f));
}

// win.isDestroyed() alone isn't a sufficient guard: a GPU process crash (or
// the window being hidden right as a send fires) can leave the render frame
// briefly unreachable while the BrowserWindow wrapper itself still reports
// not-destroyed — observed directly as a repeating "Render frame was
// disposed before WebFrameMain could be accessed" log spam once the window
// started hiding-to-tray instead of being destroyed on close. Checking
// webContents.isDestroyed() too, plus a try/catch as a last resort, turns
// that into "skip this one send" instead of noise on every poll tick.
function sendToRenderer(channel, payload) {
  if (!win || win.isDestroyed() || !win.webContents || win.webContents.isDestroyed()) return;
  try {
    win.webContents.send(channel, payload);
  } catch (err) {}
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
    const scanResult = mft.scanIndex(volumeHandle, layout, (scanned, total) => {
      sendToRenderer('index-progress', { scanned, total });
    });
    driveIndex = scanResult.index;
    driveChildrenIndex = scanResult.childrenIndex;
    indexingStats = {
      recordCount: driveIndex.size,
      totalRecords: layout.totalRecords,
      elapsedMs: Date.now() - t0,
      corruptRecords: scanResult.corruptRecords || 0
    };
    startSafetyNet();
    startLiveUpdates();
  } catch (err) {
    // Most likely cause: the app isn't running elevated. Raw volume access
    // (\\.\C:) requires it — this isn't optional the way it is for a normal
    // file browser, since without it there's no whole-drive index to search.
    indexError = String(err && err.message || err);
  }
  sendToRenderer('index-done', { error: indexError, stats: indexingStats });
}

const DEFAULT_HOTKEY = 'CommandOrControl+Alt+R';

// Loaded early (before window/tray/hotkey creation, which all depend on it)
// rather than as part of startSafetyNet, which used to load it — that ran
// after the window/tray already existed, too late for startWithWindows and
// the hotkey to take effect on this launch.
function loadAppSettings() {
  settingsPath = path.join(app.getPath('userData'), 'settings.json');
  settings = loadSettings(settingsPath, {
    watchedFolders: [app.getPath('desktop'), app.getPath('documents')],
    summonHotkey: DEFAULT_HOTKEY,
    startWithWindows: false
  });
  recomputeWatchedFoldersLower();
}

function startSafetyNet() {
  snapshotStore = createSnapshotStore(path.join(app.getPath('userData'), 'snapshots'));
  snapshotStore.purgeExpired();
  setInterval(() => snapshotStore.purgeExpired(), 60 * 60 * 1000);
  tagStore = createTagStore(path.join(app.getPath('userData'), 'tags.json'));
}

function startLiveUpdates() {
  const journal = mft.ensureUsnJournal(volumeHandle);
  journalId = journal.journalId;
  usnCursor = journal.nextUsn; // only care about changes from this point on — the scan above already reflects everything before it
  pollTimer = setInterval(() => {
    try {
      const { nextUsn, changedCount, records } = mft.pollUsnJournal(volumeHandle, layout, journalId, usnCursor, driveIndex, driveChildrenIndex, 'C');
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

      if (changedCount > 0) {
        sendToRenderer('index-live-update', { changedCount, recordCount: driveIndex.size });
      }
    } catch (err) {
      // A single failed poll (e.g. a transient volume hiccup) shouldn't kill
      // the whole live-update loop — just skip this tick and try again next.
    }
  }, POLL_INTERVAL_MS);
}

app.on('before-quit', () => {
  isQuitting = true;
  if (pollTimer) clearInterval(pollTimer);
  if (volumeHandle !== null) mft.closeVolume(volumeHandle);
});

ipcMain.handle('search-query', (e, query) => {
  if (!driveIndex) return { error: indexError || 'index not ready' };
  const q = (query || '').trim();
  if (!q) return { results: [] };

  let results;
  if (q.startsWith('#') && q.length > 1) {
    // Tag search: exact tag match, not substring — tags are a small,
    // deliberately-chosen set per file, not free text to fuzzy-match.
    const tag = q.slice(1);
    const { results: r, staleFileIds } = mft.resultsForFileIds(driveIndex, tagStore.fileIdsForTag(tag), 'C', 200);
    if (staleFileIds.length) tagStore.dropStale(staleFileIds);
    results = r;
  } else {
    results = mft.search(driveIndex, q, 'C', 200);
  }

  for (const r of results) {
    r.tags = tagStore.getTags(r.fileId);
    const proj = seanceProjectForPath(r.path);
    if (proj) r.seanceProject = proj;
  }
  return { results };
});

// "Open in Wraith here" — hands a directory to Wraith, which (as of its own
// matching change) opens a new Command Prompt tab there. Hardcoded paths,
// not configurable: this is a personal single-user tool wiring itself to
// another personal single-user tool on the same machine, same assumption
// seance/cli.js already makes for its own cross-project paths. Tries the
// real day-to-day install first, falls back to the dev copy's own build.
const WRAITH_CANDIDATES = [
  'C:\\Users\\stama\\wraith\\dist\\win-unpacked\\Wraith.exe',
  'C:\\Users\\stama\\code\\wraith\\dist\\win-unpacked\\Wraith.exe'
];
ipcMain.handle('open-in-wraith', (e, targetPath) => {
  const wraithExe = WRAITH_CANDIDATES.find((p) => fs.existsSync(p));
  if (!wraithExe) return { ok: false, error: 'Wraith not found' };
  let dir = targetPath;
  try {
    if (!fs.statSync(targetPath).isDirectory()) dir = path.dirname(targetPath);
  } catch (err) {
    dir = path.dirname(targetPath); // path already gone — best effort at its last known parent
  }
  return new Promise((resolve) => {
    const child = execFile(wraithExe, [dir], { detached: true, windowsHide: false });
    let settled = false;
    child.once('error', (err) => {
      if (settled) return;
      settled = true;
      resolve({ ok: false, error: String(err && err.message || err) });
    });
    // Wraith is a detached, long-running GUI app — don't wait for it to
    // exit, that could be hours. A spawn failure (missing exe, blocked by
    // antivirus, etc.) surfaces via 'error' almost immediately; give that a
    // short window, then treat silence as success.
    setTimeout(() => {
      if (settled) return;
      settled = true;
      child.unref();
      resolve({ ok: true });
    }, 300);
  });
});

// Sidebar quick-access shortcuts — same set stock Explorer shows by default,
// resolved via Electron's own app.getPath() rather than hardcoded, so they're
// correct for whatever account this runs under.
ipcMain.handle('known-folders', () => ({
  desktop: app.getPath('desktop'),
  downloads: app.getPath('downloads'),
  documents: app.getPath('documents'),
  pictures: app.getPath('pictures'),
  music: app.getPath('music'),
  videos: app.getPath('videos'),
  thisPC: 'C:\\'
}));

// Directory browsing: lists the direct children of a folder path (defaults
// to the drive root). Breadcrumbs, double-click-to-descend, back/forward and
// a typed address bar in the renderer all funnel through this one handler —
// they only differ in which path string they pass, browse-list resolves it
// to a record fresh each call rather than the renderer tracking record
// numbers itself.
ipcMain.handle('browse-list', (e, targetPath) => {
  if (!driveIndex) return { error: indexError || 'index not ready' };
  const p = (targetPath && targetPath.trim()) || 'C:\\';
  const recordNum = mft.recordNumForPath(driveIndex, driveChildrenIndex, 'C', p);
  if (recordNum === null) return { error: `Not found: ${p}` };
  const normalizedPath = recordNum === 5 ? 'C:\\' : mft.resolvePath(driveIndex, recordNum, 'C');
  if (!normalizedPath) return { error: 'That folder no longer exists' };
  const entries = mft.listChildren(driveIndex, driveChildrenIndex, recordNum, normalizedPath);
  for (const en of entries) {
    en.tags = tagStore.getTags(en.fileId);
    const proj = seanceProjectForPath(en.path);
    if (proj) en.seanceProject = proj;
  }
  return { path: normalizedPath, recordNum, entries };
});

ipcMain.handle('recent-files', () => {
  if (!driveIndex) return { error: indexError || 'index not ready' };
  const results = mft.recentFiles(driveIndex, 'C', 100);
  for (const r of results) {
    r.tags = tagStore.getTags(r.fileId);
    const proj = seanceProjectForPath(r.path);
    if (proj) r.seanceProject = proj;
  }
  return { results };
});

ipcMain.handle('tags-add', (e, { fileId, tag }) => ({ tags: tagStore.addTag(fileId, tag) }));
ipcMain.handle('tags-remove', (e, { fileId, tag }) => ({ tags: tagStore.removeTag(fileId, tag) }));
ipcMain.handle('tags-all', () => ({ tags: tagStore.allTags() }));

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

// No icon.ico exists for Revenant yet (Wraith/Phantom each have their own
// under build/) — nativeImage.createFromPath on a missing file returns an
// empty image rather than throwing, so this degrades to Electron/tray
// defaults instead of crashing until one's added.
function appIcon() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.ico'));
  return icon.isEmpty() ? null : icon;
}

function createWindow() {
  const icon = appIcon();
  win = new BrowserWindow({
    width: 900,
    height: 640,
    backgroundColor: '#14141a',
    // Keeps the native minimize/maximize/close buttons (unlike frame:false,
    // which would mean hand-rolling window dragging and those buttons from
    // scratch) but repaints the title bar strip itself to match the theme
    // instead of the default OS white. Windows-only API; other platforms
    // just ignore titleBarOverlay and get the normal title bar.
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#1c1c24', symbolColor: '#c9b8ff', height: 32 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    ...(icon ? { icon } : {})
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // The X button hides to tray, same as Wraith/Specter/Phantom — a search
  // index this expensive to build (raw MFT scan + a live USN journal handle)
  // isn't something you want torn down and rebuilt every time the window is
  // dismissed. Only the tray's own Quit (or an OS shutdown) actually exits.
  win.on('close', (e) => {
    if (isQuitting) return;
    e.preventDefault();
    win.hide();
  });
}

function showWindow() {
  if (!win || win.isDestroyed()) { createWindow(); return; }
  win.show();
  win.focus();
}

function toggleWindow() {
  if (!win || win.isDestroyed()) { createWindow(); return; }
  if (win.isVisible() && !win.isMinimized()) win.hide();
  else showWindow();
}

function createTray() {
  const icon = appIcon();
  tray = new Tray(icon ? icon.resize({ width: 16, height: 16 }) : nativeImage.createEmpty());
  tray.setToolTip('Revenant');
  const menu = Menu.buildFromTemplate([
    { label: 'Show / Hide', click: () => toggleWindow() },
    { type: 'separator' },
    { label: 'Quit', click: () => { isQuitting = true; app.quit(); } }
  ]);
  tray.setContextMenu(menu);
  tray.on('click', () => toggleWindow());
}

ipcMain.handle('settings-set', (e, patch) => {
  settings = Object.assign({}, settings, patch);
  saveSettings(settingsPath, settings);
  if (typeof patch.startWithWindows === 'boolean') {
    app.setLoginItemSettings({ openAtLogin: patch.startWithWindows });
  }
  return settings;
});

// Enforce single instance: a second launch just focuses the existing window
// instead of opening a second raw volume handle + USN journal poll loop
// alongside the first — two of those writing the same snapshot store is a
// real corruption risk, not just wasted resources.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showWindow();
  });

  app.whenReady().then(() => {
    loadAppSettings();
    createWindow();
    createTray();

    globalShortcut.register(settings.summonHotkey || DEFAULT_HOTKEY, () => {
      toggleWindow();
    });

    if (settings.startWithWindows) {
      app.setLoginItemSettings({ openAtLogin: true });
    }

    startIndexing();

    refreshSeanceProjects();
    setInterval(refreshSeanceProjects, 10 * 60 * 1000);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      else showWindow();
    });
  });

  app.on('window-all-closed', () => {
    // Keep running in the tray — same convention as the rest of the family.
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
  });
}
