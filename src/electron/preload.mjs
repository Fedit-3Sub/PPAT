import { contextBridge, ipcRenderer } from 'electron';

// Expose a minimal, safe API to the renderer
contextBridge.exposeInMainWorld('se9', {
  getVersion: () => ipcRenderer.invoke('app:getVersion'),
  openDirectory: () => ipcRenderer.invoke('dialog:openDirectory'),
  readTextFile: (filePath) => ipcRenderer.invoke('fs:readTextFile', filePath),
  writeTextFile: (filePath, data) => ipcRenderer.invoke('fs:writeTextFile', filePath, data),
  saveJson: (defaultFileName, data) => ipcRenderer.invoke('dialog:saveJson', defaultFileName, data),
  openJson: () => ipcRenderer.invoke('dialog:openJson'),
  onCommand: (cb) => {
    if (typeof cb !== 'function') return () => {};
    const listener = (_event, cmd) => {
      try { cb(cmd); } catch {}
    };
    ipcRenderer.on('editor:command', listener);
    return () => ipcRenderer.off('editor:command', listener);
  }
});
