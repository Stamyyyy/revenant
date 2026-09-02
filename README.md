# Revenant

Instant whole-drive file search, built on raw NTFS `$MFT` indexing (the same
approach voidtools' Everything uses), plus a planned delete/edit safety net
(see Roadmap). Part of the same family as Wraith and Specter.

## Status

Backend proven, UI works, not yet packaged or feature-complete. Currently:
whole-drive search only. No live index updates yet (see below), no undo/
recovery, no dual-pane browsing.

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

## Roadmap (see project chat history for full rationale)

- **Live index updates** — the index is a one-shot snapshot right now; it
  drifts from reality as files change until the app restarts. This needs
  the NTFS USN Journal, which is also the same subsystem the undo/recovery
  feature needs (it's what detects a file changed, in time to snapshot the
  previous version) — design these together, not as two separate features.
- **Delete/edit safety net** — 24h rolling recovery window for both deletes
  (route through a holding folder) and edits (snapshot on detected change).
- **Dual-pane browsing, tags, "open in Wraith here"** — see project notes.
- **Packaging** — NSIS installer via `npm run dist` not yet verified for
  this project; `native/mftvol` needs to be included in `build.files` and
  likely `asarUnpack`'d before that'll work (same pattern as `node-pty` in
  Wraith).
