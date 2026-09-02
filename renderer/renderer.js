const statusBar = document.getElementById('status-bar');
const searchBox = document.getElementById('search-box');
const resultCount = document.getElementById('result-count');
const results = document.getElementById('results');

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
    row.innerHTML = `
      <span class="tag">${r.isDirectory ? 'dir' : 'file'}</span>
      <span class="path">${r.path.replace(/</g, '&lt;')}</span>
      <span class="size">${humanSize(r.size)}</span>
    `;
    frag.appendChild(row);
  }
  results.appendChild(frag);
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
  statusBar.textContent = `${stats.recordCount.toLocaleString()} files/folders indexed in ${(stats.elapsedMs / 1000).toFixed(2)}s`;
  searchBox.disabled = false;
  searchBox.focus();
});
