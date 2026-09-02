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
const ATTR_FILE_NAME = 0x30;
const ATTR_DATA = 0x80;
const ATTR_END = 0xFFFFFFFF;
const FLAG_IN_USE = 0x0001;
const FLAG_DIRECTORY = 0x0002;
// FILE_NAME namespace byte: 0=POSIX, 1=Win32, 2=DOS(8.3), 3=Win32+DOS.
// A file with a long name gets two $FILE_NAME attributes (Win32 + DOS short
// name); we only want the human-readable one, so DOS-only entries are skipped.
const NAMESPACE_DOS = 2;

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

  while (pos + 8 <= recordSize) {
    const attrType = recBuf.readUInt32LE(pos);
    if (attrType === ATTR_END) break;
    const attrLen = recBuf.readUInt32LE(pos + 4);
    if (attrLen <= 0 || pos + attrLen > recordSize) break;
    const nonResident = recBuf.readUInt8(pos + 8);

    if (attrType === ATTR_FILE_NAME && nonResident === 0) {
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
    size: best.isDirectory ? 0 : (dataSize != null ? dataSize : best.size)
  };
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

// Scans every record in $MFT and returns { recordNum: {name, parentRecordNum,
// isDirectory, size} } for every in-use one. Progress is reported via
// onProgress (optional) as (recordsScanned, totalRecords).
function scanIndex(handle, layout, onProgress) {
  const { geo, runs, mftByteLength, totalRecords } = layout;
  const { recordSize, clusterSize } = geo;

  const index = new Map();
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
        if (parsed) index.set(recordIndex + i, parsed);
      }
      scanned += recordsThisRead;
      recordIndex += recordsThisRead;
      physOffset += BigInt(recordsThisRead * recordSize);
      streamPos += BigInt(recordsThisRead * recordSize);
      if (onProgress) onProgress(scanned, totalRecords);
    }
  }

  return index;
}

// One-shot convenience wrapper: open, build layout, scan, close. Used where
// nothing needs to stay live afterward.
function buildIndex(driveLetter, onProgress) {
  const handle = mftvol.openVolume(`\\\\.\\${driveLetter}:`);
  try {
    const layout = getMftLayout(handle);
    const index = scanIndex(handle, layout, onProgress);
    return { index, totalRecords: layout.totalRecords };
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
// nothing) and applies it directly to `index` in place.
//
// Deliberately does NOT re-read the changed record from $MFT to "confirm"
// current state — measured directly: a raw volume read of a just-deleted
// record still showed it as in-use 4+ seconds after the delete (NTFS lazily
// flushes MFT metadata to the blocks a raw volume handle actually sees; the
// USN journal entry itself has no such lag, since it's written as part of
// the transaction). So a delete reason is trusted immediately, and every
// other event's name/parent/isDirectory come straight from the journal
// record too, for the same reason — it's the only account of "what changed"
// that isn't subject to that lag. The one thing the journal doesn't carry is
// size, so a live-updated entry keeps its last-known size (0 if it's new)
// until the next full rescan corrects it — a real but minor staleness,
// nowhere near as bad as a deleted file still showing up in results.
//
// Returns the new cursor USN to pass in next call, and how many distinct
// records changed (for a UI "live" indicator — not otherwise used).
function pollUsnJournal(handle, layout, journalId, cursorUsn, index) {
  const raw = mftvol.readUsnJournal(handle, journalId, cursorUsn, REASON_MASK_ALL, 1 << 16);
  const { nextUsn, records } = decodeUsnRecords(raw);

  for (const rec of records) {
    if (rec.reason & USN_REASON_FILE_DELETE) {
      index.delete(rec.recordNum);
      continue;
    }
    const existing = index.get(rec.recordNum);
    index.set(rec.recordNum, {
      name: rec.name,
      parentRecordNum: rec.parentRecordNum,
      isDirectory: rec.isDirectory,
      size: existing ? existing.size : 0
    });
  }

  const touchedCount = new Set(records.map((r) => r.recordNum)).size;
  return { nextUsn, changedCount: touchedCount };
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

function search(index, query, driveLetter, limit = 200) {
  const q = query.toLowerCase();
  const results = [];
  for (const [recordNum, rec] of index) {
    if (!rec.name.toLowerCase().includes(q)) continue;
    const path = resolvePath(index, recordNum, driveLetter);
    if (!path) continue;
    results.push({ path, isDirectory: rec.isDirectory, size: rec.size });
    if (results.length >= limit) break;
  }
  return results;
}

module.exports = {
  buildIndex, resolvePath, search,
  // Live-update path: open a handle that stays open for the app's lifetime,
  // scan once, then keep polling the USN journal against the same handle.
  openVolume: (driveLetter) => mftvol.openVolume(`\\\\.\\${driveLetter}:`),
  closeVolume: (handle) => mftvol.closeVolume(handle),
  getMftLayout, scanIndex, ensureUsnJournal, pollUsnJournal, readRecordByNumber, debugRawRecord
};
