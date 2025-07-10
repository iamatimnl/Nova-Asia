const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('env', {
  SOCKET_URL: process.env.SOCKET_URL
});
