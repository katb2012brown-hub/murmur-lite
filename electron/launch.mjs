/**
 * Murmur Lite — server launcher
 *
 * main.cjs spawns THIS file (via Electron-as-Node), not dist/server.js directly.
 *
 * Why the indirection: when Electron-as-Node is given the compiled ESM server.js
 * as its *direct* main module, startup hangs silently — no output, no exit, no
 * crash (diagnosed May 2026). Loading the exact same server.js through a dynamic
 * import() from a thin loader module boots it cleanly every time. The loader is
 * the launch entry; server.js becomes a regular imported module.
 */
import('../dist/server.js').catch((err) => {
  console.error('[launch] server.js failed to load:', err && err.stack || err);
  process.exit(1);
});
