// 截图框选窗口的 preload
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('capture', {
  onImage: (fn) => ipcRenderer.on('capture:image', (_e, url) => fn(url)),
  done: (sel) => ipcRenderer.send('capture:done', sel),
  cancel: () => ipcRenderer.send('capture:cancel'),
});
