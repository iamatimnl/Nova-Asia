const { contextBridge, ipcRenderer } = require('electron');

let dingAudio;

contextBridge.exposeInMainWorld('api', {
  getGoogleMapsKey: () => ipcRenderer.invoke('get-google-maps-key'),
  playDing: () => ipcRenderer.send('play-ding'),
  stopDing: () => ipcRenderer.send('stop-ding'),
  printReceipt: (text) => ipcRenderer.invoke('print-receipt', text),
  onLoginSuccess: (callback) => ipcRenderer.on('login-success', callback)
});

// 🔊 播放 ding
ipcRenderer.on('play-ding-in-renderer', () => {
  if (!dingAudio) {
    dingAudio = new Audio('assets/ding.wav');
    dingAudio.loop = true;
  }
  dingAudio.play().catch(err => console.error('🔊 播放失败:', err));
});

// ⏹ 停止 ding
ipcRenderer.on('stop-ding-in-renderer', () => {
  if (dingAudio) {
    dingAudio.pause();
    dingAudio.currentTime = 0;
  }
});

// 本地 SQLite API（与 main.js 中 ipcMain.handle('local.*') 对齐）
contextBridge.exposeInMainWorld('localDB', {
  saveOrder: (order, source) => ipcRenderer.invoke('local.saveOrder', order, source),
  getOrderById: (id) => ipcRenderer.invoke('local.getOrderById', id),
  getOrderByNumber: (no) => ipcRenderer.invoke('local.getOrderByNumber', no),
  listRecent: (limit = 50) => ipcRenderer.invoke('local.listRecent', limit),
  getOrdersToday: () => ipcRenderer.invoke('local.getOrdersToday'),
});

// 兼容旧接口 window.pos.getOrdersToday()
contextBridge.exposeInMainWorld('pos', {
  getOrdersToday: () => ipcRenderer.invoke('local.getOrdersToday')
});
