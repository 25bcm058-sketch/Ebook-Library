/**
 * index.ts — Electron main process entry point.
 *
 * Boots the embedded Fastify API on a random loopback port with a fresh
 * per-launch bearer token, then opens a hardened BrowserWindow pointed at
 * that server. The renderer never sees the token except through the
 * contextBridge API exposed by src/preload/index.ts — it is never placed
 * in the URL (would leak via history/logs) and never in a query string.
 */
import { app, BrowserWindow, session, ipcMain, dialog } from 'electron';
import path from 'node:path';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { openDatabase, type Db } from './db';
import { buildServer } from './server';
import type { FastifyInstance } from 'fastify';

let mainWindow: BrowserWindow | null = null;
let db: Db | null = null;
let server: FastifyInstance | null = null;
let appInfo: { apiUrl: string; token: string; version: string } | null = null;

// Single instance: a second launch just focuses the existing window instead
// of opening a second local DB/port pair against the same user data dir.
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

  app.whenReady().then(main).catch((err) => {
    // eslint-disable-next-line no-console
    console.error('Fatal startup error:', err);
    app.quit();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) main().catch(() => app.quit());
  });

  app.on('before-quit', () => {
    try {
      server?.close();
    } catch {
      /* best effort */
    }
    try {
      db?.close();
    } catch {
      /* best effort */
    }
  });
}

async function main(): Promise<void> {
  const userDataDir = app.getPath('userData');
  db = openDatabase(userDataDir);

  const token = crypto.randomBytes(32).toString('hex');
  const rendererDir = path.join(__dirname, '..', 'renderer');
  const fastifyApp = buildServer({ db, userDataDir, token, rendererDir });
  server = fastifyApp;

  // Port 0 = OS assigns a free ephemeral port; loopback-only, never
  // advertised, so nothing on the LAN can reach this even accidentally.
  await fastifyApp.listen({ port: 0, host: '127.0.0.1' });
  const address = fastifyApp.server.address() as AddressInfo;
  appInfo = { apiUrl: `http://127.0.0.1:${address.port}`, token, version: app.getVersion() };

  ipcMain.handle('shelfmark:get-app-info', () => appInfo);
  ipcMain.handle('shelfmark:pick-files', async () => {
    if (!mainWindow) return [];
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Import books',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'E-books & comics', extensions: ['epub', 'pdf', 'mobi', 'azw3', 'azw', 'cbz', 'cbr', 'cb7', 'fb2'] },
      ],
    });
    return result.canceled ? [] : result.filePaths;
  });
  ipcMain.handle('shelfmark:pick-image', async () => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose cover image',
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif'] }],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  // Strict CSP: the page may only talk to our own loopback API. No remote
  // scripts, no inline scripts (app.js is a separate file), no eval.
  const csp = [
    "default-src 'self'",
    `connect-src 'self' ${appInfo.apiUrl}`,
    "img-src 'self' data: blob:",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
      },
    });
  });

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: 'Shelfmark',
    backgroundColor: '#111318',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  mainWindow.setMenuBarVisibility(false);

  await mainWindow.loadURL(appInfo.apiUrl + '/');

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}
