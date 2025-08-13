// preload.js
console.log('[preload] loaded');
const { contextBridge, ipcRenderer } = require('electron');

let dingAudio = null;

// —— 暴露给渲染端：业务 API（声音、打印、登录回调、密钥）
contextBridge.exposeInMainWorld('api', {
  getGoogleMapsKey: () => ipcRenderer.invoke('get-google-maps-key'),

  // 声音：渲染端 -> 主进程（让主进程控制或转发到渲染）
  playDing: () => ipcRenderer.send('play-ding'),
  stopDing:  () => ipcRenderer.send('stop-ding'),

  // 打印：渲染端 -> 主进程（invoke ⇢ handle）
  printReceipt: (text) => ipcRenderer.invoke('print-receipt', text),

  // 如果“主进程发事件给渲染端”再用这个监听（win.webContents.send('login-success')）
  onLoginSuccess: (callback) => {
    ipcRenderer.on('login-success', (_evt, payload) => callback?.(payload));
    return () => ipcRenderer.removeAllListeners('login-success');
  }
});

// —— 可选：在渲染进程本地播放 ding（如果主进程用 webContents 触发）
ipcRenderer.on('play-ding-in-renderer', () => {
  if (!dingAudio) {
    dingAudio = new Audio('assets/ding.wav');
    dingAudio.loop = true;
  }
  dingAudio.play().catch(err => console.error('🔊 播放失败:', err));
});
ipcRenderer.on('stop-ding-in-renderer', () => {
  if (dingAudio) { dingAudio.pause(); dingAudio.currentTime = 0; }
});

// —— 暴露数据库桥
contextBridge.exposeInMainWorld('pos', {
  saveOrder:      (payload) => ipcRenderer.invoke('db:save-order', payload),
  getOrdersToday: () => ipcRenderer.invoke('db:get-orders-today'),
  ping:           () => ipcRenderer.invoke('db:ping')
});
