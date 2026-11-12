'use strict';

/**
 * Electron wrapper.
 *
 * The whole application lives in the Node core; this file only provides a
 * native window around it. To use it:
 *   npm install --save-dev electron
 *   npm run desktop
 *
 * Requires roughly 250 MB of free disk for the Electron runtime.
 */

const { app, BrowserWindow, Menu, shell, dialog, desktopCapturer } = require('electron');
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs');

const { runtimeFile } = require('../core/paths');

let serverProcess = null;
let mainWindow = null;

function startServer() {
  const appDir = path.join(__dirname, '..');
  const serverEntry = path.join(appDir, 'server', 'main.js');

  // Packaged builds run through Electron's own binary: ELECTRON_RUN_AS_NODE
  // makes that binary behave like plain node instead of opening a second app.
  serverProcess = spawn(process.execPath, [serverEntry], {
    cwd: appDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });

  serverProcess.stdout?.on('data', (chunk) => process.stdout.write(`[server] ${chunk}`));
  serverProcess.stderr?.on('data', (chunk) => process.stderr.write(`[server] ${chunk}`));
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function portIsOpen(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => resolve(false));
    socket.setTimeout(1200, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

/**
 * Waits for the server to publish a runtime file, then checks that the port in
 * it really answers. runtime.json survives crashes, so an old file with a dead
 * pid must never be trusted.
 */
async function waitForUrl(timeoutMs = 20000) {
  const startedAt = Date.now();
  for (;;) {
    let runtime = null;
    try {
      runtime = JSON.parse(fs.readFileSync(runtimeFile(), 'utf8'));
    } catch {
      runtime = null;
    }

    if (runtime?.port && isProcessAlive(runtime.pid) && (await portIsOpen(runtime.port))) {
      return runtime.url;
    }
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('The local server did not answer in time. Reopen GUITinstal, or check your antivirus.');
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

async function createWindow() {
  startServer();

  let url;
  try {
    url = await waitForUrl();
  } catch (error) {
    dialog.showErrorBox('GUITinstal', error.message);
    app.quit();
    return;
  }

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 620,
    backgroundColor: '#050505',
    title: 'GUITinstal',
    autoHideMenuBar: true,
    icon: path.join(__dirname, '..', 'ui', 'icon-256.png'),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.webContents.session.setDisplayMediaRequestHandler(async (request, callback) => {
    let replied = false;
    const deny = () => {
      if (replied) return;
      replied = true;
      callback(null);
    };
    try {
      if (!request.videoRequested || !request.userGesture || request.securityOrigin !== new URL(url).origin) {
        deny();
        return;
      }

      const sources = await desktopCapturer.getSources({
        types: ['screen', 'window'],
        thumbnailSize: { width: 160, height: 90 },
        fetchWindowIcons: false,
      });
      const selectable = sources.slice(0, 10);
      if (!selectable.length) {
        deny();
        return;
      }

      const { response } = await dialog.showMessageBox(mainWindow, {
        type: 'question',
        title: 'Share one screen with GUITinstal',
        message: 'Choose the screen or window to analyze.',
        detail: 'GUITinstal captures one frame and analyzes it locally. It does not record video or send the image to an external provider.',
        buttons: [...selectable.map((source) => source.name), 'Cancel'],
        cancelId: selectable.length,
      });
      if (response < 0 || response >= selectable.length) {
        deny();
        return;
      }
      replied = true;
      callback({ video: selectable[response] });
    } catch (error) {
      console.error('[screen-capture] Could not open the native source picker:', error);
      deny();
    }
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.loadURL(url);

  // External links open in the real browser, never inside the app window.
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    shell.openExternal(target);
    return { action: 'deny' };
  });
}

app.whenReady().then(() => {
  // The product owns the whole window: no File/Edit/View/Window bar. Alt must
  // not reveal it either, so the application menu is removed, not hidden.
  Menu.setApplicationMenu(null);
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('before-quit', () => {
  if (serverProcess && !serverProcess.killed) {
    serverProcess.kill();
  }
});
