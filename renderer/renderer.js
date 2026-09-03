const statusBar = document.getElementById('status-bar');
const searchBox = document.getElementById('search-box');
const resultCount = document.getElementById('result-count');
const results = document.getElementById('results');
const browsePanel = document.getElementById('browse-panel');
const listHead = document.getElementById('list-head');
const addressBar = document.getElementById('address-bar');
const recentTabBtn = document.getElementById('recent-tab-btn');
const recentPanel = document.getElementById('recent-panel');
const recoveryTabBtn = document.getElementById('recovery-tab-btn');
const recoveryPanel = document.getElementById('recovery-panel');
const settingsTabBtn = document.getElementById('settings-tab-btn');
const settingsPanel = document.getElementById('settings-panel');
const backBtn = document.getElementById('nav-back');
const forwardBtn = document.getElementById('nav-forward');
const upBtn = document.getElementById('nav-up');
const wraithHereBtn = document.getElementById('wraith-here-btn');
const breadcrumb = document.getElementById('breadcrumb');
const pathInput = document.getElementById('path-input');
const sidebarItems = document.querySelectorAll('.sidebar-item');

function humanSize(bytes) {
  if (!bytes) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

function humanDate(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const datePart = d.toLocaleDateString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit' });
  const timePart = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return `${datePart} ${timePart}`;
}

// File-type labeling: a category emoji + a colored extension badge per row,
// so a folder full of mixed files scans the way a real file manager's icon
// view does instead of everything looking like flat text. Deliberately a
// closed, hand-picked set of common extensions rather than trying to cover
// everything — an unrecognized extension just falls back to a plain document
// icon with no badge, which is a fine default, not a bug.
const FILE_TYPES = [
  { emoji: '\u{1F5BC}\u{FE0F}', color: '#5b9fff', exts: ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'svg', 'webp', 'ico', 'avif', 'tiff'] },
  { emoji: '\u{1F3AC}', color: '#ff6b6b', exts: ['mp4', 'mkv', 'avi', 'mov', 'webm', 'wmv', 'flv', 'm4v'] },
  { emoji: '\u{1F3B5}', color: '#7fd490', exts: ['mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac', 'wma'] },
  { emoji: '\u{1F5DC}\u{FE0F}', color: '#e0a45c', exts: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz'] },
  { emoji: '\u{1F4E6}', color: '#e0a45c', exts: ['exe', 'msi', 'msix', 'appx'] },
  { emoji: '\u{1F4D5}', color: '#ff8080', exts: ['pdf'] },
  { emoji: '\u{1F4CA}', color: '#7fd490', exts: ['xls', 'xlsx', 'csv', 'ods'] },
  { emoji: '\u{1F4FD}\u{FE0F}', color: '#e0a45c', exts: ['ppt', 'pptx', 'odp'] },
  { emoji: '\u{1F4C4}', color: '#9aa8c4', exts: ['doc', 'docx', 'odt', 'rtf', 'txt', 'md'] },
  { emoji: '\u{1F4BB}', color: '#c9b8ff', exts: ['js', 'ts', 'jsx', 'tsx', 'py', 'java', 'c', 'cpp', 'h', 'hpp', 'cs', 'go', 'rs', 'rb', 'php', 'html', 'htm', 'css', 'scss', 'less', 'json', 'xml', 'yml', 'yaml', 'sh', 'bat', 'ps1', 'sql'] },
  { emoji: '\u{1F524}', color: '#c9b8ff', exts: ['ttf', 'otf', 'woff', 'woff2'] }
];
const EXT_LOOKUP = new Map();
for (const t of FILE_TYPES) for (const e of t.exts) EXT_LOOKUP.set(e, t);
const FOLDER_EMOJI = '\u{1F4C1}';
const GENERIC_FILE_EMOJI = '\u{1F4C4}';

function fileTypeFor(fileName) {
  const dot = fileName.lastIndexOf('.');
  if (dot <= 0 || dot === fileName.length - 1) return null;
  const ext = fileName.slice(dot + 1).toLowerCase();
  const match = EXT_LOOKUP.get(ext);
  return match ? { ext, emoji: match.emoji, color: match.color } : null;
}

function renderTagPills(container, r) {
  container.innerHTML = '';
  for (const t of (r.tags || [])) {
    const pill = document.createElement('span');
    pill.className = 'tag-pill';
    pill.innerHTML = `#${t.replace(/</g, '&lt;')} <span class="tag-remove">×</span>`;
    pill.querySelector('.tag-remove').addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const res = await window.revenant.tagsRemove(r.fileId, t);
      r.tags = res.tags;
      renderTagPills(container, r);
    });
    container.appendChild(pill);
  }
}

// Shared row builder for both search results (label = full path) and
// directory browsing (label = bare file name) — same underlying result
// shape ({fileId, path, isDirectory, size, mtime, tags}) either way, so
// there's no reason to duplicate the row markup, context menu wiring, or
// tag pills between the two modes.
function buildRow(r, label) {
  const row = document.createElement('div');
  row.className = 'row' + (r.isDirectory ? ' dir' : '');
  row.dataset.path = r.path;
  row.dataset.isDir = String(!!r.isDirectory);
  const fileName = r.path.split(/[\\/]/).pop() || label;
  const ft = r.isDirectory ? null : fileTypeFor(fileName);
  const emoji = r.isDirectory ? FOLDER_EMOJI : (ft ? ft.emoji : GENERIC_FILE_EMOJI);
  const extBadge = ft ? `<span class="ext-badge" style="color:${ft.color};border-color:${ft.color}66">${ft.ext.toUpperCase()}</span>` : '';
  row.innerHTML = `
    <span class="tag">${emoji}</span>
    <span class="path">${label.replace(/</g, '&lt;')}</span>
    ${extBadge}
    <span class="tag-pills"></span>
    ${r.seanceProject ? `<span class="seance-badge" title="Tracked by Séance as &quot;${r.seanceProject.replace(/"/g, '')}&quot;">${r.seanceProject.replace(/</g, '&lt;')}</span>` : ''}
    <span class="modified">${humanDate(r.mtime)}</span>
    <span class="size">${humanSize(r.size)}</span>
  `;
  renderTagPills(row.querySelector('.tag-pills'), r);
  row.addEventListener('dblclick', () => {
    // Directories navigate inside Revenant's own browse view — Revenant is
    // meant to replace the stock file explorer, not hand off to it the
    // moment you go two levels deep.
    if (r.isDirectory) { searchBox.value = ''; navigateTo(r.path); }
    else window.revenant.openPath(r.path);
  });
  row.addEventListener('contextmenu', (ev) => {
    ev.preventDefault();
    showContextMenu(ev.clientX, ev.clientY, r, row.querySelector('.tag-pills'));
  });
  return row;
}

function renderResults(list) {
  results.innerHTML = '';
  if (list.length === 0) {
    results.innerHTML = '<div class="empty">No matches</div>';
    return;
  }
  const frag = document.createDocumentFragment();
  for (const r of list) frag.appendChild(buildRow(r, r.path));
  results.appendChild(frag);
}

let lastBrowseCount = 0;
function renderBrowseEntries(list) {
  browsePanel.innerHTML = '';
  lastBrowseCount = list.length;
  if (list.length === 0) {
    browsePanel.innerHTML = '<div class="empty">This folder is empty</div>';
    return;
  }
  const frag = document.createDocumentFragment();
  for (const r of list) frag.appendChild(buildRow(r, r.name));
  browsePanel.appendChild(frag);
}

// Whole-drive "Recent" view — reuses buildRow (full path as the label, same
// as search results) so it's just as openable/right-clickable as any other
// listing: double-click opens it, right-click gives Open / Show in Explorer
// / Copy path / Add tag, same as everywhere else in the app.
async function loadRecentPanel() {
  recentPanel.innerHTML = '<div class="empty">Loading…</div>';
  const res = await window.revenant.recentFiles();
  if (res.error) { recentPanel.innerHTML = `<div class="empty">${res.error}</div>`; return; }
  recentPanel.innerHTML = '';
  if (res.results.length === 0) { recentPanel.innerHTML = '<div class="empty">Nothing indexed yet</div>'; return; }
  const frag = document.createDocumentFragment();
  for (const r of res.results) frag.appendChild(buildRow(r, r.path));
  recentPanel.appendChild(frag);
}

function flashMessage(text) {
  const prev = resultCount.textContent;
  resultCount.textContent = text;
  setTimeout(() => { resultCount.textContent = prev; }, 1200);
}

/* ================= result context menu ================= */
const ctxMenu = document.createElement('div');
ctxMenu.id = 'ctx-menu';
ctxMenu.hidden = true;
document.body.appendChild(ctxMenu);

function hideContextMenu() { ctxMenu.hidden = true; }
document.addEventListener('click', hideContextMenu);
document.addEventListener('scroll', hideContextMenu, true);
window.addEventListener('blur', hideContextMenu);

function showContextMenu(x, y, r, tagPillsEl) {
  const items = [
    {
      label: r.isDirectory ? 'Open folder' : 'Open',
      action: () => { if (r.isDirectory) { searchBox.value = ''; navigateTo(r.path); } else window.revenant.openPath(r.path); }
    },
    { label: 'Show in Explorer', action: () => window.revenant.showInFolder(r.path) },
    { label: 'Copy path', action: () => window.revenant.copyText(r.path).then(() => flashMessage('Path copied')) },
    {
      label: 'Open in Wraith here',
      action: () => window.revenant.openInWraith(r.path).then((res) => {
        if (!res.ok) flashMessage(res.error || 'Could not open Wraith');
      })
    },
    {
      label: 'Add tag…',
      // Doesn't close the menu or fire immediately — swaps the menu content
      // into a tag-name input instead. window.prompt() isn't reliably
      // available in Electron, and a themed inline input fits the app
      // better anyway.
      keepOpen: true,
      action: () => showTagInput(tagPillsEl, r)
    }
  ];
  ctxMenu.innerHTML = '';
  for (const item of items) {
    const el = document.createElement('div');
    el.className = 'ctx-item';
    el.textContent = item.label;
    el.addEventListener('click', (ev) => {
      ev.stopPropagation();
      item.action();
      if (!item.keepOpen) hideContextMenu();
    });
    ctxMenu.appendChild(el);
  }
  ctxMenu.hidden = false;
  // Clamp so the menu never renders off the right/bottom edge of the window.
  const rect = ctxMenu.getBoundingClientRect();
  ctxMenu.style.left = `${Math.min(x, window.innerWidth - rect.width - 4)}px`;
  ctxMenu.style.top = `${Math.min(y, window.innerHeight - rect.height - 4)}px`;
}

function showTagInput(tagPillsEl, r) {
  ctxMenu.innerHTML = '<input type="text" id="tag-input" placeholder="tag name, Enter to add">';
  const input = ctxMenu.querySelector('#tag-input');
  input.addEventListener('click', (ev) => ev.stopPropagation());
  input.addEventListener('keydown', async (ev) => {
    if (ev.key === 'Escape') { hideContextMenu(); return; }
    if (ev.key !== 'Enter') return;
    const tag = input.value.trim();
    if (tag) {
      const res = await window.revenant.tagsAdd(r.fileId, tag);
      r.tags = res.tags;
      renderTagPills(tagPillsEl, r);
    }
    hideContextMenu();
  });
  input.focus();
}

/* ================= directory browsing (Explorer replacement) ================= */
let knownFoldersCache = null;
let currentPath = null;
let historyStack = [];
let historyIndex = -1;

function renderBreadcrumb(p) {
  breadcrumb.innerHTML = '';
  breadcrumb.hidden = false;
  pathInput.hidden = true;
  const m = p.match(/^([A-Za-z]):\\?(.*)$/);
  if (!m) { breadcrumb.textContent = p; return; }
  const drive = m[1].toUpperCase();
  const segments = m[2] ? m[2].split('\\').filter(Boolean) : [];

  const addCrumb = (text, fullPath, isLast) => {
    const el = document.createElement('span');
    el.className = 'crumb';
    el.textContent = text;
    if (!isLast) el.addEventListener('click', (ev) => { ev.stopPropagation(); navigateTo(fullPath); });
    breadcrumb.appendChild(el);
  };
  const addSep = () => {
    const sep = document.createElement('span');
    sep.className = 'crumb-sep';
    sep.textContent = '\u203a';
    breadcrumb.appendChild(sep);
  };

  addCrumb(`Local Disk (${drive}:)`, `${drive}:\\`, segments.length === 0);
  let acc = `${drive}:\\`;
  segments.forEach((seg, i) => {
    acc = acc.endsWith('\\') ? `${acc}${seg}` : `${acc}\\${seg}`;
    addSep();
    addCrumb(seg, acc, i === segments.length - 1);
  });
}

breadcrumb.addEventListener('click', (ev) => {
  if (ev.target !== breadcrumb) return; // a .crumb itself already handled its own click
  pathInput.value = currentPath || '';
  breadcrumb.hidden = true;
  pathInput.hidden = false;
  pathInput.focus();
  pathInput.select();
});
pathInput.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') navigateTo(pathInput.value.trim());
  else if (ev.key === 'Escape') renderBreadcrumb(currentPath);
});
pathInput.addEventListener('blur', () => renderBreadcrumb(currentPath));

function updateSidebarActive() {
  const norm = (p) => (p || '').toLowerCase().replace(/\\+$/, '');
  sidebarItems.forEach((btn) => {
    const folder = knownFoldersCache && knownFoldersCache[btn.dataset.folder];
    btn.classList.toggle('active', !!folder && norm(folder) === norm(currentPath));
  });
}

async function navigateTo(targetPath, opts = {}) {
  const res = await window.revenant.browseList(targetPath);
  if (res.error) { flashMessage(res.error); return; }
  currentPath = res.path;
  searchBox.value = '';
  results.hidden = true;
  browsePanel.hidden = false;
  renderBreadcrumb(currentPath);
  renderBrowseEntries(res.entries);
  resultCount.textContent = `${lastBrowseCount} item${lastBrowseCount === 1 ? '' : 's'}`;
  updateSidebarActive();

  if (opts.pushHistory !== false) {
    historyStack = historyStack.slice(0, historyIndex + 1);
    historyStack.push(currentPath);
    historyIndex = historyStack.length - 1;
  }
  backBtn.disabled = historyIndex <= 0;
  forwardBtn.disabled = historyIndex >= historyStack.length - 1;
}

backBtn.addEventListener('click', () => {
  if (historyIndex > 0) { historyIndex--; navigateTo(historyStack[historyIndex], { pushHistory: false }); }
});
forwardBtn.addEventListener('click', () => {
  if (historyIndex < historyStack.length - 1) { historyIndex++; navigateTo(historyStack[historyIndex], { pushHistory: false }); }
});
upBtn.addEventListener('click', () => {
  if (!currentPath) return;
  const m = currentPath.match(/^([A-Za-z]:\\)(.*)$/);
  if (!m) return;
  const rest = m[2].replace(/\\$/, '');
  if (!rest) return; // already at the drive root
  const parts = rest.split('\\');
  parts.pop();
  navigateTo(parts.length ? `${m[1]}${parts.join('\\')}` : m[1]);
});

sidebarItems.forEach((btn) => {
  btn.addEventListener('click', () => {
    const folder = knownFoldersCache && knownFoldersCache[btn.dataset.folder];
    if (folder) navigateTo(folder);
  });
});

wraithHereBtn.addEventListener('click', async () => {
  if (!currentPath) return;
  const res = await window.revenant.openInWraith(currentPath);
  if (!res.ok) flashMessage(res.error || 'Could not open Wraith');
});

/* ================= search ================= */
let debounceTimer = null;
searchBox.addEventListener('input', () => {
  clearTimeout(debounceTimer);
  const q = searchBox.value;
  if (!q.trim()) {
    // Empty query: fall back to whatever folder was last browsed, not an
    // empty screen — search is a filter on top of browsing, not a
    // separate destination.
    results.hidden = true;
    browsePanel.hidden = false;
    resultCount.textContent = currentPath ? `${lastBrowseCount} item${lastBrowseCount === 1 ? '' : 's'}` : '';
    return;
  }
  debounceTimer = setTimeout(async () => {
    const t0 = performance.now();
    const res = await window.revenant.search(q);
    if (res.error) {
      resultCount.textContent = res.error;
      return;
    }
    results.hidden = false;
    browsePanel.hidden = true;
    renderResults(res.results);
    resultCount.textContent = `${res.results.length} results in ${(performance.now() - t0).toFixed(0)}ms`;
  }, 80);
});

window.revenant.onIndexProgress(({ scanned, total }) => {
  const pct = ((scanned / total) * 100).toFixed(0);
  statusBar.textContent = `Indexing C:\\ … ${pct}% (${scanned.toLocaleString()} / ${total.toLocaleString()})`;
});

window.revenant.onIndexDone(async ({ error, stats }) => {
  if (error) {
    statusBar.className = 'error';
    statusBar.textContent = `Indexing failed: ${error} — Revenant needs to run as Administrator to read the volume directly.`;
    return;
  }
  statusBar.className = 'ready';
  statusBar.textContent = `${stats.recordCount.toLocaleString()} files/folders indexed in ${(stats.elapsedMs / 1000).toFixed(2)}s — live`;
  searchBox.disabled = false;
  knownFoldersCache = await window.revenant.knownFolders();
  await navigateTo(knownFoldersCache.desktop);
  searchBox.focus();
});

let liveFlashTimer = null;
window.revenant.onIndexLiveUpdate(({ recordCount }) => {
  statusBar.textContent = `${recordCount.toLocaleString()} files/folders indexed — live (just updated)`;
  clearTimeout(liveFlashTimer);
  liveFlashTimer = setTimeout(() => {
    statusBar.textContent = `${recordCount.toLocaleString()} files/folders indexed — live`;
  }, 1500);
});

/* ================= recovery panel ================= */
function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

async function doRestore(id, btn) {
  btn.disabled = true;
  btn.textContent = 'Restoring…';
  const res = await window.revenant.recoveryRestore(id);
  btn.textContent = res.ok ? 'Restored ✓' : `Failed: ${res.error}`;
  if (res.ok) setTimeout(() => loadRecoveryPanel(), 800);
}

async function loadRecoveryPanel() {
  recoveryPanel.innerHTML = '<div class="empty">Loading…</div>';
  const { files } = await window.revenant.recoveryList();
  if (!files || files.length === 0) {
    recoveryPanel.innerHTML = '<div class="empty">Nothing recovered yet. Files changed or deleted in Desktop/Documents while Revenant is running show up here, recoverable for 24h.</div>';
    return;
  }
  recoveryPanel.innerHTML = '';
  for (const f of files) {
    const { history } = await window.revenant.recoveryHistory(f.originalPath);
    const item = document.createElement('div');
    item.className = 'recovery-item';
    const versionsHtml = history.map((v, i) => `
      <div class="version-row">
        <span class="when">${timeAgo(v.snapshotAt)}</span>
        <span>${i === 0 ? 'latest captured version' : 'earlier version'}</span>
        <button class="restore-btn" data-id="${v.id}">Restore this</button>
      </div>
    `).join('');
    item.innerHTML = `
      <div class="path">${f.originalPath.replace(/</g, '&lt;')}</div>
      <div class="meta">${history.length} version${history.length === 1 ? '' : 's'} kept, last change ${timeAgo(f.snapshotAt)}</div>
      <div class="versions">${versionsHtml}</div>
    `;
    item.querySelectorAll('.restore-btn').forEach((btn) => {
      btn.addEventListener('click', () => doRestore(btn.dataset.id, btn));
    });
    recoveryPanel.appendChild(item);
  }
}

/* ================= settings panel ================= */
async function loadSettingsPanel() {
  settingsPanel.innerHTML = '<div class="empty">Loading…</div>';
  const s = await window.revenant.settingsGet();
  settingsPanel.innerHTML = `
    <div class="settings-section">
      <h3>Startup</h3>
      <label class="settings-checkbox">
        <input type="checkbox" id="start-with-windows" ${s.startWithWindows ? 'checked' : ''}>
        Start Revenant when Windows starts
      </label>
      <p class="settings-hint">Runs minimized to the tray. Press ${(s.summonHotkey || 'Ctrl+Alt+R').replace('CommandOrControl', 'Ctrl')} anytime to show or hide the window.</p>
    </div>
    <div class="settings-section">
      <h3>Watched folders</h3>
      <p class="settings-hint">Files changed or deleted in these folders (and their subfolders) are captured for 24h recovery. Everything else on the drive is searchable but not protected — watching the whole drive would mostly capture noise (build output, caches) nobody wants recovered.</p>
      <div id="folder-list"></div>
      <button id="add-folder-btn">+ Add folder…</button>
    </div>
  `;
  settingsPanel.querySelector('#start-with-windows').addEventListener('change', async (ev) => {
    await window.revenant.settingsSet({ startWithWindows: ev.target.checked });
  });
  const list = settingsPanel.querySelector('#folder-list');
  for (const folder of s.watchedFolders) {
    const row = document.createElement('div');
    row.className = 'folder-row';
    row.innerHTML = `<span class="folder-path">${folder.replace(/</g, '&lt;')}</span><button class="remove-btn">Remove</button>`;
    row.querySelector('.remove-btn').addEventListener('click', async () => {
      await window.revenant.settingsRemoveFolder(folder);
      loadSettingsPanel();
    });
    list.appendChild(row);
  }
  settingsPanel.querySelector('#add-folder-btn').addEventListener('click', async () => {
    await window.revenant.settingsAddFolder();
    loadSettingsPanel();
  });
}

/* ================= panel switching (search+browse / recovery / settings) ================= */
function setActivePanel(name) {
  recentTabBtn.classList.toggle('active', name === 'recent');
  recoveryTabBtn.classList.toggle('active', name === 'recovery');
  settingsTabBtn.classList.toggle('active', name === 'settings');
  const isSearchTab = name === 'search';
  addressBar.hidden = !isSearchTab;
  listHead.hidden = !(isSearchTab || name === 'recent');
  const showingSearchResults = isSearchTab && searchBox.value.trim();
  results.hidden = !(isSearchTab && showingSearchResults);
  browsePanel.hidden = !(isSearchTab && !showingSearchResults);
  recentPanel.hidden = name !== 'recent';
  recoveryPanel.hidden = name !== 'recovery';
  settingsPanel.hidden = name !== 'settings';
  if (name === 'recent') loadRecentPanel();
  if (name === 'recovery') loadRecoveryPanel();
  if (name === 'settings') loadSettingsPanel();
}

let activePanel = 'search';
recentTabBtn.addEventListener('click', () => {
  activePanel = activePanel === 'recent' ? 'search' : 'recent';
  setActivePanel(activePanel);
});
recoveryTabBtn.addEventListener('click', () => {
  activePanel = activePanel === 'recovery' ? 'search' : 'recovery';
  setActivePanel(activePanel);
});
settingsTabBtn.addEventListener('click', () => {
  activePanel = activePanel === 'settings' ? 'search' : 'settings';
  setActivePanel(activePanel);
});
