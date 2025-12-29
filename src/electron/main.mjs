import { app, BrowserWindow, ipcMain, dialog, shell, Menu } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isDev = !!process.env.VITE_DEV_SERVER_URL;

/** @type {BrowserWindow | null} */
let mainWindow = null;

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    show: false,
    backgroundColor: '#111111',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      preload: path.join(__dirname, 'preload.mjs')
    }
  });

  // Load renderer
  if (isDev) {
    const url = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173';
    mainWindow.loadURL(url);
    // In recent Electron versions, openDevTools returns void (not a Promise)
    // so calling .catch would throw. Wrap in try/catch instead.
    try {
      mainWindow.webContents.openDevTools({ mode: 'detach' });
    } catch {
      // no-op
    }
  } else {
    const indexPath = path.join(__dirname, '..', 'dist', 'index.html');
    mainWindow.loadFile(indexPath);
  }

  mainWindow.once('ready-to-show', () => mainWindow && mainWindow.show());

  // Open external links in default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// App lifecycle
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    createAppMenu();
    createMainWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// IPC: basic, safe APIs for future desktop features
ipcMain.handle('app:getVersion', () => app.getVersion());

ipcMain.handle('dialog:openDirectory', async () => {
  const res = await dialog.showOpenDialog({ properties: ['openDirectory'] });
  if (res.canceled || res.filePaths.length === 0) return null;
  return res.filePaths[0];
});

ipcMain.handle('fs:readTextFile', async (_e, filePath) => {
  if (typeof filePath !== 'string') throw new Error('Invalid path');
  return fs.readFile(filePath, 'utf8');
});

ipcMain.handle('fs:writeTextFile', async (_e, filePath, data) => {
  if (typeof filePath !== 'string') throw new Error('Invalid path');
  if (typeof data !== 'string') throw new Error('Invalid data');
  await fs.writeFile(filePath, data, 'utf8');
  return true;
});

// Scene JSON helpers
ipcMain.handle('dialog:saveJson', async (_e, defaultFileName, data) => {
  const res = await dialog.showSaveDialog({
    title: '씬 저장',
    defaultPath: defaultFileName || 'scene.se9.json',
    filters: [
      { name: 'SimEdit9 Scene', extensions: ['se9.json', 'json'] },
      { name: 'JSON', extensions: ['json'] }
    ]
  });
  if (res.canceled || !res.filePath) return null;
  await fs.writeFile(res.filePath, String(data ?? ''), 'utf8');
  return res.filePath;
});

ipcMain.handle('dialog:openJson', async () => {
  const res = await dialog.showOpenDialog({
    title: '씬 불러오기',
    properties: ['openFile'],
    filters: [
      { name: 'SimEdit9 Scene', extensions: ['se9.json', 'json'] },
      { name: 'JSON', extensions: ['json'] }
    ]
  });
  if (res.canceled || !res.filePaths || !res.filePaths.length) return null;
  const filePath = res.filePaths[0];
  const data = await fs.readFile(filePath, 'utf8');
  return { filePath, data };
});

function createAppMenu() {
  const isMac = process.platform === 'darwin';
  const sendCommand = (cmd) => {
    try {
      console.log('[CAM][MAIN] send editor:command →', cmd);
      mainWindow && mainWindow.webContents.send('editor:command', cmd);
    } catch {}
  };
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { type: 'separator' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      role: 'help',
      submenu: [
        {
          label: 'Learn More',
          click: async () => {
            await shell.openExternal('https://www.electronjs.org');
          }
        }
      ]
    }
  ];
  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}
