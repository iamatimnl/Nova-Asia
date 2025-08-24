// main.js
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const wavPlayer = require('node-wav-player');

// ⛳ 数据库：如果 db.js 内部已完成 IPC 注册（db:save-order / db:get-orders-today / db:ping）
// 只需 require 一次即可，让其 side-effect 生效
require('./db'); 

// 🖨️ ESC/POS（暂时做成日志桩，避免前端报错）
const escpos = require('escpos');
escpos.USB = require('escpos-usb');
const beepPath = path.join(__dirname, 'assets', 'beep.wav');
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

  // Flask 可能还在启动，简单重试
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
  flaskProcess = spawn(pythonPath, [flaskAppPath], { cwd: flaskAppDir, shell: false });

  flaskProcess.stdout.on('data', (d) => console.log('[Flask]', d.toString().trim()));
  flaskProcess.stderr.on('data', (d) => console.error('[Flask ERROR]', d.toString().trim()));
  flaskProcess.on('exit', (code) => console.log('[Flask] exit code', code));
}

// === IPC：与 preload.js 对应 ===

// Google Maps Key（preload: invoke）
ipcMain.handle('get-google-maps-key', () => {
  return 'AIzaSyB0f6uWvs8PJkbaqkaWTLFcOI_WievM6mk'; // TODO: 生产别硬编码
});


// 声音（preload: send → 这里用 on）
ipcMain.on('play-ding', async () => {
  stopDing = false;
  const loop = async () => {
    if (stopDing) return;
    try {
      await wavPlayer.play({ path: dingPath });
      if (!stopDing) setTimeout(loop, 1000);
    } catch {
      if (!stopDing) setTimeout(loop, 1500);
    }
  };
  loop();
});

ipcMain.on('stop-ding', () => { stopDing = true; });

// 单次系统提示音
ipcMain.on('beep', async () => {
  try {
    await wavPlayer.play({ path: beepPath });
  } catch (err) {
    console.error('播放 beep.wav 出错:', err);
  }
});

// （可选）主进程通知渲染端登录成功
// mainWindow.webContents.send('login-success', { at: Date.now() });

// App lifecycle
app.whenReady().then(() => {
  startFlaskServer();
  createWindow();
});

app.on('window-all-closed', () => {
  if (flaskProcess) flaskProcess.kill();
  if (process.platform !== 'darwin') app.quit();
});


// db.js (主进程)

const Database = require('better-sqlite3');


// === DB 路径（保持你原来的路径；也可以换成 app.getPath('userData') 更稳）===
const dbPath = path.join('D:', 'NovaAsia1', 'data', 'orders.db');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

// === 连接 & 基础设置 ===
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// === 表结构（order_number 唯一，便于 UPSERT）===
db.exec(`
  CREATE TABLE IF NOT EXISTS orders (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id       TEXT,
    order_number   TEXT UNIQUE,
    data           TEXT NOT NULL,
    created_at     DATETIME DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_orders_order_id   ON orders(order_id);
`);

// === 预编译语句 ===
const upsertOrderStmt = db.prepare(`
  INSERT INTO orders (order_id, order_number, data)
  VALUES (@order_id, @order_number, @data)
  ON CONFLICT(order_number) DO UPDATE SET
    order_id   = excluded.order_id,
    data       = excluded.data,
    created_at = datetime('now','localtime')
`);

const getByNumberStmt = db.prepare(`SELECT * FROM orders WHERE order_number = ?`);
const getByIdStmt     = db.prepare(`SELECT * FROM orders WHERE id = ?`);
const listRecentStmt  = db.prepare(`SELECT * FROM orders ORDER BY created_at DESC LIMIT ?`);

// === 封装（同步，try/catch 容错）===
function saveLocalOrder(order) {
  // 兼容你原先传入的对象结构
  const payload = {
    order_id:     String(order.id ?? ''),
    order_number: String(order.order_number ?? ''),
    data:         JSON.stringify(order)
  };
  upsertOrderStmt.run(payload);   // 同步执行，出错会抛异常
  return true;
}

function getOrderByNumber(no) {
  return getByNumberStmt.get(String(no ?? '')) || null;
}
function getOrderById(id) {
  return getByIdStmt.get(Number(id)) || null;
}
function listRecent(limit = 50) {
  return listRecentStmt.all(Number(limit));
}

const { saveOrder, getOrderByNumber: dbGetOrderByNumber, getOrderById: dbGetOrderById } = require('./db');

ipcMain.removeHandler('db:save-order');
ipcMain.handle('db:save-order', (_e, payload) => {
  try {
    saveOrder(payload);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
});

// === IPC：与之前保持一致的通道名称 ===
ipcMain.handle('local.saveOrder', async (_evt, orderObj) => {
  try {
    saveLocalOrder(orderObj);
    return { ok: true };
  } catch (err) {
    console.error('[local.saveOrder] failed:', err);
    return { ok: false, error: String(err && err.message || err) };
  }
});

ipcMain.handle('local.getOrderByNumber', async (_evt, no) => {
  try {
    const row = getOrderByNumber(no);
    return row ? { ok: true, row } : { ok: false, error: 'NOT_FOUND' };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

ipcMain.handle('local.getOrderById', async (_evt, id) => {
  try {
    const row = getOrderById(id);
    return row ? { ok: true, row } : { ok: false, error: 'NOT_FOUND' };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});





ipcMain.handle('local.listRecent', async (_evt, limit = 50) => {
  try {
    const rows = listRecent(limit);
    return { ok: true, rows };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

// === 优雅关闭（合并 WAL，避免 .wal 越长越大） ===
function shutdownDb() {
  try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch {}
  try { db.close(); } catch {}
}
app.on('before-quit', shutdownDb);

module.exports = {
  saveLocalOrder, getOrderByNumber, getOrderById, listRecent, shutdownDb, dbPath
};





// —— 打印：根据订单号/ID 从数据库读取订单
ipcMain.handle('print-receipt', async (_evt, payload) => {
  try {
    const { id, number } = parsePrintIdentifier(payload);
    const row = id != null ? dbGetOrderById(id) : dbGetOrderByNumber(number);
    if (!row) throw new Error('NOT_FOUND');
    const raw = { ...JSON.parse(row.data || '{}'), btw_9: row.btw_9, btw_21: row.btw_21 };
    const order = normalizeForPrint(raw);
    const err  = validateOrder(order);
    if (err) throw new Error(err);
    await doEscposPrint(order);
    return { ok: true };
  } catch (err) {
    console.error('❌ 打印失败:', err);
    return { ok: false, error: err.message };
  }
});


function parsePrintIdentifier(input) {
  if (input == null) throw new Error('Invalid payload');
  if (typeof input === 'number') {
    return { id: Number(input), number: null };
  }
  if (typeof input === 'string') {
    const str = input.trim();
    try { return parsePrintIdentifier(JSON.parse(str)); }
    catch { return { id: null, number: str }; }
  }
  if (typeof input === 'object') {
    if (input.id != null)        return { id: Number(input.id),        number: null };
    if (input.order_id != null)  return { id: Number(input.order_id),  number: null };
    if (input.order_number != null) return { id: null, number: String(input.order_number) };
    if (input.orderNumber != null)  return { id: null, number: String(input.orderNumber) };
  }
  throw new Error('Invalid payload');
}

// ========= Helpers: normalize / validate =========



function validateOrder(o) {
  if (!o.order_number) return 'order_number missing';
  if (!Array.isArray(o.items) || o.items.length === 0) return 'items empty';
  return null;
}

// ========= 订单标准化：仅映射字段，不重新计算 =========
function normalizeForPrint(order) {
  // —— 小工具（函数内自包含，避免依赖外部）——
  const toStr = v => (v == null ? '' : String(v));
  const toNumOrNull = v => (v == null || v === '' || isNaN(Number(v)) ? null : Number(v));
  const pickMax = (...vals) => {
    const nums = vals.map(toNumOrNull).filter(v => v != null);
    return nums.length ? Math.max(...nums) : 0;
  };
  // BTW 数值：仅使用传入字段，不做重新计算
  const btw9Val  = toNumOrNull(order.btw_9  ?? order.btw9  ?? order.vat_9  ?? order.vat9)  || 0;
  const btw21Val = toNumOrNull(order.btw_21 ?? order.btw21 ?? order.vat_21 ?? order.vat21) || 0;

  // ===== 订单类型 / ZSM / 时间槽 =====
  const typeRaw = toStr(order.order_type || order.type || '').toLowerCase();
  const isDelivery = /bezorg|delivery/.test(typeRaw) || order.delivery === true;

  const is_zsm = (order.is_zsm === true) || /Z$/i.test(String(order.order_number || '').trim());
  const slotRaw = order.tijdslot ?? order.tijdslot_display ?? order.pickup_time ?? order.delivery_time ?? '';
  const tijdslot_display = is_zsm ? 'Z.S.M.' : toStr(slotRaw).trim();

  // ===== Items =====
  let items;
  if (Array.isArray(order.items)) {
    items = order.items.map(i => ({
      name: i.displayName || i.name,
      qty: Number(i.qty || 1),
      price: Number(i.price || 0),
      options: i.options,
      note: i.note || i.remark
    }));
  } else {
    items = Object.entries(order.items || {}).map(([name, i]) => ({
      name: (i.displayName || i.name || name),
      qty: Number(i.qty || 1),
      price: Number(i.price || 0),
      options: i.options,
      note: i.note || i.remark
    }));
  }

  // ===== 金额（直接采用现有字段；缺省再兜底）=====
  let subtotal = toNumOrNull(order.subtotal ?? order.sub_total);
  if (subtotal == null) {
    try {
      subtotal = (items || []).reduce((s, it) => s + Number(it.qty || 1) * Number(it.price || 0), 0);
    } catch { subtotal = 0; }
  }

  const packagingRaw = pickMax(order.verpakkingskosten, order.packaging, order.package_fee, order.packaging_fee);
  const statiegeldRaw= pickMax(order.statiegeld, order.deposit);
  const toeslagRaw   = pickMax(order.toeslag, order.surcharge, order.service_fee);
  const delivery     = pickMax(order.bezorgkosten, order.delivery_cost, order.delivery_fee);
  const tip          = pickMax(order.fooi, order.tip);

  // 折扣字段：本次使用 vs 下次可用（重要区分）
  // 折扣字段：兼容新老字段命名
  const discount_used_amount = toNumOrNull(
    order.discount_used_amount ?? order.discountAmount
  ); // 本次使用金额
  const discount_used_code = toStr(
    order.discount_used_code ?? order.discountCode
  ); // 本次使用的代码
  const discount_earned_amount = toNumOrNull(
    order.discount_earned_amount ?? order.discount_amount
  ); // 下次可用金额
  const discount_earned_code = toStr(
    order.discount_earned_code ?? order.discount_code
  ); // 下次可用代码

  // 历史/兜底折扣（若上面未给时才使用）
  const discountFallback = pickMax(order.korting, order.discount);

  // Verpakking + Toeslag 合并
  const packaging = Number(packagingRaw) + Number(toeslagRaw);
  const statiegeld = Number(statiegeldRaw);

  // 直接采用 payload 的 BTW/Total（如有）
  const vatFromPayload   = toNumOrNull(order.btw_total ?? order.vat_total ?? order.btw ?? order.vat);
  const totalFromPayload = toNumOrNull(order.totaal ?? order.total);

  // 兜底 total（仅在 payload 没给时使用）
  const fallbackTotal = Number(subtotal) + Number(packaging) + Number(statiegeld) + Number(delivery) + Number(tip)
    - Number(discount_used_amount != null ? discount_used_amount : discountFallback);

  // ===== 返回标准化结构（只做字段映射，不做增值税换算）=====
  const o = {
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

    // 地址
    street: toStr(order.street),
    house_number: toStr(order.house_number || order.housenumber),
    postcode: toStr(order.postcode || order.postal_code),
    city: toStr(order.city || order.town),

    // 订单类型
    type: typeRaw,
    delivery: !!isDelivery,

    // 明细/金额（本次使用折扣进入 discount）
    items,
    subtotal,
    packaging,                                 // Verpakking + Toeslag
    statiegeld,
    discount: (discount_used_amount != null ? discount_used_amount : discountFallback),
    delivery_fee: delivery,
    tip,
    vat: (vatFromPayload != null ? vatFromPayload : pickMax(order.vat, order.btw)),
    total: (totalFromPayload != null ? totalFromPayload : fallbackTotal),

    // —— 语义化折扣字段 —— 
    discount_used_amount,
    discount_used_code,
    discount_earned_amount,
    discount_earned_code,

    // BTW：直接使用数据库字段
    btw_9: btw9Val,
    btw_21: btw21Val,
    btw_split: { '9': btw9Val, '21': btw21Val },

    // 地图二维码（优先 google_maps_link）
    qr_url: order.google_maps_link || order.maps_link || order.qr_url || undefined
  };

  return o;
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
  // 3级兜底 QR：原生 ESC/POS → printer.qrcode() → qrimage() → 文本
async function printQRRobust(printer, raw, content, cfg = {}) {
  const data = String(content || '').trim();
  if (!data) return;

  if (CONFIG.QR?.caption) {
    printer.align('ct').text(String(CONFIG.QR.caption));
  }

  const align = (cfg.align || 'ct');
  const size  = Number(cfg.size ?? 6);
  const eccCh = (CONFIG.QR?.ecc || 'M');
  const eccMap = { L:0x30, M:0x31, Q:0x32, H:0x33 };

  // ① 原生 ESC/POS
  try {
    // Model 2
    raw(Buffer.from([0x1D,0x28,0x6B,0x04,0x00,0x31,0x41,0x32,0x00]));
    // Size 1-16
    raw(Buffer.from([0x1D,0x28,0x6B,0x03,0x00,0x31,0x43, Math.max(1, Math.min(16, size))]));
    // ECC
    raw(Buffer.from([0x1D,0x28,0x6B,0x03,0x00,0x31,0x45, (eccMap[eccCh] ?? 0x31) ]));
    // Store data
    const payload = Buffer.from(data, 'utf8');
    const len = payload.length + 3;
    const pL = len & 0xFF, pH = (len >> 8) & 0xFF;
    raw(Buffer.from([0x1D,0x28,0x6B,pL,pH,0x31,0x50,0x30]));
    raw(payload);
    // Print
    raw(Buffer.from([0x1D,0x28,0x6B,0x03,0x00,0x31,0x51,0x30]));
    printer.align(align);
    try { printer.feed && printer.feed(1); } catch {}
    return;
  } catch {}

  // ② API: qrcode()
  try {
    if (typeof printer.qrcode === 'function') {
      printer.align(align).qrcode(data, { size, ecc: eccCh });
      try { printer.feed && printer.feed(1); } catch {}
      return;
    }
  } catch {}

  // ③ 回退: qrimage()
  try {
    await new Promise((resolve, reject) => {
      if (typeof printer.qrimage !== 'function') return reject(new Error('qrimage() not available'));
      printer.align(align).qrimage(data, { type: 'png', size: Math.max(1, Math.min(10, size)), margin: Number(CONFIG.QR?.margin ?? 2) }, err => err ? reject(err) : resolve());
    });
    try { printer.feed && printer.feed(1); } catch {}
    return;
  } catch {}

  // ④ 兜底: 文本
  printer.align('ct').text('[MAPS LINK]').text(data).align('lt');
  try { printer.feed && printer.feed(1); } catch {}
}

  // ========== helpers ==========
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const euro = v => {
    const n = Number(v) || 0;
    const sign = n < 0 ? '-' : '';
    return sign + '€' + Math.abs(n).toFixed(2).replace('.', ',');
  };
  const norm = v => {
    const n = Number(v);
    return isNaN(n) || Math.abs(n) < 0.005 ? 0 : n;
  };
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

  // —— 数量在前 ——  {qty}x {name} .... €xx,xx
  const printItem = (name, qty, total, opts = []) => {
    const q = Number.isFinite(Number(qty)) ? Number(qty) : 1;
    const qtyStr = `${q}x `;
    const right  = euro(total);
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

          // ✅ Google Maps 二维码（若有链接则打印）
if (CONFIG.USE_QR && order.qr_url) {
  await printQRRobust(printer, raw, order.qr_url, { align: CONFIG.QR?.align || 'ct', size: CONFIG.QR?.size ?? 6 });
}

line('-'); // 进入商品区

          // ===== Items =====
          printer.text('Bestellingen:');
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

          // ===== 备注 =====
          printer.text('Opmerking:');
          if (order.opmerking) {
            const rLines = wrap(String(order.opmerking), WIDTH);
            for (const l of rLines) printer.text(l);
          }
          line('-');

// 固定显示 7 行
col2('Subtotaal',   euro(order.subtotal));
// —— 折扣（本次使用）——
{
  const usedAmt = Number(
    order.discount_used_amount       // 已在 normalize 写入
    ?? order.discountAmount          // payload: 本次使用金额
    ?? 0
  );
  const usedCode = String(
    order.discount_used_code         // 已在 normalize 写入
    ?? order.discountCode            // payload: 本次使用 code
    ?? ''
  ).trim();

  if (usedAmt > 0) {
    const right = euro(-usedAmt);
    if (usedCode.toUpperCase() === 'KASSA') {
      col2('Kassa korting', right);
    } else if (usedCode) {
      col2(`Korting (Code: ${usedCode} gebruikt)`, right);
    } else {
      col2('Korting', right);
    }
  }
}

col2('Verpakking Toeslag', euro(order.packaging));
col2('Statiegeld',         euro(order.statiegeld));
col2('Bezorgkosten',       euro(order.delivery_fee));
col2('Fooi',               euro(order.tip));

// —— BTW：9% 先于 21%，均以数据库字段为准 ——
if (CONFIG.SHOW_BTW_SPLIT) {
  const btw9  = norm(order.btw_9);
  const btw21 = norm(order.btw_21);
  if (btw9 !== 0)  col2('BTW (9%)',  euro(btw9));
  if (btw21 !== 0) col2('BTW (21%)', euro(btw21));
  if (btw9 === 0 && btw21 === 0) col2('BTW', euro(order.vat));
} else {
  col2('BTW', euro(order.vat));
}


// Totaal（如有/或用兜底公式已算出）
if (order.total != null) {
  line('-');
  printer.align('lt').style('B').size(1, 1);
  col2('', euro(order.total));
  printer.size(0, 0).style('NORMAL');
}

// ===== 下一次优惠券提醒 =====
{
  const earnedAmt = Number(
    order.discount_earned_amount ?? order.discount_amount ?? 0
  );
  const earnedCode = String(
    order.discount_earned_code ?? order.discount_code ?? ''
  ).trim();
  if (earnedAmt > 0 || earnedCode) {
    line('-');
    const label = earnedCode ? `Volgende korting (Code: ${earnedCode})` : 'Volgende korting';
    col2(label, euro(earnedAmt));
    line('-');
  }
}

// ===== Footer =====
printer.align('ct');
printer.text('💡 Bestel online via www.novaasia.nl');
printer.text('   en ontvang 3% korting voor uw');
printer.text('   volgende bestelling!');
line('-');
printer.text('谢谢惠顾 / Bedankt!');
if (order.order_number) {
  printer.text(`Factuur? toon bestelnummer ${order.order_number}`);
}

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
