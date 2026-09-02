# Revenant

Instant whole-drive file search, built on raw NTFS `$MFT` indexing (the same
approach voidtools' Everything uses), staying live via the NTFS USN Journal,
plus a planned delete/edit safety net (see Roadmap). Part of the same family
as Wraith and Specter.

## Status

Backend proven, UI works, index is live, not yet packaged or feature-complete.
Search covers the whole drive and updates in real time as files are created,
renamed, or deleted (~1s poll interval) — verified against real filesystem
operations without restarting the app. No undo/recovery yet, no dual-pane
browsing.

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

## Roadmap (see project chat history for full rationale)

- **Delete/edit safety net** — 24h rolling recovery window for both deletes
  (route through a holding folder) and edits (snapshot on detected change).
  The USN journal poll loop above is the same subsystem this needs for
  detecting an edit in time to snapshot the previous version — extend it,
  don't build a second one.
- **Dual-pane browsing, tags, "open in Wraith here"** — see project notes.
- **Packaging** — NSIS installer via `npm run dist` not yet verified for
  this project; `native/mftvol` needs to be included in `build.files` and
  likely `asarUnpack`'d before that'll work (same pattern as `node-pty` in
  Wraith).
