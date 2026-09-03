// Raw NTFS MFT reader/indexer. Requires the process to be running elevated —
// opening a volume handle (\\.\C:) for raw reads fails with EPERM otherwise.
//
// Gives you, for a whole drive, in one pass: every in-use file/directory
// record's name, its parent record number, and whether it's a directory.
// Full paths are NOT stored per-record (that would be enormous and mostly
// redundant) — they're reconstructed on demand by walking the parent chain,
// which is why every record is kept in memory even though most searches only
// touch a handful of them.

const path = require('path');
const fs = require('fs');
// Node's own fs module, on the Node version Electron currently bundles
// (confirmed on v20.18.3), misclassifies a raw volume handle (\\.\C:) as a
// directory and refuses fs.read/fs.readSync with EISDIR — confirmed absent
// on a standalone Node v24.20.0, so this is a real cross-version behavior
// difference, not a mistake in how the handle is opened. mftvol.node goes
// straight to Win32 CreateFile/ReadFile, bypassing fs (and that check)
// entirely. N-API is ABI-stable, so a build against any Node version's
// headers loads fine here without an Electron-specific rebuild.
const mftvol = require(path.join(__dirname, '..', 'native', 'mftvol', 'build', 'Release', 'mftvol.node'));

const FILE_RECORD_MAGIC = 0x454c4946; // "FILE" little-endian as uint32
const ATTR_STANDARD_INFORMATION = 0x10;
const ATTR_FILE_NAME = 0x30;
const ATTR_DATA = 0x80;
const ATTR_END = 0xFFFFFFFF;
const FLAG_IN_USE = 0x0001;
const FLAG_DIRECTORY = 0x0002;
// FILE_NAME namespace byte: 0=POSIX, 1=Win32, 2=DOS(8.3), 3=Win32+DOS.
// A file with a long name gets two $FILE_NAME attributes (Win32 + DOS short
// name); we only want the human-readable one, so DOS-only entries are skipped.
const NAMESPACE_DOS = 2;

// NTFS FILETIME: 100ns intervals since 1601-01-01. 11644473600000 is the ms
// offset between that epoch and Unix epoch (1970-01-01).
function filetimeToMs(filetime) {
  return Number(filetime / 10000n) - 11644473600000;
}

function readAligned(handle, offset, length) {
  // Raw volume reads must land on sector-aligned offsets/lengths or Windows
  // returns an error — every call site here already deals in sector/cluster
  // multiples, so this is just documentation, not a fixup.
  return mftvol.readVolume(handle, offset, length);
}

function applyFixup(recBuf, bytesPerSector) {
  const usaOffset = recBuf.readUInt16LE(0x04);
  const usaSize = recBuf.readUInt16LE(0x06);
  const signature = recBuf.readUInt16LE(usaOffset);
  for (let i = 1; i < usaSize; i++) {
    const sectorEnd = i * bytesPerSector - 2;
    if (sectorEnd + 2 > recBuf.length) break;
    if (recBuf.readUInt16LE(sectorEnd) !== signature) return false; // corrupt/torn record
    recBuf.writeUInt16LE(recBuf.readUInt16LE(usaOffset + i * 2), sectorEnd);
  }
  return true;
}

// Parses an NTFS data-run list (the run-length-encoded cluster-extent list
// that non-resident attributes use to say where their data actually lives on
// disk). $MFT itself is a regular file this way — it is NOT guaranteed to be
// one contiguous run, and on any volume that's seen real use it usually
// isn't, so this is required, not an optimization.
function parseDataRuns(buf, offset) {
  const runs = [];
  let pos = offset;
  let vcn = 0n;
  let lcn = 0n;
  while (pos < buf.length) {
    const header = buf.readUInt8(pos);
    if (header === 0) break;
    pos += 1;
    const lengthBytes = header & 0x0F;
    const offsetBytes = (header >> 4) & 0x0F;

    let length = 0n;
    for (let i = lengthBytes - 1; i >= 0; i--) length = (length << 8n) | BigInt(buf.readUInt8(pos + i));
    pos += lengthBytes;

    let startLcn = null;
    if (offsetBytes > 0) {
      let raw = 0n;
      for (let i = offsetBytes - 1; i >= 0; i--) raw = (raw << 8n) | BigInt(buf.readUInt8(pos + i));
      const bits = BigInt(offsetBytes * 8);
      if (raw >= (1n << (bits - 1n))) raw -= (1n << bits); // sign-extend
      pos += offsetBytes;
      lcn += raw;
      startLcn = lcn;
    } // else: sparse run, no physical clusters — leave startLcn null

    runs.push({ startVcn: vcn, lengthClusters: length, startLcn });
    vcn += length;
  }
  return runs;
}

function readVolumeGeometry(handle) {
  const boot = readAligned(handle, 0, 512);
  if (boot.toString('ascii', 3, 7) !== 'NTFS') throw new Error('not an NTFS volume');
  const bytesPerSector = boot.readUInt16LE(0x0B);
  const sectorsPerCluster = boot.readUInt8(0x0D);
  const clusterSize = bytesPerSector * sectorsPerCluster;
  const mftStartLcn = boot.readBigUInt64LE(0x30);
  const mftOffset = mftStartLcn * BigInt(clusterSize);

  const rawRecordSize = boot.readInt8(0x40);
  const recordSize = rawRecordSize > 0 ? rawRecordSize * clusterSize : 2 ** (-rawRecordSize);

  return { bytesPerSector, clusterSize, mftOffset, recordSize };
}

// Parses one already-fixed-up MFT record. Returns null for records we don't
// care about indexing (not in use, or no usable $FILE_NAME).
function parseRecord(recBuf, recordSize) {
  if (recBuf.readUInt32LE(0) !== FILE_RECORD_MAGIC) return null;
  const flags = recBuf.readUInt16LE(0x16);
  if (!(flags & FLAG_IN_USE)) return null;

  const attrOffset = recBuf.readUInt16LE(0x14);
  let pos = attrOffset;
  let best = null; // prefer Win32 namespace over DOS-only
  let dataSize = null; // real size of the (resident-header-visible) unnamed $DATA attribute, if resident or non-resident
  let mtime = null; // last-modification time from $STANDARD_INFORMATION, ms since Unix epoch

  while (pos + 8 <= recordSize) {
    const attrType = recBuf.readUInt32LE(pos);
    if (attrType === ATTR_END) break;
    const attrLen = recBuf.readUInt32LE(pos + 4);
    if (attrLen <= 0 || pos + attrLen > recordSize) break;
    const nonResident = recBuf.readUInt8(pos + 8);

    if (attrType === ATTR_STANDARD_INFORMATION && nonResident === 0) {
      const contentOffset = recBuf.readUInt16LE(pos + 0x14);
      const c = pos + contentOffset;
      // $STANDARD_INFORMATION content: 0x00 creation time, 0x08 last
      // modification time, 0x10 last MFT change time, 0x18 last access time
      // (all 8-byte FILETIMEs) — modification time is what a file browser's
      // "Date modified" column means.
      mtime = filetimeToMs(recBuf.readBigUInt64LE(c + 0x08));
    } else if (attrType === ATTR_FILE_NAME && nonResident === 0) {
      const contentOffset = recBuf.readUInt16LE(pos + 0x14);
      const c = pos + contentOffset;
      const parentRef = recBuf.readBigUInt64LE(c + 0x00);
      const parentRecordNum = Number(parentRef & 0xFFFFFFFFFFFFn);
      const realSize = recBuf.readBigUInt64LE(c + 0x48);
      const nameLen = recBuf.readUInt8(c + 0x40);
      const namespace = recBuf.readUInt8(c + 0x41);
      const name = recBuf.slice(c + 0x42, c + 0x42 + nameLen * 2).toString('utf16le');
      if (namespace !== NAMESPACE_DOS && (!best || namespace !== NAMESPACE_DOS)) {
        best = { name, parentRecordNum, size: Number(realSize) };
      }
    } else if (attrType === ATTR_DATA && recBuf.readUInt8(pos + 9) === 0 /* unnamed */) {
      dataSize = nonResident
        ? Number(recBuf.readBigUInt64LE(pos + 0x30))
        : recBuf.readUInt32LE(pos + 0x10);
    }

    pos += attrLen;
  }

  if (!best) return null;
  return {
    name: best.name,
    parentRecordNum: best.parentRecordNum,
    isDirectory: !!(flags & FLAG_DIRECTORY),
    size: best.isDirectory ? 0 : (dataSize != null ? dataSize : best.size),
    mtime,
    // Bumped every time this MFT slot is reused for a new file after the
    // previous occupant was deleted — see fileId() below for why this
    // matters beyond just debugging.
    seq: recBuf.readUInt16LE(0x10)
  };
}

// A record number alone is NOT a stable identity: NTFS reuses a freed MFT
// slot for a completely unrelated future file once the original is
// deleted. (recordNum, sequenceNumber) together is the actual stable file
// reference NTFS itself uses — this is what anything that needs to survive
// across index updates (tags, in particular) must key on, not recordNum by
// itself.
function fileId(recordNum, seq) {
  return `${recordNum}:${seq}`;
}

// childrenIndex: Map<parentRecordNum, Set<recordNum>> — the piece the
// original search-only index didn't need (a record only stored its OWN
// parent, never a folder's children), but directory browsing can't work
// without: listing a folder means answering "who points at me as parent",
// and doing that by scanning all ~1.3M records per listing isn't viable.
// Built once during scanIndex, then kept in sync incrementally by
// pollUsnJournal on every create/delete/rename/move.
function addChild(childrenIndex, parentRecordNum, recordNum) {
  let set = childrenIndex.get(parentRecordNum);
  if (!set) { set = new Set(); childrenIndex.set(parentRecordNum, set); }
  set.add(recordNum);
}
function removeChild(childrenIndex, parentRecordNum, recordNum) {
  const set = childrenIndex.get(parentRecordNum);
  if (!set) return;
  set.delete(recordNum);
  if (set.size === 0) childrenIndex.delete(parentRecordNum);
}

// Reads record 0 ($MFT itself) and returns everything needed to locate any
// other record on disk: volume geometry, the $MFT's own data runs (which
// records/scans/lookups all walk through — see parseDataRuns), and the
// total record count. Kept separate from scanning so a live-update path can
// reuse the same geometry+runs to re-read a single record after a USN event
// without redoing this lookup each time.
function getMftLayout(handle) {
  const geo = readVolumeGeometry(handle);
  const { recordSize, mftOffset } = geo;

  const rec0 = readAligned(handle, Number(mftOffset), recordSize);
  applyFixup(rec0, geo.bytesPerSector);
  if (rec0.readUInt32LE(0) !== FILE_RECORD_MAGIC) throw new Error('record 0 is not $MFT — bad geometry');

  let mftByteLength = null;
  let runs = null;
  let pos = rec0.readUInt16LE(0x14);
  while (pos + 8 <= recordSize) {
    const t = rec0.readUInt32LE(pos);
    if (t === ATTR_END) break;
    const len = rec0.readUInt32LE(pos + 4);
    if (len <= 0) break;
    if (t === ATTR_DATA && rec0.readUInt8(pos + 9) === 0 /* unnamed */ && rec0.readUInt8(pos + 8) === 1 /* non-resident */) {
      mftByteLength = Number(rec0.readBigUInt64LE(pos + 0x30));
      const runListOffset = rec0.readUInt16LE(pos + 0x20);
      runs = parseDataRuns(rec0, pos + runListOffset);
      break;
    }
    pos += len;
  }
  if (!mftByteLength || !runs) throw new Error('could not locate $MFT $DATA runs');

  return { geo, runs, mftByteLength, totalRecords: Math.floor(mftByteLength / recordSize) };
}

// Translates a record number (stream-relative record index into $MFT) to
// its physical disk offset, by finding which data run's VCN range contains
// it. Runs are typically few (tens, not thousands) even for a fragmented
// MFT, so linear scan is fine.
function recordPhysicalOffset(layout, recordNum) {
  const { geo, runs } = layout;
  const streamOffset = BigInt(recordNum) * BigInt(geo.recordSize);
  for (const run of runs) {
    if (run.startLcn === null) continue;
    const runStreamStart = run.startVcn * BigInt(geo.clusterSize);
    const runStreamEnd = runStreamStart + run.lengthClusters * BigInt(geo.clusterSize);
    if (streamOffset >= runStreamStart && streamOffset < runStreamEnd) {
      return run.startLcn * BigInt(geo.clusterSize) + (streamOffset - runStreamStart);
    }
  }
  return null; // record number outside any known run (shouldn't happen for a valid recordNum < totalRecords)
}

// Re-reads and re-parses exactly one record — used to refresh the index
// after a USN journal event tells us a specific record changed, rather than
// trusting the (leaner) fields already present in the USN record itself.
// Returns null if the record isn't there or isn't currently in use (i.e.
// it's been deleted, whether or not the triggering event's reason flags
// said so explicitly).
function readRecordByNumber(handle, layout, recordNum) {
  const offset = recordPhysicalOffset(layout, recordNum);
  if (offset === null) return null;
  const recBuf = readAligned(handle, Number(offset), layout.geo.recordSize);
  if (recBuf.readUInt32LE(0) !== FILE_RECORD_MAGIC) return null;
  if (!applyFixup(recBuf, layout.geo.bytesPerSector)) return null;
  return parseRecord(recBuf, layout.geo.recordSize);
}

// Diagnostic: raw header state for one record, bypassing the "in use?"
// filtering readRecordByNumber applies, so a caller can see exactly what's
// on disk right now (flags, sequence number) rather than just yes/no.
function debugRawRecord(handle, layout, recordNum) {
  const offset = recordPhysicalOffset(layout, recordNum);
  if (offset === null) return { error: 'no offset' };
  const recBuf = readAligned(handle, Number(offset), layout.geo.recordSize);
  const magic = recBuf.toString('ascii', 0, 4);
  if (magic !== 'FILE') return { magic };
  const fixedUp = applyFixup(recBuf, layout.geo.bytesPerSector);
  const flags = recBuf.readUInt16LE(0x16);
  const seq = recBuf.readUInt16LE(0x10);
  return { magic, fixedUp, flags, inUse: !!(flags & FLAG_IN_USE), seq };
}

// Scans every record in $MFT and returns { index, childrenIndex } — index
// maps recordNum -> {name, parentRecordNum, isDirectory, size, mtime, seq}
// for every in-use record, childrenIndex maps parentRecordNum -> Set of its
// children's recordNums (see addChild/removeChild above). Progress is
// reported via onProgress (optional) as (recordsScanned, totalRecords).
function scanIndex(handle, layout, onProgress) {
  const { geo, runs, mftByteLength, totalRecords } = layout;
  const { recordSize, clusterSize } = geo;

  const index = new Map();
  const childrenIndex = new Map();
  const CHUNK_RECORDS = 512; // batch reads for throughput instead of one syscall per 1KB record
  let scanned = 0;

  for (const run of runs) {
    if (run.startLcn === null) continue; // sparse run: no physical data, nothing to scan
    const runStreamStart = run.startVcn * BigInt(clusterSize);
    const runStreamEnd = runStreamStart + run.lengthClusters * BigInt(clusterSize);
    const scanEnd = BigInt(Math.min(Number(runStreamEnd), mftByteLength)); // last run may be padded past real size
    if (runStreamStart >= scanEnd) continue;

    // First record index this run covers (runs always start on a cluster
    // boundary, and cluster size is a multiple of record size, so this is
    // always a whole record boundary too).
    let recordIndex = Number(runStreamStart) / recordSize;
    let physOffset = run.startLcn * BigInt(clusterSize);
    let streamPos = runStreamStart;

    while (streamPos < scanEnd) {
      const remainingInRun = Number(scanEnd - streamPos);
      const bytesThisRead = Math.min(CHUNK_RECORDS * recordSize, remainingInRun);
      const recordsThisRead = Math.floor(bytesThisRead / recordSize);
      if (recordsThisRead === 0) break;
      const chunk = readAligned(handle, Number(physOffset), recordsThisRead * recordSize);
      for (let i = 0; i < recordsThisRead; i++) {
        const recBuf = chunk.slice(i * recordSize, (i + 1) * recordSize);
        if (recBuf.readUInt32LE(0) !== FILE_RECORD_MAGIC) continue;
        if (!applyFixup(recBuf, geo.bytesPerSector)) continue;
        const parsed = parseRecord(recBuf, recordSize);
        if (parsed) {
          const recordNum = recordIndex + i;
          index.set(recordNum, parsed);
          addChild(childrenIndex, parsed.parentRecordNum, recordNum);
        }
      }
      scanned += recordsThisRead;
      recordIndex += recordsThisRead;
      physOffset += BigInt(recordsThisRead * recordSize);
      streamPos += BigInt(recordsThisRead * recordSize);
      if (onProgress) onProgress(scanned, totalRecords);
    }
  }

  return { index, childrenIndex };
}

// One-shot convenience wrapper: open, build layout, scan, close. Used where
// nothing needs to stay live afterward.
function buildIndex(driveLetter, onProgress) {
  const handle = mftvol.openVolume(`\\\\.\\${driveLetter}:`);
  try {
    const layout = getMftLayout(handle);
    const { index, childrenIndex } = scanIndex(handle, layout, onProgress);
    return { index, childrenIndex, totalRecords: layout.totalRecords };
  } finally {
    mftvol.closeVolume(handle);
  }
}

// ---- USN Journal (live updates) ----

const REASON_MASK_ALL = 0xFFFFFFFF;
const USN_REASON_FILE_DELETE = 0x00000200;

// Returns {journalId, nextUsn} as decimal strings (see native addon comment
// on why — they're 64-bit and not always safely representable as JS
// numbers). Creates the journal if this volume doesn't have one yet; that
// needs elevation, which this app already requires.
function ensureUsnJournal(handle) {
  try {
    return mftvol.queryUsnJournal(handle);
  } catch (err) {
    mftvol.createUsnJournal(handle);
    return mftvol.queryUsnJournal(handle);
  }
}

const FILE_ATTRIBUTE_DIRECTORY = 0x10;

function decodeUsnRecords(raw) {
  const nextUsn = raw.readBigInt64LE(0).toString();
  const records = [];
  let pos = 8;
  while (pos + 60 <= raw.length) {
    const recordLength = raw.readUInt32LE(pos);
    if (recordLength === 0 || pos + recordLength > raw.length) break;
    const fileRefNum = raw.readBigUInt64LE(pos + 8);
    const parentRefNum = raw.readBigUInt64LE(pos + 16);
    const reason = raw.readUInt32LE(pos + 40);
    const fileAttributes = raw.readUInt32LE(pos + 52);
    const fileNameLength = raw.readUInt16LE(pos + 56);
    const fileNameOffset = raw.readUInt16LE(pos + 58);
    records.push({
      recordNum: Number(fileRefNum & 0xFFFFFFFFFFFFn),
      seq: Number(fileRefNum >> 48n),
      parentRecordNum: Number(parentRefNum & 0xFFFFFFFFFFFFn),
      reason,
      isDirectory: !!(fileAttributes & FILE_ATTRIBUTE_DIRECTORY),
      name: raw.slice(pos + fileNameOffset, pos + fileNameOffset + fileNameLength).toString('utf16le')
    });
    pos += recordLength;
  }
  return { nextUsn, records };
}

// Non-blocking: reads whatever's in the journal since cursorUsn (possibly
// nothing) and applies it directly to `index`/`childrenIndex` in place.
//
// Deliberately does NOT re-read the changed record from $MFT to "confirm"
// current state — measured directly: a raw volume read of a just-deleted
// record still showed it as in-use 4+ seconds after the delete (NTFS lazily
// flushes MFT metadata to the blocks a raw volume handle actually sees; the
// USN journal entry itself has no such lag, since it's written as part of
// the transaction). So a delete reason is trusted immediately, and every
// other event's name/parent/isDirectory come straight from the journal
// record too, for the same reason — it's the only account of "what changed"
// that isn't subject to that lag.
//
// Size and mtime are a different story: the journal doesn't carry either,
// and re-reading them from raw $MFT would hit the exact same staleness bug
// as above. But Node's normal fs.statSync goes through the regular
// cache-coherent NTFS/cache-manager path (not a raw volume block read), so
// it doesn't have that lag — confirmed by the fact the delete-recovery
// snapshot store has relied on plain fs.statSync/fs.watch this whole time
// with no staleness issue. So a changed file gets a real stat() here; a
// changed directory doesn't bother (size is always shown as 0 for
// directories, and its own mtime rarely matters to a user browsing it).
//
// Returns the new cursor USN to pass in next call, and how many distinct
// records changed (for a UI "live" indicator — not otherwise used).
function pollUsnJournal(handle, layout, journalId, cursorUsn, index, childrenIndex, driveLetter) {
  const raw = mftvol.readUsnJournal(handle, journalId, cursorUsn, REASON_MASK_ALL, 1 << 16);
  const { nextUsn, records } = decodeUsnRecords(raw);

  for (const rec of records) {
    const existing = index.get(rec.recordNum);

    if (rec.reason & USN_REASON_FILE_DELETE) {
      if (existing) removeChild(childrenIndex, existing.parentRecordNum, rec.recordNum);
      index.delete(rec.recordNum);
      continue;
    }

    if (existing && existing.parentRecordNum !== rec.parentRecordNum) {
      removeChild(childrenIndex, existing.parentRecordNum, rec.recordNum);
    }
    addChild(childrenIndex, rec.parentRecordNum, rec.recordNum);

    // Only carry over the last-known size/mtime if this is genuinely the
    // same file as before (same sequence number) — a differing seq means
    // the MFT slot was freed and reused for something else since we last
    // saw it, and the old values would be meaningless for the new occupant.
    const sameFile = existing && existing.seq === rec.seq;
    index.set(rec.recordNum, {
      name: rec.name,
      parentRecordNum: rec.parentRecordNum,
      isDirectory: rec.isDirectory,
      size: sameFile ? existing.size : 0,
      mtime: sameFile ? existing.mtime : null,
      seq: rec.seq
    });

    if (!rec.isDirectory) {
      const p = resolvePath(index, rec.recordNum, driveLetter);
      if (p) {
        try {
          const st = fs.statSync(p);
          const entry = index.get(rec.recordNum);
          entry.size = st.size;
          entry.mtime = st.mtimeMs;
        } catch (e) {
          // Deleted again (or renamed away) between the journal event and
          // this stat — leave the carried-over/placeholder values; the next
          // event for this record (or a full rescan) will correct it.
        }
      }
    }
  }

  const touchedCount = new Set(records.map((r) => r.recordNum)).size;
  // `records` handed back too — callers that need to react to *what* changed
  // (the safety-net snapshot trigger) resolve current paths via `index`
  // themselves rather than this module knowing anything about that policy.
  return { nextUsn, changedCount: touchedCount, records };
}

// Root directory is always MFT record 5. Walks parent references to build a
// full path; bails out (returns null) on cycles or missing ancestors rather
// than looping forever — both happen for records caught mid-move/mid-delete.
function resolvePath(index, recordNum, driveLetter) {
  const parts = [];
  let cur = recordNum;
  const seen = new Set();
  while (cur !== 5) {
    if (seen.has(cur)) return null;
    seen.add(cur);
    const rec = index.get(cur);
    if (!rec) return null;
    parts.push(rec.name);
    cur = rec.parentRecordNum;
  }
  parts.reverse();
  return `${driveLetter}:\\${parts.join('\\')}`;
}

// Whole-drive "Recent" view: the most recently modified files, newest
// first. Deliberately NOT a full sort of the index (~1.3M records on a
// typical drive) — that would visibly stall the main process every time the
// panel opens. Instead a single pass keeps a bounded top-`limit` set,
// re-sifting only when a record beats the current worst kept entry, which
// gets rare fast once the set fills up. Directories are excluded — "recent
// files" isn't a meaningful concept for a folder the way it is for a file
// you were just working on.
function recentFiles(index, driveLetter, limit = 100) {
  const top = []; // unsorted while filling; index 0 tracks the current minimum once full
  let minIdx = -1;
  for (const [recordNum, rec] of index) {
    if (rec.isDirectory || rec.mtime == null) continue;
    if (top.length < limit) {
      top.push({ recordNum, rec });
      if (top.length === limit) {
        minIdx = 0;
        for (let i = 1; i < top.length; i++) if (top[i].rec.mtime < top[minIdx].rec.mtime) minIdx = i;
      }
      continue;
    }
    if (rec.mtime > top[minIdx].rec.mtime) {
      top[minIdx] = { recordNum, rec };
      minIdx = 0;
      for (let i = 1; i < top.length; i++) if (top[i].rec.mtime < top[minIdx].rec.mtime) minIdx = i;
    }
  }
  top.sort((a, b) => b.rec.mtime - a.rec.mtime);
  const results = [];
  for (const { recordNum, rec } of top) {
    const p = resolvePath(index, recordNum, driveLetter);
    if (!p) continue;
    results.push({ recordNum, fileId: fileId(recordNum, rec.seq), path: p, isDirectory: false, size: rec.size, mtime: rec.mtime });
  }
  return results;
}

function search(index, query, driveLetter, limit = 200) {
  const q = query.toLowerCase();
  const results = [];
  for (const [recordNum, rec] of index) {
    if (!rec.name.toLowerCase().includes(q)) continue;
    const path = resolvePath(index, recordNum, driveLetter);
    if (!path) continue;
    results.push({ recordNum, fileId: fileId(recordNum, rec.seq), path, isDirectory: rec.isDirectory, size: rec.size, mtime: rec.mtime });
    if (results.length >= limit) break;
  }
  return results;
}

// Lists the direct children of parentRecordNum (one level, not recursive —
// a directory browser calls this fresh each time the user navigates).
// parentPath is the already-resolved path of the parent, passed in rather
// than re-resolved here since the caller (main.js) already tracks "current
// folder" as both a recordNum and a path together.
function listChildren(index, childrenIndex, parentRecordNum, parentPath) {
  const set = childrenIndex.get(parentRecordNum);
  if (!set) return [];
  const out = [];
  for (const recordNum of set) {
    const rec = index.get(recordNum);
    if (!rec) continue; // shouldn't happen if childrenIndex is kept in sync, but don't crash a listing over it
    out.push({
      recordNum,
      fileId: fileId(recordNum, rec.seq),
      name: rec.name,
      path: parentPath.endsWith('\\') ? `${parentPath}${rec.name}` : `${parentPath}\\${rec.name}`,
      isDirectory: rec.isDirectory,
      size: rec.size,
      mtime: rec.mtime
    });
  }
  out.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });
  });
  return out;
}

// Resolves an absolute path (e.g. typed into an address bar, or clamping a
// removed watched-folder default back to something valid) to its record
// number, by walking childrenIndex from the root (record 5) down through
// each path segment. Returns null if any segment isn't found.
function recordNumForPath(index, childrenIndex, driveLetter, absolutePath) {
  const prefix = `${driveLetter}:\\`;
  if (absolutePath.toLowerCase() === `${driveLetter}:`.toLowerCase() || absolutePath.toLowerCase() === prefix.toLowerCase()) return 5;
  if (!absolutePath.toLowerCase().startsWith(prefix.toLowerCase())) return null;
  const segments = absolutePath.slice(prefix.length).split('\\').filter(Boolean);
  let cur = 5;
  for (const seg of segments) {
    const set = childrenIndex.get(cur);
    if (!set) return null;
    let found = null;
    for (const recordNum of set) {
      const rec = index.get(recordNum);
      if (rec && rec.name.toLowerCase() === seg.toLowerCase()) { found = recordNum; break; }
    }
    if (found === null) return null;
    cur = found;
  }
  return cur;
}

// Same shape as search(), but for a caller that already knows exactly which
// fileIds it wants (the tag-search path) rather than matching by name
// substring. Confirms the current record at that number still has the same
// seq before including it — if not, that MFT slot's been reused for an
// unrelated file since the tag was set, and the stale tag is dropped
// (returned separately so the caller can garbage-collect it) rather than
// silently shown on the wrong file.
function resultsForFileIds(index, fileIds, driveLetter, limit = 200) {
  const results = [];
  const staleFileIds = [];
  for (const id of fileIds) {
    const [recordNumStr, seqStr] = id.split(':');
    const recordNum = Number(recordNumStr);
    const rec = index.get(recordNum);
    if (!rec || String(rec.seq) !== seqStr) { staleFileIds.push(id); continue; }
    const path = resolvePath(index, recordNum, driveLetter);
    if (!path) continue;
    results.push({ recordNum, fileId: id, path, isDirectory: rec.isDirectory, size: rec.size, mtime: rec.mtime });
    if (results.length >= limit) break;
  }
  return { results, staleFileIds };
}

module.exports = {
  buildIndex, resolvePath, search, resultsForFileIds, fileId,
  listChildren, recordNumForPath, recentFiles,
  // Live-update path: open a handle that stays open for the app's lifetime,
  // scan once, then keep polling the USN journal against the same handle.
  openVolume: (driveLetter) => mftvol.openVolume(`\\\\.\\${driveLetter}:`),
  closeVolume: (handle) => mftvol.closeVolume(handle),
  getMftLayout, scanIndex, ensureUsnJournal, pollUsnJournal, readRecordByNumber, debugRawRecord
};
