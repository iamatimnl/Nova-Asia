const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // ✅ 获取 Google Maps Key（从主进程请求）
  getGoogleMapsKey: () => ipcRenderer.invoke('get-google-maps-key'),

  // ✅ 播放提示音（循环播放）
  playDing: () => ipcRenderer.send('play-ding'),

  // ✅ 停止提示音
  stopDing: () => ipcRenderer.send('stop-ding'),

  // ✅ 打印小票（发送订单数据到主进程）
  printReceipt: (order) => ipcRenderer.invoke('print-receipt', order),

  // ✅ 登录成功回调（保留）
  onLoginSuccess: (callback) => ipcRenderer.on('login-success', callback)
});
