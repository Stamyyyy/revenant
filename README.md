# Revenant

Instant whole-drive file search, built on raw NTFS `$MFT` indexing (the same
approach voidtools' Everything uses), staying live via the NTFS USN Journal,
plus a 24h delete/edit recovery safety net for user-chosen folders (Desktop
+ Documents by default). Part of the same family as Wraith and Specter.

## Status

Backend proven, UI works, index is live, safety net works, results are
actionable, watched folders are configurable, not yet packaged. Search
covers the whole drive and updates in real time as files are created,
renamed, or deleted (~1s poll interval). Files changed or deleted in
watched folders while Revenant is running are recoverable for 24h via the
Recovery panel; which folders are watched is editable from the Settings
panel and takes effect immediately, no restart. Double-click a result to
open it, right-click for Open / Show in Explorer / Copy path. All of the
above verified against real filesystem operations end-to-end through the
actual running UI, not just the backend. No dual-pane browsing yet.

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

## Roadmap (see project chat history for full rationale)

- **Dual-pane browsing, tags, "open in Wraith here"** — see project notes.
- **Packaging** — NSIS installer via `npm run dist` not yet verified for
  this project; `native/mftvol` needs to be included in `build.files` and
  likely `asarUnpack`'d before that'll work (same pattern as `node-pty` in
  Wraith).
