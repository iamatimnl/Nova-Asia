const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // ✅ 打开新窗口（例如 login.html → pos）
  openWindow: (file) => {
    ipcRenderer.send('open-window', file);
  },

  // ✅ 播放提示音（循环播放）
  playDing: () => ipcRenderer.send('play-ding'),

  // ✅ 停止提示音
  stopDing: () => ipcRenderer.send('stop-ding'),

  // ✅ 可选：用于接收登录成功的通知
  onLoginSuccess: (callback) => ipcRenderer.on('login-success', callback)
});
