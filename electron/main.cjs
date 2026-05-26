/**
 * Murmur Lite — Electron Main Process
 *
 * Boots in this order:
 *   1. Start the search daemon (bundled Python exe in packaged build, or system Python in dev)
 *   2. Start the Node server (as a child process, same src/server.ts via tsx in dev, compiled JS in prod)
 *   3. Wait for server to listen on port 3456
 *   4. Open BrowserWindow pointing at http://127.0.0.1:3456
 */

const { app, BrowserWindow, shell } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');

const SERVER_PORT = 3456;
const DAEMON_PORT = 3457;
const isDev = !app.isPackaged;

// Paths differ dev vs packaged
// Dev:     __dirname = ...\electron\         (source checkout)
// Packed:  __dirname = ...\resources\app\electron\
const APP_ROOT = path.join(__dirname, '..');
const RESOURCES_ROOT = isDev ? APP_ROOT : process.resourcesPath;

let serverProcess = null;
let daemonProcess = null;
let mainWindow = null;

// File logging for packaged builds where console.log is invisible.
// Path resolved lazily because app.getPath('userData') is not available before app.whenReady().
let _logFd = null;
function getLogFd() {
  if (_logFd) return _logFd;
  try {
    const logsDir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    const logFile = path.join(logsDir, 'murmur-lite.log');
    _logFd = fs.openSync(logFile, 'a');
    fs.writeSync(_logFd, `\n=== Murmur Lite session ${new Date().toISOString()} ===\n`);
  } catch { /* swallow; logging must never crash main */ }
  return _logFd;
}

function log(...args) {
  const line = '[' + new Date().toISOString() + '] ' + args.join(' ');
  console.log('[Electron]', ...args);
  const fd = getLogFd();
  if (fd) { try { fs.writeSync(fd, line + '\n'); } catch {} }
}

// --- Daemon (bundled Python exe) ---
function startDaemon() {
  // In dev: assume system Python. In packaged: use bundled exe from resources/daemon/search.exe
  const daemonExe = isDev
    ? null // dev mode uses the Node server's startDaemon() which calls `python search.py`
    : path.join(RESOURCES_ROOT, 'daemon', 'search.exe');

  if (isDev) {
    log('Dev mode: Node server will start Python daemon itself');
    return;
  }

  if (!fs.existsSync(daemonExe)) {
    log('Warning: bundled daemon not found at', daemonExe, '— semantic search will be unavailable');
    return;
  }

  log('Starting bundled daemon:', daemonExe);
  daemonProcess = spawn(daemonExe, [], {
    cwd: APP_ROOT,
    env: { ...process.env, MURMUR_LITE_DATA_DIR: path.join(app.getPath('userData'), 'data') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  daemonProcess.stdout.on('data', d => log('[daemon]', d.toString().trim()));
  daemonProcess.stderr.on('data', d => log('[daemon:err]', d.toString().trim()));
  daemonProcess.on('exit', code => log('[daemon] exited with code', code));
}

// --- Server (Node Express + WebSocket) ---
async function isServerRunning() {
  return new Promise(resolve => {
    const req = http.get(`http://127.0.0.1:${SERVER_PORT}/`, res => {
      res.destroy();
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(500, () => { req.destroy(); resolve(false); });
  });
}

async function startServer() {
  // If a server is already running (dev convenience, e.g. tsx watch is already up), just use it
  if (await isServerRunning()) {
    log('Server already running on port', SERVER_PORT, '— reusing');
    return;
  }

  // Dev: run src/server.ts via tsx (bundled in node_modules).
  // Packaged: tsx is a devDependency and gets stripped by electron-builder, so we ship
  // compiled JS from `npm run build` and invoke it with Electron-as-Node.
  // Note: app files live at APP_ROOT (resources/app), NOT RESOURCES_ROOT (resources).
  // Packaged spawns electron/launch.mjs (a thin loader) rather than dist/server.js
  // directly — Electron-as-Node hangs silently when given the compiled ESM server.js
  // as its direct main module, but boots fine when a loader import()s it.
  let cmd, args;
  if (isDev) {
    const srcPath = path.join(APP_ROOT, 'src', 'server.ts');
    cmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    args = ['tsx', srcPath];
  } else {
    const launchPath = path.join(APP_ROOT, 'electron', 'launch.mjs');
    cmd = process.execPath;
    args = [launchPath];
  }

  log('Starting server:', cmd, args.join(' '));
  log('  cwd:', APP_ROOT);
  log('  isDev:', isDev, '  resourcesRoot:', RESOURCES_ROOT);
  log('  process.execPath:', process.execPath);
  try {
    serverProcess = spawn(cmd, args, {
      cwd: APP_ROOT,
      // shell:true breaks on packaged Windows because process.execPath contains spaces
      // ("Murmur Lite.exe") and cmd.exe splits on whitespace. Dev uses npx.cmd which
      // requires shell:true on Windows; packaged invokes the .exe directly without shell.
      shell: isDev && process.platform === 'win32',
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        // Data dir: in dev, use the project's data/ folder — the SAME dir plain
        // `npm run dev` uses — so `npm run desktop` and `npm run dev` always open
        // the same companion. In a packaged build, use the per-user userData dir.
        MURMUR_LITE_DATA_DIR: isDev
          ? path.join(APP_ROOT, 'data')
          : path.join(app.getPath('userData'), 'data'),
        MURMUR_LITE_ELECTRON: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    log('[server] spawn threw:', err && err.stack || String(err));
    return;
  }
  serverProcess.stdout.on('data', d => log('[server]', d.toString().trim()));
  serverProcess.stderr.on('data', d => log('[server:err]', d.toString().trim()));
  serverProcess.on('error', err => log('[server] error event:', err && err.stack || String(err)));
  serverProcess.on('exit', (code, signal) => log('[server] exited with code', code, 'signal', signal));
}

// --- Wait for server to be ready ---
function waitForServer(timeoutMs = 30000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tryConnect = () => {
      const req = http.get(`http://127.0.0.1:${SERVER_PORT}/`, res => {
        res.destroy();
        resolve();
      });
      req.on('error', () => {
        if (Date.now() - start > timeoutMs) return reject(new Error('Server did not start in time'));
        setTimeout(tryConnect, 300);
      });
    };
    tryConnect();
  });
}

// --- Window ---
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0a0612',
    title: 'Murmur Lite',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // External links open in default browser, not in-app
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.loadURL(`http://127.0.0.1:${SERVER_PORT}/`);
  mainWindow.on('closed', () => { mainWindow = null; });
}

// --- Lifecycle ---
app.whenReady().then(async () => {
  startDaemon();
  await startServer();
  try {
    await waitForServer();
  } catch (err) {
    log('Server boot failed:', err.message);
  }
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  log('Shutting down child processes...');
  if (serverProcess) { try { serverProcess.kill(); } catch {} }
  if (daemonProcess) { try { daemonProcess.kill(); } catch {} }
});
