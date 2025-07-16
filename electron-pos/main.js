const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

function createWindow(file = 'login.html') {
  const win = new BrowserWindow({
    width: 1024,
    height: 768,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js')
    }
  });
  win.loadFile(path.join(__dirname, 'public', file));
  return win;
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

ipcMain.on('open-window', (event, file) => {
  createWindow(file);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});