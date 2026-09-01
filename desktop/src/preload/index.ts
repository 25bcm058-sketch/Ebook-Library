/**
 * preload/index.ts — the only bridge between the renderer and Node/Electron.
 *
 * Exposes a small, typed surface via contextBridge; no raw `ipcRenderer` or
 * `require` ever reaches the page (contextIsolation + sandbox are both on
 * in index.ts). The renderer fetches the API URL + per-launch bearer token
 * once at startup through `getConfig()` — this is the only way the token
 * ever reaches page JS, so it never appears in the URL, in history, or in
 * any log line the app itself writes.
 */
import { contextBridge, ipcRenderer } from 'electron';

export interface AppConfig {
  apiUrl: string;
  token: string;
  version: string;
}

const api = {
  getConfig: (): Promise<AppConfig> => ipcRenderer.invoke('shelfmark:get-app-info'),
  pickFiles: (): Promise<string[]> => ipcRenderer.invoke('shelfmark:pick-files'),
  pickImage: (): Promise<string | null> => ipcRenderer.invoke('shelfmark:pick-image'),
};

export type ShelfmarkBridge = typeof api;

contextBridge.exposeInMainWorld('shelfmark', api);
