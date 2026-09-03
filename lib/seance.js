// Read-only integration with Séance's project registry. Revenant runs as a
// native Windows process; Séance's CLI is npm-linked inside WSL — so this
// shells out through wsl.exe rather than touching Séance's userData files
// directly. That's a deliberate boundary, not a shortcut: `seance status`
// is the CLI's own documented, stable-ish interface, and Séance's own
// codebase is being actively worked on elsewhere, so nothing here reads or
// writes anything except that one command's stdout.
//
// Séance's CLI has no machine-readable output mode (no --json), so this
// parses its plain-text "status" listing with a narrow regex matched only
// against each project's header line ("name  (path)"). If Séance's output
// format ever changes enough to break that, getTrackedFolders() just
// returns an empty list — badges quietly disappear, nothing crashes.
const { execFile } = require('child_process');

const HEADER_RE = /^(\S+)\s+\(([^)]+)\)$/;

function wslPathToWindows(p) {
  const m = p.match(/^\/mnt\/([a-z])\/(.*)$/i);
  if (!m) return null; // a purely-WSL-side path (e.g. /home/...) has no Windows equivalent to match against
  return `${m[1].toUpperCase()}:\\${m[2].replace(/\//g, '\\')}`;
}

// Calls back with an array of { name, winPath } — one per Séance-tracked
// project that actually lives somewhere Revenant's own C: index can see.
function getTrackedFolders(callback) {
  // Absolute path, not a bare "seance" — a non-interactive login shell
  // launched this way doesn't reliably source the .bashrc line that puts
  // npm's global bin dir on PATH (confirmed: bare "seance" failed with
  // "command not found" here despite resolving fine in an interactive shell).
  execFile('wsl.exe', ['-e', 'bash', '-lc', '/home/stam/.npm-global/bin/seance status'], { timeout: 8000 }, (err, stdout) => {
    if (err || !stdout) { callback([]); return; }
    const folders = [];
    for (const line of stdout.split('\n')) {
      const m = line.match(HEADER_RE);
      if (!m) continue;
      const winPath = wslPathToWindows(m[2]);
      if (winPath) folders.push({ name: m[1], winPath });
    }
    callback(folders);
  });
}

module.exports = { getTrackedFolders };
