// preload.js
console.log('[preload] loaded');
const { contextBridge, ipcRenderer } = require('electron');

/* -------------------- 业务 API：声音 / 打印 / 登录事件 -------------------- */
let dingAudio = null;

contextBridge.exposeInMainWorld('api', {
  getGoogleMapsKey: () => ipcRenderer.invoke('get-google-maps-key'),

  // 让“主进程”处理或转发到渲染端
  playDing: () => ipcRenderer.send('play-ding'),
  stopDing:  () => ipcRenderer.send('stop-ding'),

  // 打印（invoke/handle）
  printReceipt: (text) => ipcRenderer.invoke('print-receipt', text),

  // 登录成功事件（主进程 -> 渲染端）
  onLoginSuccess: (callback) => {
    const handler = (_evt, payload) => callback?.(payload);
    ipcRenderer.on('login-success', handler);
    return () => ipcRenderer.removeListener('login-success', handler);
  }
});

// （可选）在渲染进程本地播放 ding：主进程发事件“play-ding-in-renderer/stop-ding-in-renderer”
ipcRenderer.on('play-ding-in-renderer', () => {
  try {
    if (!dingAudio) {
      // 确保路径对你的页面可访问（相对 index.html 的静态目录）
      dingAudio = new Audio('/assets/ding.wav');
      dingAudio.loop = true;
    }
    void dingAudio.play();
  } catch (err) { console.error('🔊 播放失败:', err); }
});
ipcRenderer.on('stop-ding-in-renderer', () => {
  if (dingAudio) { dingAudio.pause(); dingAudio.currentTime = 0; }
});

/* -------------------- DB 通道：保存 / 批量同步 / 更新 / 查询 -------------------- */
contextBridge.exposeInMainWorld('electron', {
  ipcRenderer: {
    // 通用（保底）
    invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),

    // 写入 / 同步
    saveOrder:       (payload)      => ipcRenderer.invoke('db:save-order', payload),
    upsertBatch:     (orders)       => ipcRenderer.invoke('db:upsert-batch', orders),

    // 更新
    updateOrderById:     (id, patch)    => ipcRenderer.invoke('db:update-order-by-id', Number(id), patch || {}),
    updateOrderByNumber: (no, patch)    => ipcRenderer.invoke('db:update-order-by-number', String(no), patch || {}),

    // 查询
    getOrdersToday:      ()             => ipcRenderer.invoke('db:get-orders-today'),
    getOrderByNumber:    (no)           => ipcRenderer.invoke('db:get-order-by-number', String(no)),
    getOrderById:        (id)           => ipcRenderer.invoke('db:get-order-by-id', Number(id)),
    listRecent:          (limit = 50)   => ipcRenderer.invoke('db:list-recent', Number(limit)),
  }
});
/* -------------------- 兼容层：暴露 window.pos.* 给前端 -------------------- */
contextBridge.exposeInMainWorld('pos', {
  // 写入 / 同步
  saveOrder:       (payload)    => ipcRenderer.invoke('db:save-order', payload),
  upsertBatch:     (orders)     => ipcRenderer.invoke('db:upsert-batch', orders),

  // 更新
  updateOrderById:     (id, patch) => ipcRenderer.invoke('db:update-order-by-id', Number(id), patch || {}),
  updateOrderByNumber: (no, patch) => ipcRenderer.invoke('db:update-order-by-number', String(no), patch || {}),

  // 查询
  getOrdersToday:   ()            => ipcRenderer.invoke('db:get-orders-today'),
  getOrderByNumber: (no)          => ipcRenderer.invoke('db:get-order-by-number', String(no)),
  getOrderById:     (id)          => ipcRenderer.invoke('db:get-order-by-id', Number(id)),
  listRecent:       (limit = 50)  => ipcRenderer.invoke('db:list-recent', Number(limit)),
});
