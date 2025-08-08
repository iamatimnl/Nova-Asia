const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const wavPlayer = require('node-wav-player');


// 使用 __dirname 来动态定位路径，避免硬编码绝对路径
const dingPath = path.join(__dirname, 'assets', 'ding.wav');
const flaskAppPath = path.join(__dirname, '..', 'app.py');
const flaskAppDir = path.dirname(flaskAppPath);

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
  const pythonPath = process.platform === 'win32' ? 'python' : 'python3';

  flaskProcess = spawn(pythonPath, [flaskAppPath], {
    cwd: flaskAppDir,
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


ipcMain.handle('print-receipt', async (event, order) => {
  try {
    if (typeof order === 'string') {
      try {
        order = JSON.parse(order);
      } catch (_) {
        order = {};
      }
    }

    const printWindow = new BrowserWindow({ show: false });
    const html = generateReceiptHTML(order || {});
    printWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

    printWindow.webContents.on('did-finish-load', () => {
      printWindow.webContents.print({ silent: true, printBackground: true }, (success, errorType) => {
        if (!success) console.error('打印失败:', errorType);
        printWindow.close();
      });
    });
  } catch (err) {
    console.error('❌ 打印失败:', err);
  }
});

function generateReceiptHTML(order) {
  const itemsHtml = Object.entries(order.items || {})
    .map(([name, item]) => {
      const qty = item.qty || 0;
      const price = item.price || 0;
      const total = (qty * price).toFixed(2);
      return `<div>${qty} x ${name} = €${total}</div>`;
    })
    .join('');

  const extraLines = [];
  if (order.verpakking != null)
    extraLines.push(`<div>Verpakkingskosten: €${parseFloat(order.verpakking).toFixed(2)}</div>`);
  if (order.bezorging != null)
    extraLines.push(`<div>Bezorgkosten: €${parseFloat(order.bezorging).toFixed(2)}</div>`);
  if (order.korting != null)
    extraLines.push(`<div>Korting: -€${parseFloat(order.korting).toFixed(2)}</div>`);
  if (order.btw != null)
    extraLines.push(`<div>BTW: €${parseFloat(order.btw).toFixed(2)}</div>`);

  return `<!DOCTYPE html><html><head><meta charset="utf-8" />
  <style>
    body { font-family: monospace; margin: 0; }
    .receipt { width: 260px; padding: 10px; }
    .center { text-align: center; }
  </style></head><body>
  <div class="receipt">
    <div class="center"><strong>Nova Asia</strong></div>
    <div>------------------------------</div>
    <div>Bestelnummer: ${order.order_number || '-'}</div>
    <div>Naam: ${order.customer_name || '-'}</div>
    <div>Type: ${order.order_type === 'pickup' ? 'Afhalen' : 'Bezorgen'}</div>
    <div>Tijd: ${order.pickup_time || order.delivery_time || '-'}</div>
    <div>Adres: ${order.street || ''} ${order.house_number || ''}</div>
    <div>${order.postcode || ''} ${order.city || ''}</div>
    <div>------------------------------</div>
    <div>Items:</div>
    ${itemsHtml}
    <div>------------------------------</div>
    ${extraLines.join('')}
    <div><strong>TOTAAL: €${parseFloat(order.totaal || 0).toFixed(2)}</strong></div>
    <div>------------------------------</div>
    <div>Opmerking: ${order.opmerking || '-'}</div>
    <div class="center">Bedankt voor uw bestelling!</div>
    <div class="center">Bestel via www.novaasia.nl</div>
    <div class="center">en ontvang 3% herhaalkorting!</div>
  </div>
  </body></html>`;
}
