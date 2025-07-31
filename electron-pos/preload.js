const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // ✅ 打开新窗口（目前你用不到可省略）
  openWindow: (file) => {
    ipcRenderer.send('open-window', file);
  },

  // ✅ 播放提示音（循环播放）
  playDing: () => ipcRenderer.send('play-ding'),

  // ✅ 停止提示音
  stopDing: () => ipcRenderer.send('stop-ding'),

  // ✅ 打印小票（发送订单文本到主进程）
  printReceipt: (text) => ipcRenderer.invoke('print-receipt', text),

  // ✅ 登录成功回调（保留）
  onLoginSuccess: (callback) => ipcRenderer.on('login-success', callback)
});
