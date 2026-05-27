# Murmur Lite — Packaging Runbook

What the next session needs to know so we don't relearn this the hard way.

The fast path is in the **TL;DR** below. Every line of it exists because **something specific went wrong this session.** The "Traps" section explains what.

---

## TL;DR — clean build sequence (PowerShell)

```powershell
# Paths
$rel    = 'C:\Users\katar\Desktop\murmur-lite\node_modules\better-sqlite3\build\Release\better_sqlite3.node'
$eb     = 'C:\Users\katar\Desktop\murmur-lite\node_modules\better-sqlite3\abi-cache\better_sqlite3.electron.node'
$nb     = 'C:\Users\katar\Desktop\murmur-lite\node_modules\better-sqlite3\abi-cache\better_sqlite3.node.node'
$parked = "$rel.dev-locked"

# 0. *** ALWAYS RUN FIRST WHEN ANY src/ FILE HAS CHANGED ***
#    Compile TypeScript src/ → dist/. electron-builder packages whatever's
#    already in dist/ — it does NOT recompile. Skip this step and the installer
#    bumps its version but ships the OLD compiled code. (Burned on 1.0.1 — the
#    Discord-thinking persistence fix sat in src/ for an entire rebuild because
#    dist/ was stale; the version-bumped installer didn't actually contain it.)
#    Cheap if dist is already current — tsc is incremental in effect.
Set-Location 'C:\Users\katar\Desktop\murmur-lite'
Get-Process -Name 'Murmur Lite' -ErrorAction SilentlyContinue | Stop-Process -Force
npm run build      # = tsc; must succeed cleanly before continuing

# 0b. Sanity-check the fix you intend to ship is actually in dist/. Substitute
#     the identifier you added in src/. If 0 matches → tsc didn't compile it in
#     → diagnose before packaging.
Select-String -Path 'dist\server.js' -Pattern 'yourNewIdentifier' | Measure-Object | Select-Object -ExpandProperty Count

# 1. Park the (possibly locked) dev Node-ABI binary out of the way.
#    Rename works on locked files; overwrite does not. This is the only way to
#    swap the ABI while dev Lite is running.
if (Test-Path $parked) { Remove-Item $parked -Force }
Move-Item $rel $parked -Force

# 2. Stage the Electron-ABI binary in its place (direct copy — NOT npm run abi:pack).
Copy-Item $eb $rel -Force
(Get-FileHash $rel).Hash -eq (Get-FileHash $eb).Hash   # MUST be True

# 3. Clean release/ then build with the magic flag.
Remove-Item 'C:\Users\katar\Desktop\murmur-lite\release\win-unpacked' -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item 'C:\Users\katar\Desktop\murmur-lite\release\Murmur*.exe' -Force -ErrorAction SilentlyContinue
npx electron-builder --config.npmRebuild=false

# 4. Verify the packaged binary actually is Electron-ABI. If False, DO NOT SHIP —
#    the installer will dark-purple-screen.
$pk = 'C:\Users\katar\Desktop\murmur-lite\release\win-unpacked\resources\app\node_modules\better-sqlite3\build\Release\better_sqlite3.node'
(Get-FileHash $pk).Hash -eq (Get-FileHash $eb).Hash

# 4b. Also verify the source fix made it into the PACKAGED dist (electron-builder
#     copies dist/ in, but cross-check anyway — saves a wrong-binary release):
Select-String -Path 'release\win-unpacked\resources\app\dist\server.js' -Pattern 'yourNewIdentifier' | Measure-Object | Select-Object -ExpandProperty Count

# 5. Restore dev source so dev Lite keeps working on its next restart.
Remove-Item $rel -Force
Move-Item $parked $rel -Force
```

---

## The traps (each step exists because we hit this)

### TRAP 1 — `npm run dist` re-breaks the better-sqlite3 ABI
`npm run dist` = `npm run rebuild && npm run build && electron-builder`. The `rebuild` step is `electron-builder install-app-deps`, which **re-downloads the wrong-ABI prebuilt** `better-sqlite3` (NMV 127 instead of 145). Overwrites whatever you carefully staged. → server crashes on `require('better-sqlite3')` → dark purple screen.

**Never use `npm run dist`.** Use `npx electron-builder` directly.

### TRAP 2 — Even `npx electron-builder` runs its own rebuild internally
Newer electron-builder triggers `@electron/rebuild` automatically during packaging, even when invoked directly. Same install-app-deps trap, just invoked from inside electron-builder. The build log shows `executing @electron/rebuild electronVersion=41.2.0 ... buildFromSource=false`.

**Pass `--config.npmRebuild=false`** — tells electron-builder to skip the rebuild and trust the staged binary. Verify in the build log: should see `skipped dependencies rebuild reason=npmRebuild is set to false`.

### TRAP 3 — The npm `abi:dev` / `abi:pack` scripts silently fail in PowerShell
The scripts use `node -e "require('fs').copyFileSync(...)"`. **PowerShell strips the embedded double quotes** — the `-e` argument arrives empty, node prints its version banner and exits, the copy never happens. Exit code is 0. Total silent failure.

**Always use direct `Copy-Item`** for ABI swaps. (The npm scripts probably work in cmd.exe but PowerShell is the daily-driver shell.)

### TRAP 4 — `Copy-Item` on a locked file silently leaves the old binary in place
While dev Lite is running, the server's node child process has `better_sqlite3.node` open. Windows refuses to overwrite a locked file. The Copy-Item raises an `IOException` AND THE STALE BINARY STAYS. Then electron-builder packages the stale (wrong-ABI) binary. → dark purple screen.

**Use the rename trick first**: `Move-Item` to park the locked file (rename works on open files), then `Copy-Item` the new one into the now-vacated path. The dev process's handle migrates with the rename — it keeps working.

### TRAP 5 — Electron-as-Node hangs on a direct ESM main module
Spawning `dist/server.js` directly as the entry script via Electron-as-Node hangs silently — no output, no exit, no crash. Caught via 7 probe scripts that bisected the variable space.

**Fix already in `electron/main.cjs`**: it spawns `electron/launch.mjs`, which then `import()`s `dist/server.js`. The indirection avoids the hang. Don't remove `launch.mjs` and don't change main.cjs to spawn server.js directly.

---

## Symptoms decoder

| Symptom | Most likely cause | Where to look |
|---|---|---|
| Dark purple background, DevTools: *"Unsafe attempt to load URL http://127.0.0.1:3456"* | better-sqlite3 ABI mismatch — server crashed on `require()` | log: `[server:err] NODE_MODULE_VERSION` |
| Window opens but stays empty, no log written at all | launch.mjs missing OR main.cjs spawn path wrong | check `release/win-unpacked/resources/app/electron/launch.mjs` exists |
| Server starts but compaction hangs forever | SDK auto-compact subprocess hanging | 5-min watchdog in server.ts catches it; log will show `[server:err] SDK watchdog timeout` |
| Compaction banner mis-fires on every turn | `compact_result` matched as ambient SDK state | harness.ts — keep `compacting` + `compact_boundary` as banner triggers, `compact_result` only for done/failed signalling |

---

## What's IN the shipped installer (as of 25 May 2026)

Cumulative state across this session:
- **launch.mjs loader** in `electron/` (Electron-as-Node main-module hang fix)
- **5-min Promise.race SDK watchdog** in `server.ts` around `processMessage` (catches any SDK hang)
- **`stream_end`-in-catch** non-abort branch (renderer cleanup beyond just resetting `streaming`)
- **4-shape compaction detection** in `harness.ts`: `compacting` + `compact_result success/failed` + `compact_boundary`
- **TS fixes** in server.ts (Express 5 req.params, Cartesia voices.list paginator, Blob/Buffer)
- **Voice mode**: visible error messages + auto-recovery when Cartesia credits exhausted
- **TTS**: Kokoro Pacing sliders hidden (they don't affect Kokoro), Edge voices 8 → 22, slider values explicitly signed (`+10%`/`-15%`)
- **Password**: hint settable independently (`PUT /api/password/hint`), `sessionStorage` instead of `localStorage` so login reprompts every launch
- **Light-mode edit textarea text** visible (`#2a1f3d`)
- **Daemon dedup**: `!dist/search/**` exclusion drops the 884MB stale pyinstaller leftover
- **main.cjs path/shell fixes**: `APP_ROOT` (not `RESOURCES_ROOT`) for server path; `shell:false` in packaged mode (the .exe path has a space, `shell:true` mangles it)
- **Data-dir consistency**: `npm run desktop` and `npm run dev` both use `Desktop/murmur-lite/data` (Claude); installer uses per-user `%APPDATA%`
- **File logging** to `%APPDATA%/murmur-lite/logs/murmur-lite.log` (synchronous writes, survives process kill)
- **Description metadata**: *"Lightweight desktop AI companion with persistent memory and semantic search. Runs on your Claude Pro/Max subscription."*

---

## Key files

- `electron/launch.mjs` — loader, **required**, don't remove
- `electron/main.cjs` — spawns launch.mjs; file logging; data-dir aware in dev vs packaged
- `src/harness.ts` ~line 624 — compaction detection (4 shapes + fullText reset on completion)
- `src/server.ts` ~line 2186 — SDK watchdog (Promise.race, 5 min); ~line 2386 — catch with stream_end broadcast
- `node_modules/better-sqlite3/abi-cache/` — both cached binaries
  - `better_sqlite3.electron.node` — for packaging (NMV 145)
  - `better_sqlite3.node.node` — for dev on system Node 22 (NMV 127)

---

## Dev workflow

- **Dev (talk to Claude):** `npm run desktop` (Electron window) or `npm run dev` (server only, open browser at `localhost:3456`). Both use `Desktop\murmur-lite\data` (Claude). Both need the **Node-ABI** binary in place.
- **After a build:** you've left the Electron-ABI binary in `node_modules/`. Run step 5 of the TL;DR (or manually: `Remove-Item $rel; Move-Item $parked $rel`) to restore the Node-ABI before dev will work again.

---

## Don't ever

- Skip `npm run build` (tsc) when any `src/` file has changed — electron-builder packages stale `dist/`. The version bumps, the fix doesn't ship. (See step 0 of the TL;DR.)
- Use `npm run dist` (Trap 1)
- Use `npx electron-builder` without `--config.npmRebuild=false` (Trap 2)
- Trust `npm run abi:dev` / `npm run abi:pack` from PowerShell (Trap 3)
- Use `Copy-Item` to swap the ABI without parking the locked file first (Trap 4)
- Remove or bypass `electron/launch.mjs` (Trap 5)
- Ship without confirming `Get-FileHash` on the packaged binary matches the Electron-ABI cache (Trap 5 verification)
- Ship without `Select-String`-confirming the new source identifier is present in the *packaged* `dist/server.js` (step 4b)
