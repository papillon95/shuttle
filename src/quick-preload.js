// 快捷小窗的 preload：只暴露小窗需要的几个接口
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('quick', {
  state: () => ipcRenderer.invoke('quick:state'),
  ask: (question, quote) => ipcRenderer.invoke('quick:ask', question, quote),
  stop: () => ipcRenderer.invoke('quick:stop'),
  resize: (h) => ipcRenderer.invoke('quick:resize', h),
  hide: () => ipcRenderer.invoke('quick:hide'),
  sticky: (v) => ipcRenderer.invoke('quick:sticky', v),
  continueInMain: () => ipcRenderer.invoke('quick:continue'),
  copy: () => ipcRenderer.invoke('quick:copy'),
  openExternal: (url) => ipcRenderer.invoke('open:external', url),
  onOpen: (fn) => ipcRenderer.on('quick:open', () => fn()),
  onDelta: (fn) => ipcRenderer.on('quick:delta', (_e, d) => fn(d)),
  onDone: (fn) => ipcRenderer.on('quick:done', (_e, r) => fn(r)),
});
