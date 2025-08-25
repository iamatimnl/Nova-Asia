// ==============================
// main.js  — 统一整合版（替换即用）
// ==============================
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const wavPlayer = require('node-wav-player');


// ------------------------------
// 1) 数据库：只需 require 一次，触发 db:* 通道注册
// ------------------------------
require('./db'); // 让 db.js 自己注册 'db:*' IPC
const {
  saveOrder,
  getOrderByNumber: dbGetOrderByNumber,
  getOrderById: dbGetOrderById,
  listRecent: dbListRecent,
  getOrdersToday: dbGetOrdersToday
} = require('./db'); // 提供给 local.* 包装使用

// ------------------------------
// 2) ESC/POS 依赖 + 打印配置（支持 USB / NET）
// ------------------------------
const escpos = require('escpos');
escpos.USB = require('escpos-usb');
try { escpos.Network = require('escpos-network'); } catch { /* 未安装网口模块可忽略 */ }

// 从本地文件覆盖默认打印配置（可选）
let FILE_CFG = {};
try { 
  FILE_CFG = require(path.join(__dirname, 'config.electron.js')); 
} catch {}


const CONFIG = Object.assign({
  TRANSPORT: 'USB',                 // 'USB' | 'NET'
  USB: { /* vid/pid 可选，如需指定：vid:0x04b8, pid:0x0e15 */ },
  NET: { host: '192.168.1.50', port: 9100 },
  WIDTH: 42,                        // 80mm 纸常用 42~48
  RIGHT_RESERVE: 10,                // 右侧金额预留字符宽度
  SHOP: { name: 'Nova Asia' },
  SHOW_BTW_SPLIT: false,
  USE_QR: false,
  QR: { size: 6, align: 'ct', ecc: 'M' },
  CUT_STRATEGY: 'atomic',           // 'atomic' | 'split'
  CUT_MODE: 'partial',              // 'partial' | 'full'
  FEED_BEFORE_CUT: 6,
  wait_after_feed_ms: 200,
  wait_after_cut_ms: 800
}, FILE_CFG);

// ------------------------------
// 3) Flask 后端进程
// ------------------------------
const beepPath = path.join(__dirname, 'assets', 'beep.wav');
const dingPath = path.join(__dirname, 'assets', 'ding.wav');
const flaskAppPath = path.join(__dirname, '..', 'app.py');
const flaskAppDir = path.dirname(flaskAppPath);

let mainWindow;
let flaskProcess;
let stopDing = false;

function startFlaskServer() {
  const pythonPath = process.platform === 'win32' ? 'python' : 'python3';
  flaskProcess = spawn(pythonPath, [flaskAppPath], { cwd: flaskAppDir, shell: false });

  flaskProcess.stdout.on('data', (d) => console.log('[Flask]', d.toString().trim()));
  flaskProcess.stderr.on('data', (d) => console.error('[Flask ERROR]', d.toString().trim()));
  flaskProcess.on('exit', (code) => console.log('[Flask] exit code', code));
}

// ------------------------------
// 4) 浏览器窗口
// ------------------------------
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

  // Flask 启动有延迟，做个简单重试
  const target = 'http://localhost:5000/login';
  const tryLoad = (attempt = 0) => {
    mainWindow.loadURL(target).catch(() => {
      if (attempt < 20) setTimeout(() => tryLoad(attempt + 1), 500);
    });
  };
  tryLoad();
}

// ------------------------------
// 5) IPC：通用/声音/Key
// ------------------------------
ipcMain.handle('get-google-maps-key', () => {
  return 'AIzaSyDvnm8O0jFM7uYbZsZcA1gtGa2MRwg1wDE';
});

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
ipcMain.on('beep', async () => {
  try {
    await wavPlayer.play({ path: beepPath });
  } catch (err) {
    console.error('播放 beep.wav 出错:', err);
  }
});

// ------------------------------
// 6) IPC：local.* 封装（不与 db:* 冲突）
// ------------------------------
ipcMain.handle('local.saveOrder', async (_e, orderObj) => {
  try {
    // 注意：db.js 中 REQUIRE_BRON = true，必须带 bron；同时要有 order_number
    const ok = saveOrder(orderObj);
    return { ok: !!ok };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
});

ipcMain.handle('local.getOrderByNumber', async (_e, no) => {
  try {
    const row = dbGetOrderByNumber(no);
    return row ? { ok: true, row } : { ok: false, error: 'NOT_FOUND' };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
});

ipcMain.handle('local.getOrderById', async (_e, id) => {
  try {
    const row = dbGetOrderById(id);
    return row ? { ok: true, row } : { ok: false, error: 'NOT_FOUND' };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
});

ipcMain.handle('local.listRecent', async (_e, limit = 50) => {
  try {
    const rows = dbListRecent(limit);
    return { ok: true, rows };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
});

ipcMain.handle('local.getOrdersToday', async () => {
  try {
    const rows = dbGetOrdersToday();
    return { ok: true, rows };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
});

// ------------------------------
// 7) ESC/POS 打印：从本地数据库读取后直打
// ------------------------------

// 解析渲染层传来的打印标识
function parsePrintIdentifier(input) {
  if (input == null) throw new Error('Invalid payload');
  if (typeof input === 'number') return { id: Number(input), number: null };
  if (typeof input === 'string') {
    const str = input.trim();
    try { return parsePrintIdentifier(JSON.parse(str)); }
    catch { return { id: null, number: str }; }
  }
  if (typeof input === 'object') {
    if (input.id != null)            return { id: Number(input.id), number: null };
    if (input.order_id != null)      return { id: Number(input.order_id), number: null };
    if (input.order_number != null)  return { id: null, number: String(input.order_number) };
    if (input.orderNumber != null)   return { id: null, number: String(input.orderNumber) };
  }
  throw new Error('Invalid payload');
}

// 简化校验：仅确保必要字段存在
function validateOrder(o) {
  if (!o.order_number) return 'order_number missing';
  if (!Array.isArray(o.items) || o.items.length === 0) return 'items empty';
  return null;
}

function normalizeForPrint(order) {
  const s = (v) => (v == null ? '' : String(v));
  const n = (v) =>
    v == null || v === '' || isNaN(Number(v)) ? null : Number(v);

  // Items 统一
  let items = [];
  if (Array.isArray(order.items)) {
    items = order.items.map((it) => ({
      name: it.displayName || it.name || '-',
      qty: Number(it.qty || 1),
      price: Number(it.price || 0),
      options: it.options,
      note: it.note || it.remark,
    }));
  } else if (order.items && typeof order.items === 'object') {
    items = Object.entries(order.items).map(([k, it]) => ({
      name: it.displayName || it.name || k,
      qty: Number(it.qty || 1),
      price: Number(it.price || 0),
      options: it.options,
      note: it.note || it.remark,
    }));
  }

  const subtotal = n(order.subtotal);
  const total = n(order.total ?? order.totaal);
  const vat = n(order.btw_total ?? order.vat_total ?? order.btw ?? order.vat);

  // 支付方式映射
  const payment_method =
    s(
      order.payment_method ??
        order.pay_method ??
        (order.payment && order.payment.method) ??
        order.paymentMethod ??
        order.payment
    );

  // 备注
  const remarkRaw =
    order.opmerking ??
    order.remark ??
    order.remarks ??
    order.notes ??
    order.note ??
    order.comment ??
    order.special_instructions ??
    order.klant_opmerking ??
    '';
  const opmerking = s(remarkRaw);
  let tijdslot = s(
    order.tijdslot ||
    order.tijdslot_display ||
    order.pickup_time ||
    order.delivery_time
  );
  const no = s(order.order_number || order.id || '');
  if (no.endsWith('Z')) {
    tijdslot = 'Z.S.M.';
  }

  return {
    // 标识 & 基本信息
    order_number: no,
    order_number: s(order.order_number || order.id),
    created_at: s(order.created_at || order.time || order.timestamp),
    bron: s(order.bron || order.source),

    // 客户
    customer_name: s(order.customer_name || order.name),
    phone: s(order.phone || order.telefoon),
    email: s(order.email),

    // 时间槽
    tijdslot,

    // 支付 & 备注
    payment_method,
    opmerking,

    // 地址
    street: s(order.street),
    house_number: s(order.house_number || order.housenumber),
    postcode: s(order.postcode || order.postal_code),
    city: s(order.city || order.town),

    // 类型
    delivery:
      /bezorg|delivery/i.test(s(order.order_type || order.type)) ||
      order.delivery === true,

    // 明细/金额
    items,
    subtotal:
      subtotal ?? items.reduce((acc, it) => acc + it.qty * it.price, 0),
    packaging:
      Number(order.packaging_fee || order.verpakkingskosten || 0) +
      Number(order.toeslag || order.surcharge || 0),
    statiegeld: Number(order.statiegeld || 0),
    discount: Number(
      order.discount_used_amount ??
        order.discountAmount ??
        order.korting ??
        0
    ),
    delivery_fee: Number(order.delivery_fee || order.bezorgkosten || 0),
    tip: Number(order.tip || order.fooi || 0),
    vat: vat ?? 0,
    total: total != null ? total : undefined,

    // BTW split
    btw_9: Number(order.btw_9 || 0),
    btw_21: Number(order.btw_21 || 0),

    // 折扣语义
    discount_used_amount: Number(
      order.discount_used_amount ?? order.discountAmount ?? 0
    ),
    discount_used_code: s(order.discount_used_code ?? order.discountCode),
    discount_earned_amount: Number(
      order.discount_earned_amount ?? order.discount_amount ?? 0
    ),
    discount_earned_code: s(order.discount_earned_code ?? order.discount_code),

    // 可选二维码
    qr_url: s(
      order.qr_url ||
        order.google_maps_link ||
        order.maps_link ||
        (order.street && order.city
          ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
              [order.street, order.house_number, order.postcode, order.city]
                .filter(Boolean)
                .join(' ')
            )}`
          : '')
    ),

    // 状态字段 ✅
    status: s(order.status ?? order.order_status ?? ''),
    payment_status: s(order.payment_status ?? order.paymentStatus ?? ''),
  };
}




// === ESC/POS 打印核心（完整替换版）===
async function doEscposPrint(order) {
  // ---------- 编码 / 货币 ----------
  const ENCODING = 'GBK'; // 或 'CP936'
  const EURO_SIGN = ENCODING.toUpperCase().startsWith('GB') ? 'EUR ' : '€';
  const euro = (v) => {
    const n = Number(v) || 0;
    const sign = n < 0 ? '-' : '';
    return sign + EURO_SIGN + Math.abs(n).toFixed(2).replace('.', ',');
  };
  const sanitize = (s) => String(s || '')
    .replace(/\u20AC/g, EURO_SIGN)          // € -> EUR （GBK 下防乱码）
    .replace(/[\u0000-\u001F\u007F]/g, ' ') // 控制字符去掉
    .replace(/[\u{1F300}-\u{1FAFF}]/gu, ''); // emoji 去掉

  // ---------- 配置 / 设备 ----------
  const WIDTH = Number(CONFIG.WIDTH || 42);
  const RIGHT = Number(CONFIG.RIGHT_RESERVE || 10);
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  const device = (CONFIG.TRANSPORT === 'NET')
    ? new escpos.Network(CONFIG.NET.host, CONFIG.NET.port)
    : (CONFIG.USB?.vid && CONFIG.USB?.pid
        ? new escpos.USB(CONFIG.USB.vid, CONFIG.USB.pid)
        : new escpos.USB());

  const printer = new escpos.Printer(device, { encoding: ENCODING });
  try { if (typeof printer.encode === 'function') printer.encode(ENCODING); } catch {}

  // ---------- 文本宽度工具（中文=2，ASCII=1） ----------
  const dispW = (s) => { let w = 0; for (const ch of String(s||'')) w += /[^\x00-\x7F]/.test(ch) ? 2 : 1; return w; };
  const wrapW = (text, maxW) => {
    const t = String(text || ''); const out = []; let buf = '', w = 0;
    for (const ch of t) {
      const cw = /[^\x00-\x7F]/.test(ch) ? 2 : 1;
      if (w + cw > maxW) { out.push(buf); buf = ''; w = 0; }
      buf += ch; w += cw;
    }
    if (buf) out.push(buf);
    return out;
  };
  const col2 = (left, right) => {
    const L = sanitize(left), R = sanitize(right);
    const pad = Math.max(1, WIDTH - dispW(L) - dispW(R));
    printer.text(L + ' '.repeat(pad) + R);
  };
  const line = (ch='-') => printer.text(ch.repeat(WIDTH));
  const raw  = (buf) => { try { printer.raw(buf); } catch {} };

  const printItem = (name, qty, total, opts=[]) => {
    const q = Number.isFinite(Number(qty)) ? Number(qty) : 1;
    const qtyStr = `${q}x `;
    const right  = euro(total);
    const nameMaxW = Math.max(1, WIDTH - RIGHT - dispW(qtyStr));
    const lines = wrapW(sanitize(name || '-'), nameMaxW);

    const pad = Math.max(1, WIDTH - (dispW(qtyStr) + dispW(lines[0]) + dispW(right)));
    printer.text(qtyStr + lines[0] + ' '.repeat(pad) + right);

    for (let i = 1; i < lines.length; i++) {
      printer.text(' '.repeat(dispW(qtyStr)) + lines[i]);
    }

    if (Array.isArray(opts) && opts.length) {
      const optW = Math.max(1, WIDTH - dispW(qtyStr) - 3); // "  - "
      for (const s of opts) {
        const ws = wrapW(sanitize(s), optW);
        for (let j = 0; j < ws.length; j++) {
          const prefix = j === 0 ? '  - ' : '    ';
          printer.text(' '.repeat(dispW(qtyStr)) + prefix + ws[j]);
        }
      }
    }
  };

  // ---------- QR（Promise 包装，确保等待完成） ----------
  async function printQR(url, size = 6, align = 'ct') {
    return new Promise((resolve) => {
      try {
        printer.align(align);
        printer.qrimage(url, { type: 'png', size }, (err) => {
          if (err) console.error('QR 打印失败:', err);
          try { printer.feed && printer.feed(1); } catch {}
          resolve();
        });
      } catch (e) { console.error('QR 打印异常:', e); resolve(); }
    });
  }

  // ---------- 切刀（一次切） ----------
  const cutOnce = async () => {
    const m = (CONFIG.CUT_MODE === 'full') ? 0x41 : 0x42;    // GS V m n
    const n = Math.max(0, Math.min(255, CONFIG.FEED_BEFORE_CUT || 6));
    raw(Buffer.from([0x1D, 0x56, m, n]));
    await sleep(CONFIG.wait_after_cut_ms || 800);
  };

  // ---------- 打印主体 ----------
  await new Promise((resolve, reject) => {
      device.open(async (err) => {
        if (err) { console.error('[PRINT] open error:', err); return reject(err); }
        try {
          // Header
          printer.hardware('init');
         
  
  
          // 店名居中
          printer.align('ct').style('B').size(1, 1)
            .text(sanitize(CONFIG.SHOP?.name || ''))
            .size(0, 0).style('NORMAL');

          printer.feed(1);
          printer.feed(1);  
  
          // 公司资料（居中）
          printer.align('ct');
          printer.text('Almkerkplein 4, 2134DR Hoofddorp');
          printer.text('Tel: 0622599566');
          printer.text('Email: novaasianl@gmail.com');
          printer.text('KVK: 97092339');
          printer.text('IBAN: NL59INGB0111625394 (ING)');
          printer.text('www.novaasia.nl');
  
          line('=');
          printer.align('ct').text(order.delivery ? 'Bezorging' : 'Afhalen');
          line('=');

        // Meta
        printer.align('lt');
        // === 客人名字特别处理 ===
if (order.customer_name) {
  printer.align('ct')       // 居中
         .style('B')        // 加粗
         .size(1, 1)        // 放大一号（如果你想更大可用 size(2,2)，但要注意可能超宽）
         .text(sanitize(order.customer_name))
         .style('NORMAL')
         .size(0, 0);       // 恢复默认
  printer.feed(1);          // 空一行，和下面的信息隔开
}

// === Meta 信息（左对齐） ===
printer.align('lt');
if (order.order_number)   col2('Bestelnummer', String(order.order_number));
if (order.created_at)     col2('Besteld',      String(order.created_at));
if (order.tijdslot)       col2('Tijdslot',     String(order.tijdslot));
if (order.payment_method) col2('Betaling',     String(order.payment_method).toUpperCase());
if (order.bron)           col2('Bron',         String(order.bron).toUpperCase());
if (order.status)         col2('Status',       String(order.status).toUpperCase());
if (order.phone)          col2('Telefoon',     order.phone);
if (order.email)          col2('Email',        order.email);


        const addrLine1 = [order.street, order.house_number].filter(Boolean).join(' ');
        const addrLine2 = [order.postcode, order.city].filter(Boolean).join(' ');
        const hasAddr = !!(addrLine1 || addrLine2);
        if (order.delivery || hasAddr) {
          if (addrLine1) col2('Adres', addrLine1);
          if (addrLine2) col2('',      addrLine2);
        }

        // Items
        line('-');
        printer.text('Bestellingen:');
        for (const it of (order.items || [])) {
          const name = String(it.name || '-');
          const qty  = Number(it.qty || 1);
          const unit = Number(it.price || 0);
          const totalLine = qty * unit;
          const opts = [];
          if (Array.isArray(it.options)) for (const opt of it.options) opts.push(String(opt));
          if (it.note) opts.push(`* ${it.note}`);
          printItem(name, qty, totalLine, opts);
        }

        // 备注
        line('-');
        printer.text('Opmerking:');
        if (order.opmerking) {
          const lines = wrapW(sanitize(order.opmerking), WIDTH);
          for (const l of lines) printer.text(l);
        }

        // 金额区
        line('-');
        const nz = (v) => { const n = Number(v); return (Number.isFinite(n) && Math.abs(n) >= 0.0005) ? n : 0; };

        col2('Subtotaal', euro(nz(order.subtotal)));

        // —— 本次使用折扣（优先 used_*）——
        {
          const usedAmt  = nz(order.discount_used_amount ?? order.discountAmount ?? 0);
          const usedCode = String(order.discount_used_code ?? order.discountCode ?? '').trim();
          if (usedAmt > 0) {
            const right = euro(-usedAmt);
            if (usedCode.toUpperCase() === 'KASSA') {
              col2('Kassa korting', right);
            } else if (usedCode) {
              col2(`Korting (Code: ${sanitize(usedCode)} gebruikt)`, right);
            } else {
              col2('Korting', right);
            }
          }
        }

        col2('Verpakking Toeslag', euro(nz(order.packaging)));
        col2('Statiegeld',         euro(nz(order.statiegeld)));
        col2('Bezorgkosten',       euro(nz(order.delivery_fee)));
        col2('Fooi',               euro(nz(order.tip)));

        // —— BTW：拆行或合计 —— 
        {
          const b9   = nz(order.btw_9);
          const b21  = nz(order.btw_21);
          const vtot = nz(order.vat ?? order.btw_total ?? order.vat_total);
          if (b9 !== 0 || b21 !== 0) {
            if (b9  !== 0) col2('BTW (9%)',  euro(b9));
            if (b21 !== 0) col2('BTW (21%)', euro(b21));
          } else {
            col2('BTW', euro(vtot));
          }
        }

        // TOTAAL（左文右额，同一行；注意不要用 size(1,1) 破坏行宽）
        if (order.total != null) {
          line('-');
          printer.align('lt').style('B').size(0, 0); // 加粗即可，保持正常宽度
          col2('TOTAAL', euro(nz(order.total)));
          printer.style('NORMAL');
        }
        // 下一次优惠提示（下次可用）
        {
          const earnedAmt  = nz(order.discount_earned_amount ?? order.discount_amount ?? 0);
          const earnedCode = String(order.discount_earned_code ?? order.discount_code ?? '').trim();
          if (earnedAmt > 0 || earnedCode) {
            line('-');
            const label = earnedCode
              ? `Volgende korting (Code: ${sanitize(earnedCode)})`
              : 'Volgende korting';
            col2(label, euro(earnedAmt));
          }
        }

        // QR（放 footer 前，避免被切断）
        if (order.qr_url) {
          line('-');
          printer.align('ct').text('Scan voor bezorgroute');
          await printQR(order.qr_url, CONFIG.QR?.size ?? 6, CONFIG.QR?.align || 'ct');
        }

        // Footer（无 emoji）
        line('-');
        printer.align('ct');
        printer.text('Bestel online via www.novaasia.nl');
        printer.text('en ontvang 3% korting voor uw');
        printer.text('volgende bestelling!');
        if (CONFIG.SHOP?.hours) {
          line('-');
          printer.text('Openingstijden');
          for (const h of [].concat(CONFIG.SHOP.hours)) printer.text(String(h));
        }

        // 收尾
        try { printer.feed && printer.feed(2); } catch {}
        await cutOnce();
        await sleep(400);
        try { printer.close(); } catch {}
        resolve();

      } catch (e) {
        try { printer.close(); } catch {}
        reject(e);
      }
    });
  });
}




// === 打印入口（优先 DB，DB 失败才直打）===
ipcMain.handle('print-receipt', async (_evt, payload) => {
  try {
    // 1) 解析 payload
    let parsed = payload;
    if (typeof payload === 'string') {
      try { parsed = JSON.parse(payload); } catch { /* 可能就是订单号 */ }
    }

    // 提取可能的单号
    const number =
      (parsed && typeof parsed === 'object')
        ? (parsed.order_number || parsed.orderNumber || '')
        : (typeof payload === 'string' ? payload : '');
    const orderNo = String(number || '').trim();

    // 2) 只要拿得到单号，就“先查库”
    if (orderNo) {
      console.log('[PRINT] try DB first by number:', orderNo);

      // 打点最近 5 条方便排错
      try {
        const recent5 = (typeof dbListRecent === 'function') ? dbListRecent(5).map(r => r.order_number) : [];
        console.log('[PRINT] recent5:', recent5);
      } catch {}

      const row = dbGetOrderByNumber(orderNo);
      if (row) {
        // 合并 row 与 row.data
        const raw = JSON.parse(row.data || '{}');
        const merged = {
          ...raw,

          // —— 标识 / 时间 / 来源 —— 
          order_number: row.order_number ?? raw.order_number ?? orderNo,
          created_at:   row.created_at   ?? raw.created_at,
          bron:         row.bron         ?? raw.bron,

          // —— 支付 / 类型 / 时段 —— 
          payment_method: row.payment_method ?? raw.payment_method,
          order_type:     row.order_type     ?? raw.order_type,
          pickup_time:    row.pickup_time    ?? raw.pickup_time,
          delivery_time:  row.delivery_time  ?? raw.delivery_time,

          // —— 客户 / 联系方式 / 备注 —— 
          customer_name: row.customer_name ?? raw.customer_name ?? raw.name,
          phone:         row.phone         ?? raw.phone,
          email:         row.email         ?? raw.email,
          opmerking:     (row.opmerking ?? raw.opmerking ?? raw.remark ?? raw.note ?? ''),

          // —— 地址 —— 
          street:       row.street       ?? raw.street,
          house_number: row.house_number ?? raw.house_number ?? raw.housenumber,
          postcode:     row.postcode     ?? raw.postcode     ?? raw.postal_code,
          city:         row.city         ?? raw.city         ?? raw.town,

          // —— 明细 —— 
          items: raw.items ?? row.items, // row.items 多为空，保留兼容

          // —— 金额 / 税 —— 
          subtotal:       row.subtotal       ?? raw.subtotal,
          total:          row.total          ?? raw.total ?? raw.totaal,
          packaging_fee:  row.packaging_fee  ?? raw.packaging_fee ?? raw.verpakkingskosten,
          statiegeld:     row.statiegeld     ?? raw.statiegeld,
          delivery_fee:   row.delivery_fee   ?? raw.delivery_fee  ?? raw.bezorgkosten,
          tip:            row.tip            ?? raw.tip ?? raw.fooi,
          btw_9:          row.btw_9          ?? raw.btw_9,
          btw_21:         row.btw_21         ?? raw.btw_21,
          btw_total:      row.btw_total      ?? raw.btw_total ?? raw.btw,

          // —— 状态 —— 
          status:         row.status         ?? raw.status,
          payment_status: row.payment_status ?? raw.payment_status,
        };

        // 推断 delivery 布尔，供地址区显示
        merged.delivery = raw.delivery ?? /bezorg|delivery/i.test(String(merged.order_type || ''));

        const order = normalizeForPrint(merged);
        const err = validateOrder(order);
        if (err) throw new Error(err);

        await doEscposPrint(order);
        console.log('[PRINT] done (db-first)');
        return { ok: true, mode: 'db-first' };
      }

      // 有单号但没找到 → 不直接失败，继续尝试直打兜底
      console.warn('[PRINT] NOT_FOUND in DB, fallback to direct:', orderNo);
    }

    // 3) 兜底：若 payload 本身是“完整订单对象（含 items）”，就直打
    if (parsed && typeof parsed === 'object' && (Array.isArray(parsed.items) || parsed.items)) {
      const order = normalizeForPrint(parsed);
      const err = validateOrder(order);
      if (err) throw new Error(err);

      await doEscposPrint(order);
      console.log('[PRINT] done (direct-fallback)');
      return { ok: true, mode: 'direct-fallback' };
    }

    // 4) 再兜底：如果 payload 是“字符串订单号”但 DB 查不到
    if (orderNo) {
      return { ok: false, error: 'NOT_FOUND' };
    }

    // 5) 都不是 → 非法请求
    return { ok: false, error: 'Invalid payload' };

  } catch (err) {
    console.error('❌ 打印失败:', err);
    return { ok: false, error: err?.message || String(err) };
  }
});



// ------------------------------
// 8) App 生命周期
// ------------------------------
app.whenReady().then(() => {
  startFlaskServer();
  createWindow();
});

app.on('window-all-closed', () => {
  if (flaskProcess) flaskProcess.kill();
  if (process.platform !== 'darwin') app.quit();
});
