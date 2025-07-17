const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const wavPlayer = require('node-wav-player');
const dingPath = path.join(__dirname, 'assets', 'ding.wav');

let mainWindow;
let flaskProcess;
let stopDing = false;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 900,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  // 默认先加载 login 页面
  mainWindow.loadURL('http://localhost:5000/login');
}

// 启动 Flask
function startFlaskServer() {
  const pythonPath = 'python';
  const appPath = path.join(__dirname, '..', 'app.py'); // 如果 Flask 在上层目录
  const appDir = path.dirname(appPath);

  flaskProcess = spawn(pythonPath, [appPath], {
    cwd: appDir,
    shell: false
  });

  flaskProcess.stdout.on('data', (data) => console.log('[Flask]', data.toString()));
  flaskProcess.stderr.on('data', (data) => console.error('[Flask 错误]', data.toString()));
  flaskProcess.on('exit', (code) => console.log(`Flask 进程退出，代码 ${code}`));
}

app.whenReady().then(() => {
  startFlaskServer();
  setTimeout(createWindow, 1500); // 延迟加载，确保 Flask 启动
});

ipcMain.on('login-success', () => {
  if (mainWindow) {
    mainWindow.loadURL('http://localhost:5000/pos');
  }
});

ipcMain.on('play-ding', () => {
  stopDing = false;
  function loop() {
    if (stopDing) return;
    wavPlayer.play({ path: dingPath }).then(() => {
      if (!stopDing) setTimeout(loop, 1000);
    });
  }
  loop();
});

ipcMain.on('stop-ding', () => {
  stopDing = true;
});

app.on('window-all-closed', () => {
  if (flaskProcess) flaskProcess.kill();
  if (process.platform !== 'darwin') app.quit();
});
