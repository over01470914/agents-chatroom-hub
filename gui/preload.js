// 最小 preload。renderer 直接用瀏覽器的 fetch / WebSocket 連 hub，這裡只暴露版本資訊。
const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('agora', {
  versions: {
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
  },
});
