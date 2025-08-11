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
  SHOW_BTW_SPLIT: true,            // 显示 9%/21% BTW 分拆（需要传 btw_split）
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



function validateOrder(o) {
  if (!o.order_number) return 'order_number missing';
  if (!Array.isArray(o.items) || o.items.length === 0) return 'items empty';
  return null;
}

// ========= BTW 提取：完全使用现有订单字段（不做换算）=========
function deriveBtwSplitFromPayload(order) {
  const num = (v) => (v == null || v === '' || isNaN(Number(v)) ? null : Number(v));
  const b9  = num(order.btw_9  ?? order.btw9  ?? order.vat_9  ?? order.vat9);
  const b21 = num(order.btw_21 ?? order.btw21 ?? order.vat_21 ?? order.vat21);
  if (b9 != null || b21 != null) {
    return { '9': Number(b9 || 0), '21': Number(b21 || 0) };
  }
  return undefined;
}

function normalizeForPrint(order) {
  // —— 小工具（函数内自包含，避免依赖外部）——
  const toStr = v => (v == null ? '' : String(v));
  const toNumOrNull = v => (v == null || v === '' || isNaN(Number(v)) ? null : Number(v));
  const pickMax = (...vals) => {
    const nums = vals.map(toNumOrNull).filter(v => v != null);
    return nums.length ? Math.max(...nums) : 0;
  };
  // 从 payload 里直接提取 btw_9/btw_21（不换算）
  const deriveBtwSplitFromPayload = (src) => {
    const num = (v) => (v == null || v === '' || isNaN(Number(v)) ? null : Number(v));
    const b9  = num(src.btw_9  ?? src.btw9  ?? src.vat_9  ?? src.vat9);
    const b21 = num(src.btw_21 ?? src.btw21 ?? src.vat_21 ?? src.vat21);
    if (b9 != null || b21 != null) return { '9': Number(b9 || 0), '21': Number(b21 || 0) };
    return undefined;
  };

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
  const toeslagRaw   = pickMax(order.toeslag, order.surcharge, order.service_fee);
  const delivery     = pickMax(order.bezorgkosten, order.delivery_cost, order.delivery_fee);
  const tip          = pickMax(order.fooi, order.tip);

  // 折扣字段：本次使用 vs 下次可用（重要区分）
  // 折扣字段：兼容新老字段命名
  const discount_used_amount = toNumOrNull(
    order.discount_used_amount ?? order.discountAmount ?? order.discount_amount
  ); // 本次使用金额
  const discount_used_code = toStr(
    order.discount_used_code ?? order.discountCode ?? order.discount_code
  ); // 本次使用的代码
  const discount_earned_amount = toNumOrNull(
    order.discount_earned_amount ?? order.next_discount_amount
  ); // 下次可用金额
  const discount_earned_code = toStr(
    order.discount_earned_code ?? order.next_discount_code
  ); // 下次可用代码

  // 历史/兜底折扣（若上面未给时才使用）
  const discountFallback = pickMax(order.korting, order.discount);

  // Verpakking + Toeslag 合并
  const packaging = Number(packagingRaw) + Number(toeslagRaw);

  // 直接采用 payload 的 BTW/Total（如有）
  const vatFromPayload   = toNumOrNull(order.btw_total ?? order.vat_total ?? order.btw ?? order.vat);
  const totalFromPayload = toNumOrNull(order.totaal ?? order.total);

  // 兜底 total（仅在 payload 没给时使用）
  const fallbackTotal = Number(subtotal) + Number(packaging) + Number(delivery) + Number(tip)
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

    // BTW 分桶：优先用 payload 的 btw_9/btw_21（不计算）
    btw_split: order.btw_split || deriveBtwSplitFromPayload(order),

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

          const to2 = v => Number(v ?? 0).toFixed(2);

// 固定显示 7 行
col2('Subtotaal',   `EUR ${to2(order.subtotal)}`);
// —— 折扣（本次使用）——
{
  const usedAmt = Number(
    order.discount_used_amount       // 已在 normalize 写入
    ?? order.discountAmount          // payload: 本次使用金额
    ?? order.discount_amount
    ?? 0
  );
  const usedCode = String(
    order.discount_used_code         // 已在 normalize 写入
    ?? order.discountCode            // payload: 本次使用 code
    ?? order.discount_code
    ?? ''
  ).trim();

  if (usedAmt > 0) {
    const right = `-EUR ${to2(usedAmt)}`;
    if (usedCode.toUpperCase() === 'KASSA') {
      col2('Kassa korting', right);
    } else if (usedCode) {
      col2(`Korting (Code: ${usedCode} gebruikt)`, right);
    } else {
      col2('Korting', right);
    }
  }
}

col2('Verpakking Toeslag', `EUR ${to2(order.packaging)}`);
col2('Bezorgkosten',       `EUR ${to2(order.delivery_fee)}`);
col2('Fooi',               `EUR ${to2(order.tip)}`);

// —— BTW：仅展示一个，优先 21% → 9% → totaal ——
if (CONFIG.SHOW_BTW_SPLIT && order.btw_split) {
  const btw21 = Number(order.btw_split?.['21'] || 0);
  const btw9  = Number(order.btw_split?.['9']  || 0);
  if (btw21 > 0) {
    col2('BTW (21%)', `EUR ${to2(btw21)}`);
  } else if (btw9 > 0) {
    col2('BTW (9%)', `EUR ${to2(btw9)}`);
  } else {
    col2('BTW', `EUR ${to2(order.vat)}`);
  }
} else {
  col2('BTW', `EUR ${to2(order.vat)}`);
}


// Totaal（如有/或用兜底公式已算出）
if (order.total != null) {
  line('-');
  printer.align('lt').style('B').size(1, 1);
  col2('', `EUR ${to2(order.total)}`);
  printer.size(0, 0).style('NORMAL');
}

// ===== 下一次优惠券提醒 =====
{
  const earnedAmt = Number(
    order.discount_earned_amount ?? order.next_discount_amount ?? 0
  );
  const earnedCode = String(
    order.discount_earned_code ?? order.next_discount_code ?? ''
  ).trim();
  if (earnedAmt > 0 || earnedCode) {
    line('-');
    const label = earnedCode ? `Volgende korting (Code: ${earnedCode})` : 'Volgende korting';
    col2(label, `EUR ${to2(earnedAmt)}`);
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
