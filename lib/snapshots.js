// Rolling snapshot store for the delete/edit safety net.
//
// The core idea, worth stating explicitly because it's not the obvious one:
// we do NOT snapshot a file right when we see it change — by the time a USN
// event tells us "this file changed," the new content has already
// overwritten the old, so that would just save the new version again. What
// actually recovers "I overwrote/deleted the wrong thing" is having ALREADY
// captured the file's content at some point BEFORE the bad edit. So every
// detected change (after a short debounce, so we don't copy mid-write)
// appends a new snapshot of current content to that file's timeline — and
// "undo the last edit" means restoring the second-to-last snapshot, not the
// latest one (the latest IS the bad edit). A delete has no new content to
// capture; the most recent snapshot already on file is the recovery point.
//
// Not a perfect point-in-time system — there's a real gap between an edit
// landing and our debounced capture of it — but it directly answers "get
// the last version back," which is what a misclick recovery needs.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { atomicWriteFileSync } = require('./atomic-write');

const RETENTION_MS = 24 * 60 * 60 * 1000;
const DEBOUNCE_MS = 2000;

function createSnapshotStore(baseDir) {
  fs.mkdirSync(baseDir, { recursive: true });
  const metaPath = path.join(baseDir, 'meta.json');

  function load() {
    try { return JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch (e) { return []; }
  }
  let meta = load();
  function save() { atomicWriteFileSync(metaPath, JSON.stringify(meta)); }

  // Captures current content of originalPath. Returns null (not an error —
  // just nothing to do) if the file's already gone by the time we get to it,
  // which legitimately happens: the debounce window is exactly the kind of
  // gap where a quick create-then-delete falls through.
  function snapshotFile(originalPath) {
    let stat;
    try { stat = fs.statSync(originalPath); } catch (e) { return null; }
    if (!stat.isFile()) return null;

    const id = crypto.randomBytes(8).toString('hex');
    try {
      fs.copyFileSync(originalPath, path.join(baseDir, id));
    } catch (e) { return null; }

    const entry = { id, originalPath, size: stat.size, snapshotAt: Date.now() };
    meta.push(entry);
    save();
    return entry;
  }

  function purgeExpired() {
    const cutoff = Date.now() - RETENTION_MS;
    const keep = [];
    for (const entry of meta) {
      if (entry.snapshotAt < cutoff) {
        try { fs.unlinkSync(path.join(baseDir, entry.id)); } catch (e) {}
      } else {
        keep.push(entry);
      }
    }
    meta = keep;
    save();
    sweepOrphanedBlobs();
  }

  // snapshotFile() copies the blob to disk BEFORE recording it in meta — if
  // the process dies in that gap (crash, force-quit, power loss), the blob
  // is left on disk with nothing in meta pointing at it, so it's invisible
  // to the Recovery panel and would otherwise never get cleaned up (the loop
  // above only ever walks meta). Sweep baseDir directly to catch these:
  // anything that isn't meta.json, an in-progress atomic-write temp file, or
  // a live snapshot id gets removed.
  function sweepOrphanedBlobs() {
    const liveIds = new Set(meta.map((e) => e.id));
    let names;
    try { names = fs.readdirSync(baseDir); } catch (e) { return; }
    for (const name of names) {
      if (name === 'meta.json' || name.startsWith('.')) continue;
      if (liveIds.has(name)) continue;
      try { fs.unlinkSync(path.join(baseDir, name)); } catch (e) {}
    }
  }

  // Recovery points for one file, newest first. Skips the newest entry
  // when includeLatest is false — that's the current/bad state, not
  // something to "restore" over itself.
  function historyForPath(originalPath, includeLatest = true) {
    const norm = originalPath.toLowerCase();
    const all = meta.filter((e) => e.originalPath.toLowerCase() === norm).sort((a, b) => b.snapshotAt - a.snapshotAt);
    return includeLatest ? all : all.slice(1);
  }

  // Every file with at least one snapshot, newest change first — the
  // "recently changed/deleted, recoverable" list the UI shows.
  function listTrackedFiles() {
    const byPath = new Map();
    for (const entry of meta) {
      const existing = byPath.get(entry.originalPath);
      if (!existing || entry.snapshotAt > existing.snapshotAt) byPath.set(entry.originalPath, entry);
    }
    return Array.from(byPath.values()).sort((a, b) => b.snapshotAt - a.snapshotAt);
  }

  function restore(id, destPath) {
    const entry = meta.find((e) => e.id === id);
    if (!entry) throw new Error('snapshot not found');
    const dest = destPath || entry.originalPath;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(baseDir, entry.id), dest);
    return dest;
  }

  return { snapshotFile, purgeExpired, historyForPath, listTrackedFiles, restore };
}

module.exports = { createSnapshotStore, RETENTION_MS, DEBOUNCE_MS };
