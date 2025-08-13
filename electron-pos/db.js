// db.js（主进程，自包含：require 后即初始化与注册 IPC）
const { ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

// === 固定数据库路径（D 盘）===
const dbPath = path.join('D:', 'NovaAsia1', 'data', 'orders.db');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
console.log('[DB] file =', dbPath);

// === 连接 & 基础设置 ===
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// === 表结构（与你现有列对齐）===
// 注：如果表已存在，下面 CREATE TABLE IF NOT EXISTS 不会改动已有列；
//     你之前已存在的列会保留。
db.exec(`
  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id TEXT,
    order_number TEXT UNIQUE,
    data TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    customer_name TEXT,
    phone TEXT,
    email TEXT,
    order_type TEXT,
    pickup_time TEXT,
    delivery_time TEXT,
    payment_method TEXT,
    postcode TEXT,
    house_number TEXT,
    street TEXT,
    city TEXT,
    opmerking TEXT,
    items TEXT,
    subtotal REAL,
    total REAL,
    packaging_fee REAL,
    delivery_fee REAL,
    tip REAL,
    btw_9 REAL,
    btw_21 REAL,
    btw_total REAL,
    discount_amount REAL,
    discount_code TEXT,
    is_completed INTEGER DEFAULT 0,
    is_cancelled INTEGER DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_orders_order_id   ON orders(order_id);
`);

// —— 工具：安全 JSON
function safeStringify(v) {
  try { return JSON.stringify(v); }
  catch (e) { return JSON.stringify({ __stringify_error__: String(e) }); }
}

// 放在 db.js 顶部工具函数附近
function parseDutchAddress(addrText='') {
  // 尝试从 "Dorpsstraat 1, 1234AB Amsterdam" 或 "Dorpsstraat 1 1234 AB Amsterdam" 拆分
  const t = String(addrText).trim();

  // 方案A：逗号分隔
  let m = t.match(/^(.+?)\s+(\S+)\s*,\s*([0-9]{4}\s?[A-Za-z]{2})\s+(.+)$/);
  if (m) return { street: m[1], house_number: m[2], postcode: m[3].replace(/\s+/g,''), city: m[4] };

  // 方案B：无逗号，街道 门牌 邮编 城市
  m = t.match(/^(.+?)\s+(\S+)\s+([0-9]{4}\s?[A-Za-z]{2})\s+(.+)$/);
  if (m) return { street: m[1], house_number: m[2], postcode: m[3].replace(/\s+/g,''), city: m[4] };

  // 兜底：只填 street
  return { street: t, house_number: '', postcode: '', city: '' };
}

// —— 替换你的 toRow() 为下面这个增强版
// 通用取值：返回第一个非空白值
function pick(obj, ...paths) {
  for (const p of paths) {
    const v = p.split('.').reduce((o,k)=> (o && o[k]!==undefined ? o[k] : undefined), obj);
    if (v !== undefined && v !== null && String(v).trim() !== '') return v;
  }
  return undefined;
}

// 荷兰地址拆分："Dorpsstraat 1, 1234AB Amsterdam" / "Dorpsstraat 1 1234 AB Amsterdam"
function parseDutchAddress(addrText='') {
  const t = String(addrText).trim();
  let m = t.match(/^(.+?)\s+(\S+)\s*,\s*([0-9]{4}\s?[A-Za-z]{2})\s+(.+)$/);
  if (m) return { street:m[1], house_number:m[2], postcode:m[3].replace(/\s+/g,''), city:m[4] };
  m = t.match(/^(.+?)\s+(\S+)\s+([0-9]{4}\s?[A-Za-z]{2})\s+(.+)$/);
  if (m) return { street:m[1], house_number:m[2], postcode:m[3].replace(/\s+/g,''), city:m[4] };
  return { street:t, house_number:'', postcode:'', city:'' };
}

// —— 把“真实订单对象 o”映射到你现在这张表（两类订单通吃）
function toRow(oInput) {
  const o = oInput || {};
  const c = o.customer || {};
  const s = o.summary  || {};

  // 基础
  const order_number = pick(o,'order_number','orderNumber');
  if (!order_number) throw new Error('order_number missing');

  // 客户
  const customer_name =
    pick(c,'name','full_name','naam','klantnaam','voornaam') ||
    pick(o,'customer_name','name') || '';
  const phone = pick(c,'phone','telefoon','tel') || pick(o,'phone','telefoon') || '';
  const email = pick(c,'email') || pick(o,'email') || '';

  // 地址（先结构化字段，再整串拆分）
  let street       = pick(o,'street','delivery.street','address.street') || pick(c,'street') || '';
  let house_number = pick(o,'house_number','delivery.house_number','address.house_number') || pick(c,'house_number') || '';
  let postcode     = pick(o,'postcode','delivery.postcode','address.postcode') || pick(c,'postcode','zip') || '';
  let city         = pick(o,'city','delivery.city','address.city') || pick(c,'city') || '';

  const addrText   = pick(c,'address') || pick(o,'address','delivery.address');
  if ((!street || !postcode || !city) && addrText) {
    const parsed = parseDutchAddress(addrText);
    street       = street       || parsed.street;
    house_number = house_number || parsed.house_number;
    postcode     = postcode     || parsed.postcode;
    city         = city         || parsed.city;
  }

  // 类型/时间
  const order_type = pick(o,'order_type','type') || '';
  const tijdslot   = (pick(o,'tijdslot','timeslot') || '').toString();
  const pickup_time   = pick(o,'pickup_time')   || (order_type==='afhalen'  ? (tijdslot || '') : '') || '';
  const delivery_time = pick(o,'delivery_time') || (order_type==='bezorgen' ? (tijdslot || '') : '') || '';

  // 金额/折扣/税（数字化）
  const toNum = v => (v===null || v===undefined || v==='') ? 0 : Number(v);
  const subtotal      = pick(o,'summary.subtotal','subtotal');
  const total         = pick(o,'summary.total','totaal');
  const packaging_fee = toNum(pick(o,'summary.packaging_fee','verpakkingskosten') || 0);
  const delivery_fee  = toNum(pick(o,'summary.delivery_fee','bezorgkosten') || 0);
  const tip           = toNum(pick(o,'summary.tip','fooi') || 0);
  const discount_amt  = toNum(pick(o,'summary.discount','discount_amount','discountAmount') || 0);
  const discount_code = pick(o,'discount_code','discountCode') || '';
  const btw_total     = pick(o,'summary.btw','btw','btw_total');
  const btw_9         = pick(o,'btw_9');
  const btw_21        = pick(o,'btw_21');

  // 备注/支付/状态
  const opmerking      = pick(o,'opmerking','notes','remark','comment') || '';
  const payment_method = pick(o,'payment_method','payment.method','paymentMethod') || '';
  const is_completed   = Number(pick(o,'is_completed') ?? 0);
  const is_cancelled   = Number(pick(o,'is_cancelled') ?? 0);

  // 明细：TEXT
  const items = typeof o.items === 'string'
    ? o.items
    : JSON.stringify(Array.isArray(o.items) ? o.items : (o.items || []));

  return {
    order_id:     String(pick(o,'id') || ''),
    order_number: String(order_number).trim(),

    customer_name, phone, email,
    order_type, pickup_time, delivery_time, payment_method,
    postcode, house_number, street, city,
    opmerking, items,

    subtotal:       subtotal ?? null,
    total:          total ?? null,
    packaging_fee, delivery_fee, tip,
    discount_amount:discount_amt,
    discount_code,

    btw_9:          btw_9 ?? null,
    btw_21:         btw_21 ?? null,
    btw_total:      btw_total ?? null,

    is_completed, is_cancelled,

    data: JSON.stringify(o) // 原始整单
  };
}

// ③ UPSERT 语句（只需定义一次）
const upsertStmt = db.prepare(`
  INSERT INTO orders (
    order_id, order_number, data,
    customer_name, phone, email,
    order_type, pickup_time, delivery_time, payment_method,
    postcode, house_number, street, city,
    opmerking, items,
    subtotal, total, packaging_fee, delivery_fee, tip,
    btw_9, btw_21, btw_total,
    discount_amount, discount_code,
    is_completed, is_cancelled
  ) VALUES (
    @order_id, @order_number, @data,
    @customer_name, @phone, @email,
    @order_type, @pickup_time, @delivery_time, @payment_method,
    @postcode, @house_number, @street, @city,
    @opmerking, @items,
    @subtotal, @total, @packaging_fee, @delivery_fee, @tip,
    @btw_9, @btw_21, @btw_total,
    @discount_amount, @discount_code,
    @is_completed, @is_cancelled
  )
  ON CONFLICT(order_number) DO UPDATE SET
    order_id        = excluded.order_id,
    data            = excluded.data,
    customer_name   = excluded.customer_name,
    phone           = excluded.phone,
    email           = excluded.email,
    order_type      = excluded.order_type,
    pickup_time     = excluded.pickup_time,
    delivery_time   = excluded.delivery_time,
    payment_method  = excluded.payment_method,
    postcode        = excluded.postcode,
    house_number    = excluded.house_number,
    street          = excluded.street,
    city            = excluded.city,
    opmerking       = excluded.opmerking,
    items           = excluded.items,
    subtotal        = excluded.subtotal,
    total           = excluded.total,
    packaging_fee   = excluded.packaging_fee,
    delivery_fee    = excluded.delivery_fee,
    tip             = excluded.tip,
    btw_9           = excluded.btw_9,
    btw_21          = excluded.btw_21,
    btw_total       = excluded.btw_total,
    discount_amount = excluded.discount_amount,
    discount_code   = excluded.discount_code,
    is_completed    = excluded.is_completed,
    is_cancelled    = excluded.is_cancelled,
    created_at      = datetime('now','localtime')
`);




const getByNumberStmt = db.prepare(`SELECT * FROM orders WHERE order_number = ?`);
const getByIdStmt     = db.prepare(`SELECT * FROM orders WHERE id = ?`);
const listRecentStmt  = db.prepare(`SELECT * FROM orders ORDER BY created_at DESC LIMIT ?`);
const listTodayStmt   = db.prepare(`
  SELECT * FROM orders
  WHERE date(created_at)=date('now','localtime')
  ORDER BY created_at DESC
`);

// === 封装 ===
function saveOrder(order)  { const row = toRow(order); upsertStmt.run(row); return true; }
function getOrderByNumber(no) { return getByNumberStmt.get(String(no || '')) || null; }
function getOrderById(id)     { return getByIdStmt.get(Number(id)) || null; }
function listRecent(limit=50) { return listRecentStmt.all(Number(limit)); }
function getOrdersToday()     { return listTodayStmt.all(); }

// === IPC：注册前先移除旧 handler，防止重复注册崩溃 ===
function handleOnce(channel, fn) {
  ipcMain.removeHandler(channel);
  ipcMain.handle(channel, fn);
}

handleOnce('db:save-order', (_e, payload) => {
  console.log('[IPC] db:save-order', payload?.order_number ?? payload?.orderNumber);
  try { saveOrder(payload); return { ok: true }; }
  catch (err) { console.error('[DB] save failed:', err); return { ok: false, error: String(err?.message||err) }; }
});

handleOnce('db:get-orders-today', () => {
  try { return getOrdersToday(); }
  catch (err) { console.error('[DB] query today failed:', err); return []; }
});

handleOnce('db:get-order-by-number', (_e, no) => {
  try { return getOrderByNumber(no); }
  catch (err) { console.error('[DB] get by number failed:', err); return null; }
});

handleOnce('db:get-order-by-id', (_e, id) => {
  try { return getOrderById(id); }
  catch (err) { console.error('[DB] get by id failed:', err); return null; }
});

handleOnce('db:list-recent', (_e, limit = 50) => {
  try { return listRecent(limit); }
  catch (err) { console.error('[DB] list recent failed:', err); return []; }
});

// === 导出（可用于测试脚本）===
module.exports = {
  dbPath, db,
  saveOrder, getOrderByNumber, getOrderById, listRecent, getOrdersToday
};
