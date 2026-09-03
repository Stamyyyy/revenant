const statusBar = document.getElementById('status-bar');
const searchBox = document.getElementById('search-box');
const resultCount = document.getElementById('result-count');
const results = document.getElementById('results');
const recoveryTabBtn = document.getElementById('recovery-tab-btn');
const recoveryPanel = document.getElementById('recovery-panel');

function humanSize(bytes) {
  if (!bytes) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

function renderResults(list) {
  results.innerHTML = '';
  if (list.length === 0) {
    results.innerHTML = '<div class="empty">No matches</div>';
    return;
  }
  const frag = document.createDocumentFragment();
  for (const r of list) {
    const row = document.createElement('div');
    row.className = 'row' + (r.isDirectory ? ' dir' : '');
    row.dataset.path = r.path;
    row.dataset.isDir = String(!!r.isDirectory);
    row.innerHTML = `
      <span class="tag">${r.isDirectory ? 'dir' : 'file'}</span>
      <span class="path">${r.path.replace(/</g, '&lt;')}</span>
      <span class="size">${humanSize(r.size)}</span>
    `;
    row.addEventListener('dblclick', () => window.revenant.openPath(r.path));
    row.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      showContextMenu(ev.clientX, ev.clientY, r);
    });
    frag.appendChild(row);
  }
  results.appendChild(frag);
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

function showContextMenu(x, y, r) {
  const items = [
    { label: r.isDirectory ? 'Open folder' : 'Open', action: () => window.revenant.openPath(r.path) },
    { label: 'Show in Explorer', action: () => window.revenant.showInFolder(r.path) },
    { label: 'Copy path', action: () => window.revenant.copyText(r.path).then(() => flashMessage('Path copied')) }
  ];
  ctxMenu.innerHTML = '';
  for (const item of items) {
    const el = document.createElement('div');
    el.className = 'ctx-item';
    el.textContent = item.label;
    el.addEventListener('click', () => { item.action(); hideContextMenu(); });
    ctxMenu.appendChild(el);
  }
  ctxMenu.hidden = false;
  // Clamp so the menu never renders off the right/bottom edge of the window.
  const rect = ctxMenu.getBoundingClientRect();
  ctxMenu.style.left = `${Math.min(x, window.innerWidth - rect.width - 4)}px`;
  ctxMenu.style.top = `${Math.min(y, window.innerHeight - rect.height - 4)}px`;
}

let debounceTimer = null;
searchBox.addEventListener('input', () => {
  clearTimeout(debounceTimer);
  const q = searchBox.value;
  debounceTimer = setTimeout(async () => {
    if (!q.trim()) { results.innerHTML = ''; resultCount.textContent = ''; return; }
    const t0 = performance.now();
    const res = await window.revenant.search(q);
    if (res.error) {
      resultCount.textContent = res.error;
      return;
    }
    renderResults(res.results);
    resultCount.textContent = `${res.results.length} results in ${(performance.now() - t0).toFixed(0)}ms`;
  }, 80);
});

window.revenant.onIndexProgress(({ scanned, total }) => {
  const pct = ((scanned / total) * 100).toFixed(0);
  statusBar.textContent = `Indexing C:\\ … ${pct}% (${scanned.toLocaleString()} / ${total.toLocaleString()})`;
});

window.revenant.onIndexDone(({ error, stats }) => {
  if (error) {
    statusBar.className = 'error';
    statusBar.textContent = `Indexing failed: ${error} — Revenant needs to run as Administrator to read the volume directly.`;
    return;
  }
  statusBar.className = 'ready';
  statusBar.textContent = `${stats.recordCount.toLocaleString()} files/folders indexed in ${(stats.elapsedMs / 1000).toFixed(2)}s — live`;
  searchBox.disabled = false;
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

let recoveryActive = false;
recoveryTabBtn.addEventListener('click', () => {
  recoveryActive = !recoveryActive;
  recoveryTabBtn.classList.toggle('active', recoveryActive);
  results.hidden = recoveryActive;
  recoveryPanel.hidden = !recoveryActive;
  if (recoveryActive) loadRecoveryPanel();
});
