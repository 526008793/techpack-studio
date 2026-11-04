import { contextBridge, ipcRenderer } from "electron";
import type { DesktopApi } from "../shared/model";
const api: DesktopApi = {
  platform: process.platform,
  choosePdf: () => ipcRenderer.invoke("techpack:choose-pdf"),
  chooseTemplate: () => ipcRenderer.invoke("techpack:choose-template"),
  settings: () => ipcRenderer.invoke("techpack:settings"),
  saveSettings: (value) => ipcRenderer.invoke("techpack:save-settings", value),
  cacheSettings: () => ipcRenderer.invoke("techpack:cache-settings"),
  chooseCacheDirectory: () =>
    ipcRenderer.invoke("techpack:choose-cache-directory"),
  resetCacheDirectory: () =>
    ipcRenderer.invoke("techpack:reset-cache-directory"),
  clearCache: () => ipcRenderer.invoke("techpack:clear-cache"),
  uninstallApp: () => ipcRenderer.invoke("techpack:uninstall-app"),
  analyze: (value) => ipcRenderer.invoke("techpack:analyze", value),
  cancelAnalysis: () => ipcRenderer.invoke("techpack:cancel-analysis"),
  export: (value) => ipcRenderer.invoke("techpack:export", value),
  sample: () => ipcRenderer.invoke("techpack:sample"),
  loadData: () => ipcRenderer.invoke("techpack:load-data"),
  saveData: (value) => ipcRenderer.invoke("techpack:save-data", value),
  openExport: (file, folder) =>
    ipcRenderer.invoke("techpack:open-export", file, folder),
  onProgress(callback) {
    const listener = (_event: unknown, value: string) => callback(value);
    ipcRenderer.on("techpack:progress", listener);
    return () => ipcRenderer.removeListener("techpack:progress", listener);
  },
};
contextBridge.exposeInMainWorld("techpack", api);
