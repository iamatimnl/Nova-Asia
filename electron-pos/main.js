const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const wavPlayer = require('node-wav-player');

// 🔌 ESC/POS 打印支持
const escpos = require('escpos');
escpos.USB = require('escpos-usb');
// 可选：若你的 escpos 版本支持 profile，打开下面两行更稳
// const profile = escpos.profile ? escpos.profile('epson') : null;

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

  // Flask 可能还在启动，简单做个重试
  const target = 'http://localhost:5000/login';
  const tryLoad = (attempt = 0) => {
    mainWindow.loadURL(target).catch(() => {
      if (attempt < 10) setTimeout(() => tryLoad(attempt + 1), 500);
    });
  };
  tryLoad();
}

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

ipcMain.handle('get-google-maps-key', () => {
  return '';
});

app.whenReady().then(() => {
  startFlaskServer();
  setTimeout(createWindow, 1200);
});

ipcMain.on('login-success', () => {
  if (mainWindow) {
    mainWindow.loadURL('http://localhost:5000/pos').catch(() => {});
  }
});

ipcMain.on('play-ding', () => {
  stopDing = false;
  function loop() {
    if (stopDing) return;
    wavPlayer.play({ path: dingPath }).then(() => {
      if (!stopDing) setTimeout(loop, 1000);
    }).catch(() => {
      if (!stopDing) setTimeout(loop, 1500);
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


// ========= Config =========
const CONFIG = {
  TRANSPORT: 'USB',                 // 'USB' | 'NET'
  USB: { vid: 0x04B8, pid: 0x0E28 },// Epson TM-T20III
  NET: { host: '192.168.1.80', port: 9100 }, // 若切到网络打印，请改 IP
  WIDTH: 48,                        // 80mm = 48 列（Font A）
  RIGHT_RESERVE: 14,                // 右侧“数量+金额”预留宽度
  USE_BARCODE: true,                // 打印订单号条码（CODE128）
  USE_QR: true,                  // ✅ 打开二维码
  QR: {                          // ✅ 可选参数
    size: 6,                     // 模块大小(1-10)，6~8 通常最佳
    margin: 2,                   // 边距(像素/模块，依实现不同)
    caption: 'Scan om uw bestelling te volgen', // 二维码上方说明文字（可留空）
    align: 'ct'                  // 'ct' 居中，或 'lt'/'rt'
  },                    // 打印二维码（需传 order.qr_url）
  OPEN_CASH_DRAWER_WHEN_CASH: false,// 现金支付时弹钱箱
  SHOW_BTW_SPLIT: false,            // 显示 9%/21% BTW 分拆（需要传 btw_split）
  SHOP: {
    name: 'Nova Asia',
    cityTag: 'Hoofddorp',
    addressLine: 'Amkerkplein 4 2134DR Hoofddorp',
    tel: '0622599566   www.novaasia.nl',
    email: 'novaasianl@gmail.com'
  }
};
// USB 用 CP858（欧元清晰），网络常配 GB18030（支持中文）
const ENCODING = (CONFIG.TRANSPORT === 'NET') ? 'GB18030' : 'CP858';

// ========= Entry: print =========
ipcMain.handle('print-receipt', async (_evt, payload) => {
  try {
    const order = parseIncomingPayload(payload);
    if (!order) throw new Error('Empty payload');
    const norm = normalizeForPrint(order);      // 统一字段 & ZSM
    const err  = validateOrder(norm);           // 基础校验
    if (err) throw new Error(err);
    await doEscposPrint(norm);                  // 实际打印
    return { ok: true };
  } catch (e) {
    console.error('❌ print-receipt failed:', e);
    return { ok: false, error: String(e?.message || e) };
  }
});

// ========= Helpers: parse / normalize / validate =========
function parseIncomingPayload(input) {
  if (typeof input === 'string') {
    try { return JSON.parse(input); } catch (_) { return null; }
  }
  if (input && typeof input === 'object') {
    if (input.order) return input.order;
    return input;
  }
  return null;
}

function detectZSMByOrderNumber(no) {
  return /Z$/i.test(String(no || '').trim());
}

function normalizeForPrint(order) {
  const toStr = v => (v == null ? '' : String(v));
  const toNum = (v, d = 0) => (v == null || isNaN(Number(v)) ? d : Number(v));

  const typeRaw = toStr(order.order_type || order.type || '').toLowerCase();
  const isDelivery = typeRaw.includes('bezorg') || typeRaw.includes('delivery') || order.delivery === true;

  // ZSM：优先后端字段，其次用单号末尾 Z 推断
  const is_zsm = (order.is_zsm === true) || detectZSMByOrderNumber(order.order_number);

  // 时间显示：ZSM 优先，否则显示具体时间
  const slotRaw = order.tijdslot || order.tijdslot_display || order.pickup_time || order.delivery_time || '';
  const tijdslot_display = is_zsm ? 'Z.S.M.' : toStr(slotRaw).trim();
  const discount   = toNum(order.korting ?? order.discount, 0);

  // items：兼容对象/数组
  let items;
  if (Array.isArray(order.items)) {
    items = order.items.map(i => ({
      name: i.displayName || i.name,
      qty:  toNum(i.qty, 1),
      price:toNum(i.price, 0),
      options: i.options,
      note: i.note || i.remark
    }));
  } else {
    items = Object.entries(order.items || {}).map(([name, i]) => ({
      name: (i.displayName || i.name || name),
      qty:  toNum(i.qty, 1),
      price:toNum(i.price, 0),
      options: i.options,
      note: i.note || i.remark
    }));
  }

  // 金额字段
  const subtotal   = (order.subtotal ?? order.sub_total) != null ? toNum(order.subtotal ?? order.sub_total, 0) : null;
  const packaging  = toNum(order.verpakkingskosten ?? order.packaging ?? order.package_fee, 0);
  const delivery   = toNum(order.bezorgkosten ?? order.delivery_cost ?? order.delivery_fee, 0);
  const tip        = toNum(order.fooi ?? order.tip, 0);
  const totalGiven = (order.totaal ?? order.total);
  const total      = (totalGiven != null) ? toNum(totalGiven, 0) :
                     (subtotal != null ? (subtotal + packaging + delivery + tip - discount) : null);
  const vat        = (order.vat != null || order.btw != null) ? toNum(order.vat ?? order.btw, 0) : null;

  return {
    // 标识 & 客户
    order_number: toStr(order.order_number || order.id),
    customer_name: toStr(order.customer_name || order.name),
    phone: toStr(order.phone || order.telefoon),
    email: toStr(order.email),
    created_at: toStr(order.created_at || order.time || order.timestamp),
    opmerking: toStr(order.opmerking || order.remark || order.note),
    payment_method: toStr(order.payment_method || order.pay_method || order.payment),

    // 时间
    is_zsm,
    tijdslot: tijdslot_display,

    // 地址（Afhaal不打印地址，但这里仍然保留字段）
    street: toStr(order.street),
    house_number: toStr(order.house_number || order.housenumber),
    postcode: toStr(order.postcode || order.postal_code),
    city: toStr(order.city || order.town),

    // 订单类型
    type: typeRaw,
    delivery: !!isDelivery,

    // 明细/金额
    items,
    subtotal,
    packaging,
    discount,
    delivery_fee: delivery,
    tip,
    vat,
    total,

    // 可选项
    btw_split: order.btw_split || undefined,
    qr_url: order.qr_url || undefined
  };
}

function validateOrder(o) {
  if (!o.order_number) return 'order_number missing';
  if (!Array.isArray(o.items) || o.items.length === 0) return 'items empty';
  return null;
}

async function doEscposPrint(order) {
  let device, printer;
  const WIDTH = CONFIG.WIDTH;
  const RIGHT = CONFIG.RIGHT_RESERVE;

  // ===== 切刀配置（可在此微调）=====
  const CUT_CFG = {
    strategy: CONFIG.CUT_STRATEGY || 'atomic', // 'atomic' | 'split'
    mode:     CONFIG.CUT_MODE     || 'partial',// 'partial' | 'full'
    atomic_feed_n: CONFIG.FEED_BEFORE_CUT ?? 6,
    split_feed_lines: 6,
    split_feed_dots:  48,
    wait_after_feed_ms: 200,
    wait_after_cut_ms:  800
  };

  // ========== helpers ==========
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const money = n => Number(n || 0).toFixed(2);
  const moneyStr = (n, sign = '') => `${sign}EUR ${money(n)}`;
  const line = (ch='-') => printer.text(ch.repeat(WIDTH));

  const wrap = (text, width) => {
    const t = String(text || '');
    const out = [];
    let cur = '';
    for (const ch of t) {
      if (cur.length + 1 > width) { out.push(cur); cur = ''; }
      cur += ch;
    }
    if (cur) out.push(cur);
    return out;
  };

  const col2 = (left, right) => {
    const L = String(left ?? '');
    const R = String(right ?? '');
    const spaces = Math.max(1, WIDTH - L.length - R.length);
    printer.text(L + ' '.repeat(spaces) + R);
  };

  const printIfValue = (label, value, sign='') => {
    if (value == null) return;
    if (Number(value) === 0) return;
    col2(label, moneyStr(value, sign));
  };

  // —— 数量在前 ——  {qty}x {name} .... EUR xx.xx
  const printItem = (name, qty, total, opts = []) => {
    const q = Number.isFinite(Number(qty)) ? Number(qty) : 1;
    const qtyStr = `${q}x `;
    const right  = moneyStr(total);
    const nameWidth = Math.max(1, WIDTH - RIGHT - qtyStr.length);
    const lines = wrap(String(name || '-'), nameWidth);

    const pad = Math.max(1, WIDTH - qtyStr.length - lines[0].length - right.length);
    printer.text(qtyStr + lines[0] + ' '.repeat(pad) + right);

    for (let i = 1; i < lines.length; i++) {
      printer.text(' '.repeat(qtyStr.length) + lines[i]);
    }

    if (Array.isArray(opts) && opts.length) {
      for (const s of opts) {
        const wrapped = wrap(String(s), Math.max(1, WIDTH - qtyStr.length - 3)); // "  - "
        for (let j = 0; j < wrapped.length; j++) {
          const prefix = j === 0 ? '  - ' : '    ';
          printer.text(' '.repeat(qtyStr.length) + prefix + wrapped[j]);
        }
      }
    }
  };

  // 低层原始命令
  const raw = (buf) => { try { printer.raw(buf); } catch {} };
  const esc_d_lines = (n=1) => raw(Buffer.from([0x1B, 0x64, Math.max(1, Math.min(255, n))])); // ESC d n
  const esc_J_dots  = (n=24) => raw(Buffer.from([0x1B, 0x4A, Math.max(1, Math.min(255, n))])); // ESC J n

  // —— 切刀（只切一次）——
  const cutOnce = async () => {
    try { printer.align('lt').style('NORMAL').size(0, 0); } catch {}

    if (CUT_CFG.strategy === 'atomic') {
      const n = Math.max(0, Math.min(255, CUT_CFG.atomic_feed_n));
      const m = (CUT_CFG.mode === 'full') ? 0x41 : 0x42;
      raw(Buffer.from([0x1D, 0x56, m, n]));
      await sleep(CUT_CFG.wait_after_cut_ms);
      return;
    }

    if (CUT_CFG.split_feed_lines > 0) esc_d_lines(CUT_CFG.split_feed_lines);
    if (CUT_CFG.split_feed_dots  > 0) esc_J_dots(CUT_CFG.split_feed_dots);
    await sleep(CUT_CFG.wait_after_feed_ms);

    const m_simple = (CUT_CFG.mode === 'full') ? 0x00 : 0x01; // GS V 0/1
    raw(Buffer.from([0x1D, 0x56, m_simple]));
    await sleep(CUT_CFG.wait_after_cut_ms);
  };

  // ========== device ==========
  device = (CONFIG.TRANSPORT === 'NET')
    ? new escpos.Network(CONFIG.NET.host, CONFIG.NET.port)
    : (CONFIG.USB?.vid && CONFIG.USB?.pid ? new escpos.USB(CONFIG.USB.vid, CONFIG.USB.pid) : new escpos.USB());

  const ENCODING = (CONFIG.TRANSPORT === 'NET') ? 'GB18030' : 'CP858';
  printer = new escpos.Printer(device, { encoding: ENCODING });

  await new Promise((resolve, reject) => {
    device.open((err) => {
      if (err) return reject(err);

      (async () => {
        try {
          // ===== Header =====
          printer
            .hardware('init')
            .align('ct').style('B').size(1, 1)
            .text(CONFIG.SHOP.name)
            .size(0, 0).style('NORMAL');

          printer.align('ct').text(order.delivery ? 'Bezorging' : 'Afhalen');
          line('=');

          // ===== Meta（订单信息）=====
          printer.align('lt');
          if (order.order_number)   col2('Bestelnummer', String(order.order_number));
          if (order.created_at)     col2('Besteld',      String(order.created_at));
          if (order.tijdslot)       col2('Tijdslot',     String(order.tijdslot));
          if (order.payment_method) col2('Betaling',     String(order.payment_method).toUpperCase());

          // ===== 联系方式 + 地址（电话在前，地址挂在电话后）=====
          if (order.customer_name) col2('Klant', order.customer_name);
          if (order.phone)         col2('Telefoon', order.phone);

          const addrLine1 = [order.street, order.house_number].filter(Boolean).join(' ');
          const addrLine2 = [order.postcode, order.city].filter(Boolean).join(' ');
          if (order.delivery) {
            if (addrLine1) col2('Adres', addrLine1);
            if (addrLine2) col2('',       addrLine2);
          }

          // ===== QR（紧跟地址，留足空间；原生优先，失败回退位图）=====
          if (CONFIG.USE_QR && order.qr_url) {
            await (async function printQR(text) {
              const content = String(text || '').trim();
              if (!content) return;

              if (CONFIG.QR?.caption) {
                printer.align('ct').text(String(CONFIG.QR.caption)).align('lt');
              }

              // 1) 原生指令
              try {
                if (typeof printer.qrcode === 'function') {
                  printer.align(CONFIG.QR?.align || 'ct').qrcode(content, {
                    size: Number(CONFIG.QR?.size ?? 6),
                    ecc:  'M'
                  });
                  try { printer.feed && printer.feed(1); } catch {}
                  return;
                }
              } catch (e) {
                console.warn('native qrcode failed → fallback:', e);
              }

              // 2) 位图回退
              try {
                await new Promise((resolve, reject) => {
                  if (typeof printer.qrimage !== 'function') {
                    return reject(new Error('qrimage() not available'));
                  }
                  const opts = {
                    type: 'png',
                    size: Number(CONFIG.QR?.size ?? 6),
                    margin: Number(CONFIG.QR?.margin ?? 2)
                  };
                  printer.align(CONFIG.QR?.align || 'ct')
                         .qrimage(content, opts, err => err ? reject(err) : resolve());
                });
                try { printer.feed && printer.feed(1); } catch {}
              } catch (e) {
                console.warn('qrimage failed:', e);
                printer.align('ct').text('[QR 失败]').text(content).align('lt');
              }
            })(order.qr_url);
          }

          line('-'); // 进入商品区

          // ===== Items =====
          printer.text('Artikelen:');
          for (const it of order.items) {
            const name = String(it.name || '-');
            const qty  = Number(it.qty || 1);
            const unit = Number(it.price || 0);
            const totalLine = qty * unit;
            const opts = [];
            if (Array.isArray(it.options)) for (const opt of it.options) opts.push(String(opt));
            if (it.note) opts.push(`* ${it.note}`);
            printItem(name, qty, totalLine, opts);
          }

          line('-');

          // ===== Totals =====
          printIfValue('Subtotaal',  order.subtotal);
          printIfValue('Korting',    order.discount, '-');
          printIfValue('Verpakking', order.packaging);
          printIfValue('Bezorging',  order.delivery_fee);
          printIfValue('Fooi',       order.tip);

          if (CONFIG.SHOW_BTW_SPLIT && order.btw_split) {
            const btw9  = Number(order.btw_split['9']  || 0);
            const btw21 = Number(order.btw_split['21'] || 0);
            if (btw9  >= 0) col2('BTW 9%',  moneyStr(btw9));
            if (btw21 >= 0) col2('BTW 21%', moneyStr(btw21));
          } else if (order.vat != null) {
            col2('BTW', moneyStr(order.vat));
          }

          if (order.total != null) {
            line('-');
            printer.align('lt').style('B').size(1, 1);
            col2('', moneyStr(order.total));
            printer.size(0, 0).style('NORMAL');
          }

          if (order.opmerking) { line('-'); printer.text(`Opmerking: ${order.opmerking}`); }

          // ===== Footer =====
          line('=');
          printer.align('ct');
          printer.text('Bedankt voor uw bestelling!');
          printer.text(`${CONFIG.SHOP.name} · ${CONFIG.SHOP.cityTag}`);
          printer.text(`Adres: ${CONFIG.SHOP.addressLine}`);
          printer.text(`Tel: ${CONFIG.SHOP.tel}`);
          printer.text(`Email: ${CONFIG.SHOP.email}`);
          printer.text('Alle prijzen zijn inclusief BTW');

          // —— 先滚后切（只切一次）——
          await cutOnce();

          // 收尾
          await sleep(600);
          try { printer.close(); } catch {}
          resolve();
        } catch (e) {
          try { printer.close(); } catch {}
          reject(e);
        }
      })();
    });
  });
}
