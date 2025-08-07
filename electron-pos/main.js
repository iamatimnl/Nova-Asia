const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const wavPlayer = require('node-wav-player');
const escpos = require('escpos');
escpos.USB = require('escpos-usb');


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



ipcMain.handle('print-receipt', async (event, orderText, orderData = {}) => {
  try {
    const device = new escpos.USB();
    const printer = new escpos.Printer(device);

    device.open(() => {
      printer
        .encode('UTF-8')
        .align('CT')
        .style('B')
        .size(2, 2)
        .text('Nova Asia')
        .size(1, 1)
        .style('NORMAL')
        .text('------------------------------')
        .align('LT')
        .text(`Bestelnummer: ${orderData.order_number || '-'}`)
        .text(`Naam: ${orderData.customer_name || '-'}`)
        .text(`Type: ${orderData.order_type === 'pickup' ? 'Afhalen' : 'Bezorgen'}`)
        .text(`Tijd: ${orderData.pickup_time || orderData.delivery_time || '-'}`)
        .text(`Adres: ${orderData.street || ''} ${orderData.house_number || ''}`)
        .text(`${orderData.postcode || ''} ${orderData.city || ''}`)
        .text('------------------------------')
        .text('Items:');

      for (const [name, item] of Object.entries(orderData.items || {})) {
        const qty = item.qty || 0;
        const price = item.price || 0;
        const total = (qty * price).toFixed(2);
        printer.text(`${qty} x ${name}  = €${total}`);
      }

      printer.text('------------------------------');

      if (orderData.verpakking != null)
        printer.text(`Verpakkingskosten: €${parseFloat(orderData.verpakking).toFixed(2)}`);
      if (orderData.bezorging != null)
        printer.text(`Bezorgkosten:     €${parseFloat(orderData.bezorging).toFixed(2)}`);
      if (orderData.korting != null)
        printer.text(`Korting:         -€${parseFloat(orderData.korting).toFixed(2)}`);
      if (orderData.btw != null)
        printer.text(`BTW:              €${parseFloat(orderData.btw).toFixed(2)}`);

      printer
        .style('B')
        .text(`TOTAAL:           €${parseFloat(orderData.totaal).toFixed(2)}`)
        .style('NORMAL');

      printer.text('------------------------------');
      printer.text(`Opmerking: ${orderData.opmerking || '-'}`);
      printer.text('');
      printer.align('CT');
      printer.text('Bedankt voor uw bestelling!');
      printer.text('Bestel via www.novaasia.nl');
      printer.text('en ontvang 3% herhaalkorting!');
      printer.cut().close();
    });
  } catch (err) {
    console.error('❌ 打印失败:', err);
  }
});
// ✅ 允许前端通过 preload.js 获取 Google Maps API Key
ipcMain.handle('get-google-maps-key', () => {
  return 'AIzaSyBSESvrZ03Xq0SdaV6X5dESf-fDHOgEGHU'; // 用你的实际 key 替换
});
