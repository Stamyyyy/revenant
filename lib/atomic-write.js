const fs = require('fs');
const path = require('path');

// Writes to a temp file in the same directory, then renames over the target.
// The rename is atomic on NTFS (same-volume MoveFileExW with
// MOVEFILE_REPLACE_EXISTING), so a crash mid-write never leaves the target
// truncated/corrupted — it's either the old content or the new content.
//
// Windows can still throw EPERM/EBUSY on the rename if another process
// (antivirus, Windows Search indexer, OneDrive) briefly holds a handle on
// the destination, so retry a few times before giving up.
function atomicWriteFileSync(targetPath, data) {
  const dir = path.dirname(targetPath);
  const tmpPath = path.join(dir, `.${path.basename(targetPath)}.tmp-${process.pid}-${Date.now()}`);
  fs.writeFileSync(tmpPath, data, 'utf8');

  const maxAttempts = 5;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      fs.renameSync(tmpPath, targetPath);
      return;
    } catch (err) {
      if (attempt === maxAttempts) {
        try { fs.unlinkSync(tmpPath); } catch (e) {}
        throw err;
      }
      const waitMs = 20 * attempt;
      const until = Date.now() + waitMs;
      while (Date.now() < until) {} // brief synchronous busy-wait; these calls are rare and on small files
    }
  }
}

module.exports = { atomicWriteFileSync };
