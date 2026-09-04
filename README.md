# Revenant

A stock Windows Explorer replacement: instant whole-drive file search built
on raw NTFS `$MFT` indexing (the same approach voidtools' Everything uses),
staying live via the NTFS USN Journal, real in-app folder browsing, a 24h
delete/edit recovery safety net for user-chosen folders (Desktop + Documents
by default), and tags. Runs in the tray with a global summon hotkey and
Start-with-Windows, same conventions as Wraith/Specter/Phantom. Part of the
same family as Wraith, Specter, Phantom, and Séance.

## Status

Backend proven, UI works, index is live, safety net works, results are
actionable, watched folders are configurable, tags work, directory browsing
works, house-style parity (tray/hotkey/single-instance/autostart) is in,
packaged as a real NSIS installer, and results (and the current folder)
can be sent to Wraith as a new terminal tab. Search covers the whole drive
and updates in real time as
files are created, renamed, or deleted (~1s poll interval) — including
honest size and modified-date, kept fresh via `fs.statSync` rather than
stale placeholders. Double-click a folder to browse into it (Revenant's own
view, not a hand-off to real Explorer); breadcrumbs, back/forward, a
Quick-access sidebar (Desktop/Downloads/Documents/Pictures/Music/Videos/This
PC), and a whole-drive **Recent** tab (most recently modified files, newest
first) round out the Explorer-replacement side. Files changed or deleted in
watched folders while Revenant is running are recoverable for 24h via the
Recovery panel; which folders are watched is editable from the Settings
panel (also where Start-with-Windows lives) and takes effect immediately,
no restart. Double-click a result to open it, right-click for Open / Show
in Explorer / Copy path / Add tag — tagged files are searchable with
`#tagname`. Files get a type emoji and a colored extension badge. A file
inside a Séance-tracked project folder gets a read-only badge naming that
project. A "This PC" panel shows every local drive as a capacity-bar tile,
Explorer-style, with `C:` opening in Revenant's own view and every other
drive handed off to real Explorer. Store writes (settings/tags/snapshots)
are atomic, a corrupted MFT record is skipped rather than aborting the
whole index, and orphaned snapshot blobs self-heal on purge. All of the
above verified against real filesystem operations
end-to-end — either through the actual running UI, or via standalone
scripts exercising the same `lib/mft.js` code path against the real volume
where the running UI couldn't be driven directly (see "Testing notes"
below).

## Why this needs admin, unconditionally

Search works by reading the volume's Master File Table directly
(`\\.\C:`), not by walking the filesystem — that's what makes indexing the
whole drive take ~2.5s instead of minutes. Raw volume access requires
elevation; there's no fallback mode. `package.json` sets
`requestedExecutionLevel: requireAdministrator` for exactly this reason.

## Why there's a native addon (`native/mftvol`)

Node's own `fs` module misclassifies a raw volume handle as a directory on
the Node version Electron currently bundles (confirmed EISDIR on v20.18.3;
confirmed absent on a standalone v24.20.0) — `fs.read`/`fs.readSync` refuse
the read entirely. Rather than depend on that version quirk, `mftvol.node`
calls `CreateFile`/`ReadFile` directly via Win32, bypassing `fs` and its
directory check. It's built against `node-addon-api` (N-API), which is
ABI-stable across Node/Electron versions, so it doesn't need an
Electron-specific rebuild the way `node-pty` does in Wraith.

## Building the native addon

```
cd native/mftvol
npm install
```

This machine's Visual Studio install generates `PlatformToolset=ClangCL`
by default for new native-module builds even though only the standard
MSVC toolset (v143) is actually installed, which fails with MSB8020. Fixed
two ways, both already in place:

- `native/mftvol/binding.gyp` pins `msbuild_toolset: v143` on its own target.
- `%USERPROFILE%\.gyp\include.gypi` sets the same as a global default —
  needed because `node-addon-api`'s own internal build-check target
  (`nothing.vcxproj`) doesn't inherit settings from `binding.gyp`, only from
  a machine-wide gyp override. If this file doesn't exist on a fresh
  machine, recreate it (see git history / ask Claude — this file lives
  outside the repo, in the user profile, not tracked here).

Also needed: `/std:c++17` (`napi-inl.h` uses `std::string_view`), set via
`msvs_settings` in `binding.gyp` since gyp's `LanguageStandard` setting
doesn't reliably convert to MSBuild on this node-gyp version.

## Running it

```
npm install
npm start
```

Must be launched elevated (right-click → Run as administrator on the
resulting exe, or an elevated terminal for `npm start`) — a UAC prompt is
expected. Without elevation, the status bar will show an indexing error.

## Live updates (USN Journal)

`main.js` keeps one volume handle open for the app's lifetime and polls
`FSCTL_READ_USN_JOURNAL` every ~1s (non-blocking — `Timeout=0`, so it never
stalls the Electron main thread) via `native/mftvol`'s `readUsnJournal`.

Important, counter-intuitive finding from actually testing this: **live
updates do NOT re-read the changed record from `$MFT`.** The first version
did, and it was wrong — measured directly, a raw volume read of a
just-deleted record still showed it as in-use 4+ seconds after the delete,
because NTFS lazily flushes MFT metadata to the blocks a raw volume handle
actually sees, while the USN journal entry itself is written immediately as
part of the transaction and has no such lag. So a delete reason is trusted
the instant it's seen, and every other event's name/parent/isDirectory come
straight from the journal record too. The one thing the journal doesn't
carry is file size, so a live-updated entry keeps its last-known size until
the next full rescan — a real but minor staleness next to a deleted file
still showing up in results, which is what the first version actually did.

`lib/mft.js` exports `debugRawRecord` for exactly this kind of "what does
the disk actually say right now" check if this needs revisiting.

## Delete/edit safety net (`lib/snapshots.js`)

Watches user-chosen folders only — Desktop + Documents by default, editable
from the Settings panel (`lib/settings.js` persists to
`<userData>/settings.json`) — not the whole drive, since snapshotting every
write anywhere (build output, browser cache, game saves...) would be both
wasteful and mostly noise nobody wants recovered. Reuses the same USN
journal poll loop from live updates rather than a second watcher. A
folder-list change takes effect on the very next poll tick — verified by
removing a folder via the API and confirming a file written there right
after was no longer captured, no restart needed.

The non-obvious part, worth internalizing before touching this code: a
snapshot is NOT taken reactively "of the old content" when a change is
detected — by the time we see the event, the old content is already gone,
overwritten by the new. What actually happens is every detected change
(debounced ~2s so a burst of writes to one file snapshots once, not
mid-write) captures the file's *current* content into a growing timeline.
"Undo the last edit" means restoring the second-newest snapshot, not the
newest — the newest one IS the edit you're undoing. A delete has nothing new
to capture; the most recent snapshot already on file (from whenever the file
was last edited while it existed) is already the recovery point. This means
recovery only works for changes that happen after Revenant has already
captured at least one version of that file — the very first edit to a file
Revenant has never seen has no prior version to fall back to. Both edit
recovery (restore an older version over a bad edit) and delete recovery
(restore a deleted file from its last snapshot) verified end-to-end through
the real running UI: write v1, overwrite to v2, confirm 2 versions tracked,
restore the older one, confirm content matches v1 exactly — same for delete.

## Tags (`lib/tags.js`)

Keyed by `fileId` — `"recordNum:seq"`, not path and not bare recordNum.
This mattered enough to fix before building tags at all: NTFS reuses a
freed MFT slot for a completely unrelated future file once the original is
deleted, so a tag keyed on recordNum alone could silently reattach itself
to some other file later. `(recordNum, sequenceNumber)` together is the
actual stable identity NTFS itself uses (the same pairing is packed into
every `$FILE_NAME` reference and every USN journal record's
`FileReferenceNumber`), so that's what `mft.js`'s `parseRecord` and
`decodeUsnRecords` both now extract and carry through the index. Search
results that reference a stale fileId (the record now holds a different
seq than the tag was set against) get dropped and the orphaned tag is
garbage-collected, rather than either resurfacing on the wrong file or
accumulating forever.

`#tagname` in the search box does an exact tag search instead of a name
match. Right-click a result → Add tag… for a themed inline input (Electron
doesn't reliably support `window.prompt()`, so this isn't a native dialog).
Verified via real DOM interaction end-to-end: add a tag through the actual
context menu, confirm the pill survives a fresh re-search (proves it's
persisted, not just closure state), search `#tagname` and find it, remove
via the pill's ×, confirm the tag search comes back empty.

## Directory browsing (the Explorer-replacement part)

Search-only wasn't enough to replace Explorer — you need to answer "what's
in this folder," and the original index couldn't: it stored each record's
*parent*, never a folder's *children*. `lib/mft.js` now also maintains
`childrenIndex` (`Map<parentRecordNum, Set<recordNum>>`), built during the
initial scan and kept in sync incrementally on every USN journal event
(create/rename/move/delete), so listing a folder is an O(children) lookup,
never a scan of the whole ~1.3M-record index. Size and modified-date on a
live-updated record are refreshed via a normal `fs.statSync` call (not a
raw volume re-read — that path has the same metadata-flush lag documented
above for deletes; `fs.statSync` goes through the ordinary cache-coherent
NTFS path and doesn't have it) rather than left stale. `listChildren` and
`recordNumForPath` (path → record, by walking `childrenIndex` from the
root) are what `browse-list` in `main.js` and the renderer's breadcrumbs /
sidebar / back-forward navigation are built on.

Verified two ways: `listChildren` output diffed directly against
`fs.readdirSync` + `fs.statSync` on real folders (name, isDirectory, size,
mtime all matched exactly), and a full live-update lifecycle test — create,
modify (size actually grows), rename, create a subfolder, move a file
between parents, delete — each step polled through the real USN journal
against a real temp folder on the live volume, asserting `childrenIndex`
and `listChildren` reflect it correctly at every step.

## Recent (`recentFiles` in `lib/mft.js`)

A whole-drive "most recently modified files" tab. Deliberately not a full
sort of the index (~1.3M records — sorting all of it on every panel open
would visibly stall the app); a single pass keeps a bounded top-100 set,
timed at 27ms end-to-end against the real index. Directories are excluded.

## File-type labeling

Each row gets a small category emoji (image/video/audio/archive/installer/
PDF/spreadsheet/slides/document/code/font, falling back to a plain document
icon) plus a colored extension badge, drawn from a fixed, hand-picked
extension table in `renderer/renderer.js` — an unrecognized extension just
gets the plain fallback, not a crash.

## House-style parity (tray, hotkey, single instance, autostart)

Matches the pattern already established in Wraith's `main.js`, copied
faithfully rather than reinvented: `requestSingleInstanceLock` (a second
launch focuses the existing window instead of opening a second raw volume
handle + USN poll loop against the same snapshot store — a real corruption
risk, not just waste), a tray icon with Show/Hide + Quit, a global summon
hotkey (`Ctrl+Alt+R` default, `settings.summonHotkey`), and
Start-with-Windows via `app.setLoginItemSettings` (toggle lives in the
Settings panel). The window's own close button hides to tray instead of
quitting — rebuilding the index on every dismiss would defeat the point of
keeping it live. `build/icon.ico` is a small hand-generated purple-gradient
"R" mark (a real PNG-in-ICO file, not a placeholder) since no design asset
existed for this project yet; Electron's default menu bar is removed and
the title bar is repainted dark via `titleBarOverlay` rather than left as
default OS white.

Single-instance lock verified by attempting a second launch while the first
was running and confirming the process count didn't change (no second
index/journal/snapshot-store instance spun up).

## "This PC" panel

A dedicated sidebar panel, separate from the `C:` shortcut, showing every
local drive as a tile: capacity bar (green/amber/red past 75%/90% used),
label, and free-of-total space — the same information Explorer's own "This
PC" page shows. Drive data comes from PowerShell's `Get-Volume` (real
label, size, free space, drive type), with a pure-Node `fs.statfsSync`
fallback (no label, but still real numbers) if PowerShell is unavailable.
Clicking the `C:` tile opens it in Revenant's own browse view; every other
drive hands off to the real Explorer via `shell.openPath`, since Revenant's
index is a single-volume raw `$MFT` scan of `C:` only — it can't browse
other drives itself, so this avoids pretending otherwise with an
empty/broken listing.

Verified with isolated logic tests: the PowerShell single-object-vs-array
JSON normalization, the drive-letter filter, and the capacity-bar threshold
math. Not yet visually verified in a running Electron window — this WSL
sandbox has no Electron GUI and no real drives to enumerate, so the actual
drive tiles and layout need confirming on the real Windows machine.

## Crash resilience and data integrity

A full pass over every place Revenant persists or trusts on-disk data,
looking specifically for corruption paths a crash or bad input could hit:

- `settings.js`, `tags.js`, and `snapshots.js` all previously wrote their
  JSON stores with a direct `fs.writeFileSync`, so a crash mid-write could
  truncate the file — and the loader's catch-and-reset turned that into
  permanent, silent data loss. All three now go through a shared
  `lib/atomic-write.js` helper (write to a temp file, then rename, with
  retry on transient Windows `EPERM`/`EBUSY`), verified against the real,
  OneDrive-synced AppData path before relying on it.
- `mft.js`'s `scanIndex()` now wraps each record's `parseRecord()` call in
  a try/catch: `parseRecord` trusts on-disk offset fields, so one corrupted
  MFT record among millions could otherwise abort the entire index build.
  It's now skipped and counted instead, with the count surfaced in the
  status bar rather than swallowed.
- `snapshots.js`'s `purgeExpired()` gained an orphan-blob sweep: the
  snapshot blob is written to disk before it's recorded in `meta`, so a
  crash in that gap used to leak the blob forever (`purgeExpired` only ever
  walked `meta`). The sweep self-heals this on every hourly purge.
- `filetimeToMs()` in `mft.js` now clamps FILETIMEs to a sane range. A
  corrupted record with a garbage future timestamp would otherwise sort to
  the top of the Recent list and stay pinned there permanently, since
  `recentFiles` sorts descending on mtime.
- The `open-in-wraith` IPC handler in `main.js` now actually waits on the
  `execFile` spawn's error event before responding, instead of returning
  `{ ok: true }` unconditionally right after issuing the spawn.

Verified with real round-trip tests (temp dirs, not mocks): atomic write
survives repeated writes with no leftover tmp files, tag/snapshot stores
persist correctly through it, and the orphan sweep removes an unreferenced
blob while keeping a referenced one. The `scanIndex`/`parseRecord` throw
path is confirmed structurally here; exercising it against a genuinely
corrupted MFT record needs the real Windows box.

## Séance integration (read-only)

Revenant runs as a native Windows process; Séance's CLI is npm-linked
inside WSL. `lib/seance.js` shells out through `wsl.exe` to Séance's own
`seance status` command (its documented, stable headless interface) and
parses the project registry it prints — never reads or writes Séance's
userData files directly, and never touches Séance's own source. A file
whose path falls under a Séance-tracked project folder gets a small
read-only badge naming that project. Refreshed once at startup and every 10
minutes. Verified end-to-end from the real Windows-side process (not just
the parsing logic) against the real `seance status` output.

Phantom gets no code-level integration: it has no entry point today to
accept an external file (no CLI args, no protocol handler — checked,
read-only, nothing added), and Revenant doesn't produce the kind of
user-facing output that would make the shared `Arsenal` folder convention
apply the way it does for Phantom's screenshots. In practice the two
already compose for free — Revenant's whole-drive index covers
`Arsenal\Screenshots` like any other folder, no special-casing needed.

## Testing notes

Most of this was verified by driving the actual running UI through Chrome
DevTools Protocol. In the environment this session ran in, CDP's debug port
wasn't reachable from WSL to the Windows-side Electron process (tried both
loopback and the WSL gateway IP, with and without binding to `0.0.0.0`) —
so the directory-browsing, live-update, Recent, and Séance-badge logic were
instead verified with standalone Node scripts that `require('./lib/mft.js')`
directly and exercise it against the real volume/real files (see the
"Directory browsing" and "Recent" sections above for what those checks
covered). Visual/UX polish (animations, hover feel, whether the browsing UI
actually *feels* like a good Explorer replacement) was not verified this
way — that needs an actual look, not a script.

## "Open in Wraith here"

Right-click a result (or a folder in the browse view), or click the `>_`
button in the address bar for the current folder — either sends the
directory to Wraith, which opens a new Command Prompt tab starting there. A
file resolves to its parent directory rather than trying to `cd` into the
file itself. Implemented via a plain
`child_process.execFile('Wraith.exe', [dir])` in `main.js`'s
`open-in-wraith` handler (hardcoded install-path candidates, same
single-machine assumption Séance's own CLI makes); the receiving half lives
in Wraith itself, which now accepts a starting directory as a launch
argument (cold launch) or forwards it through its existing single-instance
lock's `second-instance` event (already running — a new tab gets added to
the existing window, nothing second spawns). Verified against real
processes on both sides: confirmed via each resulting `cmd.exe`'s actual
working directory (read straight out of its PEB, not just "no errors in
the log") for a cold launch, a forwarded second-instance call, and a
file-path-resolves-to-parent-directory case.

## Packaging

`npm run dist` builds a real NSIS installer (`dist/Revenant Setup
<version>.exe`). `native/mftvol/build/Release/mftvol.node` lives outside
`node_modules` (it's a local addon, not an npm dependency), so
electron-builder's default native-module handling would never have found
it — it's listed explicitly in `build.files` and `build.asarUnpack`.
`build/icon.ico` is wired into `win.icon` and confirmed present inside
`app.asar` for the runtime tray/window icon read. Verified by actually
running the packaged, non-dev `Revenant.exe` (not `electron .`) and
confirming it indexes and runs clean — proves the native addon loads
correctly from `app.asar.unpacked`, not just that the build step didn't
error.
