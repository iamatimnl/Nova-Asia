// db.js — Electron 主进程：稳健完整版（含批量同步 & 更新功能）
const { app, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

/* ===================== 配置 ===================== */
// 数据库路径优先级：环境变量 > 你的 D 盘默认路径 > Electron userData
const ENV_DB = process.env.NOVA_DB_PATH && process.env.NOVA_DB_PATH.trim();
const defaultDbPath = path.join('D:', 'NovaAsia1', 'data', 'orders.db');
const userDataDbPath = app?.getPath ? path.join(app.getPath('userData'), 'orders.db') : defaultDbPath;
const dbPath = ENV_DB || defaultDbPath || userDataDbPath;

// 是否强制 bron 必填（true：缺失报错并拒绝写入；false：缺失时使用默认值 DEFAULT_BRON）
const REQUIRE_BRON = true;
const DEFAULT_BRON = 'pos'; // 当 REQUIRE_BRON=false 时生效

// 允许通过“更新接口”修改的列（白名单）
const WRITABLE_COLUMNS = new Set([
  'order_id','order_number',
  'customer_name','phone','email',
  'order_type','pickup_time','delivery_time','payment_method',
  'postcode','house_number','street','city',
  'opmerking','items',
  'subtotal','total','packaging_fee','delivery_fee','tip',
  'btw_9','btw_21','btw_total',
  'discount_amount','discount_code','discountAmount','discountCode',
  'is_completed','is_cancelled',
  'bron',
  // 如确需支持修改 data / created_at，可在确认风险后加入：
  // 'data', 'created_at'
]);

/* ===================== 初始化连接 ===================== */
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
console.log('[DB] file =', dbPath);
const db = new Database(dbPath, { timeout: 8000 }); // 8s 防锁
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

/* ===================== 工具函数 ===================== */
function safeStringify(v) {
  try { return JSON.stringify(v); }
  catch (e) {
    try { return JSON.stringify({ __stringify_error__: String(e) }); }
    catch { return '{"__stringify_error__":"unknown"}'; }
  }
}
function pick(obj, ...paths) {
  for (const p of paths) {
    if (!p) continue;
    const parts = String(p).split('.');
    let cur = obj, ok = true;
    for (const k of parts) {
      if (cur && Object.prototype.hasOwnProperty.call(cur, k)) cur = cur[k];
      else { ok = false; break; }
    }
    if (ok && cur !== undefined && cur !== null && cur !== '') return cur;
  }
  return undefined;
}
const toStr = v => (v===undefined || v===null) ? '' : String(v);
const toNum = v => (v===null || v===undefined || v==='') ? null : Number(v);

/* ===================== 建表（与现有结构对齐） ===================== */
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
    discountAmount REAL,
    discountCode TEXT,
    is_completed INTEGER DEFAULT 0,
    is_cancelled INTEGER DEFAULT 0,
    bron TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_orders_order_id   ON orders(order_id);
`);

/* ===================== 轻量自愈迁移 ===================== */
function ensureColumn(table, column, type) {
  const exists = db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === column);
  if (!exists) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type};`);
    console.log(`[DB] MIGRATION: add ${table}.${column} ${type}`);
  }
}
ensureColumn('orders', 'bron', 'TEXT');
ensureColumn('orders', 'discount_amount', 'REAL');
ensureColumn('orders', 'discount_code', 'TEXT');
ensureColumn('orders', 'discountAmount', 'REAL');
ensureColumn('orders', 'discountCode', 'TEXT');


/* ===================== 字段映射（含 bron 约束） ===================== */
function toRow(oInput) {
  const o = oInput || {};
  const c = o.customer || {};

  const order_number = toStr(pick(o, 'order_number', 'orderNumber')).trim();
  if (!order_number) throw new Error('order_number missing');

  // 客户
  const customer_name =
    toStr(pick(c,'name','full_name','naam','klantnaam','voornaam') || pick(o,'customer_name','name') || '');
  const phone = toStr(pick(c,'phone','telefoon','tel') || pick(o,'phone','telefoon') || '');
  const email = toStr(pick(c,'email') || pick(o,'email') || '');

  // 地址
  let street       = toStr(pick(o,'street','delivery.street','address.street') || pick(c,'street') || '');
  let house_number = toStr(pick(o,'house_number','delivery.house_number','address.house_number') || pick(c,'house_number') || '');
  let postcode     = toStr(pick(o,'postcode','delivery.postcode','address.postcode') || pick(c,'postcode','zip') || '');
  let city         = toStr(pick(o,'city','delivery.city','address.city') || pick(c,'city') || '');
  const addrText   = pick(c,'address') || pick(o,'address','delivery.address');
  if ((!street || !postcode || !city) && addrText) {
    const m = String(addrText).match(/^\s*([^0-9]+?)\s+([0-9]+[a-zA-Z]?)\s*,?\s*([0-9]{4}\s?[A-Z]{2})?\s*(.+)?$/);
    street       = street       || (m?.[1]?.trim() || '');
    house_number = house_number || (m?.[2]?.trim() || '');
    postcode     = postcode     || (m?.[3]?.replace(/\s+/g,'') || '');
    city         = city         || ((m?.[4]||'').trim());
  }

  // 类型/时间
  const order_type    = toStr(pick(o,'order_type','type') || '');
  const tijdslot      = toStr(pick(o,'tijdslot','timeslot') || '');
  const pickup_time   = toStr(pick(o,'pickup_time')   || (order_type==='afhalen'  ? (tijdslot || '') : '') || '');
  const delivery_time = toStr(pick(o,'delivery_time') || (order_type==='bezorgen' ? (tijdslot || '') : '') || '');

  // 金额/折扣/税
  const subtotal      = toNum(pick(o,'summary.subtotal','subtotal'));
  const total         = toNum(pick(o,'summary.total','totaal','total'));
  const packaging_fee = toNum(pick(o,'summary.packaging_fee','verpakkingskosten','packaging_fee'));
  const delivery_fee  = toNum(pick(o,'summary.delivery_fee','bezorgkosten','delivery_fee'));
  const tip           = toNum(pick(o,'summary.tip','fooi','tip'));
  const discount_amount = toNum(pick(o,'discount_amount'));
  const discount_code   = toStr(pick(o,'discount_code') || '');
  const discountAmount  = toNum(pick(o,'discountAmount'));
  const discountCode    = toStr(pick(o,'discountCode') || '');
  const btw_total     = toNum(pick(o,'summary.btw','btw','btw_total'));
  const btw_9         = toNum(pick(o,'btw_9'));
  const btw_21        = toNum(pick(o,'btw_21'));

  // 备注/支付/状态/来源
  const opmerking      = toStr(pick(o,'opmerking','notes','remark','comment') || '');
  const payment_method = toStr(pick(o,'payment_method','payment.method','paymentMethod') || '');
  const is_completed   = Number(pick(o,'is_completed') ?? 0);
  const is_cancelled   = Number(pick(o,'is_cancelled') ?? 0);

  // bron：强制 or 默认
  let bron = toStr(pick(o,'bron','source') || '');
  if (REQUIRE_BRON) {
    if (!bron.trim()) throw new Error('bron required');
  } else {
    if (!bron.trim()) bron = DEFAULT_BRON;
  }

  // 明细列
  const items = typeof o.items === 'string'
    ? o.items
    : safeStringify(Array.isArray(o.items) ? o.items : (o.items || []));

  return {
    order_id:     toStr(pick(o,'id') || ''),
    order_number,

    customer_name, phone, email,
    order_type, pickup_time, delivery_time, payment_method,
    postcode, house_number, street, city,
    opmerking, items,

    subtotal, total, packaging_fee, delivery_fee, tip,
    discount_code, discount_amount,   // snake_case
    discountCode,  discountAmount,    // camelCase

    btw_9, btw_21, btw_total,
    is_completed, is_cancelled,
    bron,
    data: safeStringify(o)
  };
}

/* ===================== 预编译 SQL & 事务 ===================== */
const upsertSQL = `
INSERT INTO orders (
  order_id, order_number, order_type, customer_name, phone, email,
  pickup_time, delivery_time, payment_method, postcode, house_number, street, city, opmerking,
  items, subtotal, total, packaging_fee, delivery_fee, tip, btw_9, btw_21, btw_total, bron,
  discount_code, discount_amount,
  discountCode, discountAmount,
  data
) VALUES (
  @order_id, @order_number, @order_type, @customer_name, @phone, @email,
  @pickup_time, @delivery_time, @payment_method, @postcode, @house_number, @street, @city, @opmerking,
  @items, @subtotal, @total, @packaging_fee, @delivery_fee, @tip, @btw_9, @btw_21, @btw_total, @bron,
  @discount_code, @discount_amount,
  @discountCode, @discountAmount,
  @data
)
ON CONFLICT(order_number) DO UPDATE SET
  order_type=excluded.order_type,
  customer_name=excluded.customer_name,
  phone=excluded.phone,
  email=excluded.email,
  pickup_time=excluded.pickup_time,
  delivery_time=excluded.delivery_time,
  payment_method=excluded.payment_method,
  postcode=excluded.postcode,
  house_number=excluded.house_number,
  street=excluded.street,
  city=excluded.city,
  opmerking=excluded.opmerking,
  items=excluded.items,
  subtotal=excluded.subtotal,
  total=excluded.total,
  packaging_fee=excluded.packaging_fee,
  delivery_fee=excluded.delivery_fee,
  tip=excluded.tip,
  btw_9=excluded.btw_9,
  btw_21=excluded.btw_21,
  btw_total=excluded.btw_total,
  discount_code=excluded.discount_code,
  discount_amount=excluded.discount_amount,
  discountCode=excluded.discountCode,
  discountAmount=excluded.discountAmount,
  bron=excluded.bron,
  data=excluded.data
`;
const upsertStmt = db.prepare(upsertSQL);
const getByNumberStmt = db.prepare(`SELECT * FROM orders WHERE order_number = ?`);
const getByIdStmt     = db.prepare(`SELECT * FROM orders WHERE id = ?`);
const listRecentStmt  = db.prepare(`SELECT * FROM orders ORDER BY created_at DESC LIMIT ?`);
const listTodayStmt   = db.prepare(`
  SELECT * FROM orders
  WHERE date(created_at)=date('now','localtime')
  ORDER BY created_at DESC
`);

const txUpsert = db.transaction((row) => upsertStmt.run(row));

/* ===================== 基础 API ===================== */
function saveOrder(order)  {
  const row = toRow(order); // 缺 bron / 缺 order_number 会 throw
  txUpsert(row);
  return true;
}
function getOrderByNumber(no) { return getByNumberStmt.get(String(no || '')) || null; }
function getOrderById(id)     { return getByIdStmt.get(Number(id)) || null; }
function listRecent(limit=50) { return listRecentStmt.all(Number(limit)); }
function getOrdersToday()     { return listTodayStmt.all(); }

/* ===================== 批量 UPSERT（给 fetch 后同步用） ===================== */
function upsertBatch(orders = []) {
  if (!Array.isArray(orders)) throw new Error('orders must be an array');
  const result = { saved: 0, skipped: 0, errors: [] };

  const tx = db.transaction((arr) => {
    for (let i = 0; i < arr.length; i++) {
      const raw = arr[i];
      try {
        const row = toRow(raw);
        txUpsert(row);
        result.saved++;
      } catch (e) {
        result.skipped++;
        result.errors.push({
          index: i,
          order_number: (raw && (raw.order_number || raw.orderNumber)) || null,
          message: e && e.message ? e.message : String(e)
        });
      }
    }
  });

  tx(orders);
  return result;
}

/* ===================== 更新（按 id / 按 order_number） ===================== */
function sanitizePatch(patch = {}) {
  const out = {};
  for (const [k, v] of Object.entries(patch)) {
    if (!WRITABLE_COLUMNS.has(k)) continue;
    switch (k) {
      case 'subtotal':
      case 'total':
      case 'packaging_fee':
      case 'delivery_fee':
      case 'tip':
      case 'btw_9':
      case 'btw_21':
      case 'btw_total':
      case 'discount_amount':
      case 'discountAmount':
        out[k] = toNum(v);
        break;
      case 'is_completed':
      case 'is_cancelled':
        out[k] = Number(v ? 1 : 0);
        break;
      case 'bron':
        if (REQUIRE_BRON && !toStr(v).trim()) throw new Error('bron cannot be empty');
        out[k] = toStr(v);
        break;
      default:
        out[k] = toStr(v);
        break;
    }
  }
  return out;
}
function buildUpdateSQL(table, patchObj) {
  const keys = Object.keys(patchObj);
  if (keys.length === 0) return null;
  const sets = keys.map(k => `${k}=@${k}`).join(', ');
  return `UPDATE ${table} SET ${sets} WHERE `;
}
function updateOrderById(id, patch = {}) {
  const rowId = Number(id);
  if (!rowId) throw new Error('invalid id');

  const clean = sanitizePatch(patch);
  const base = buildUpdateSQL('orders', clean);
  if (!base) return 0;

  const sql = base + `id=@__id`;
  const stmt = db.prepare(sql);

  const tx = db.transaction(() => {
    const exist = getByIdStmt.get(rowId);
    if (!exist) return 0;
    const params = { ...clean, __id: rowId };
    const info = stmt.run(params);
    return info.changes || 0;
  });
  return tx();
}
function updateOrderByNumber(orderNumber, patch = {}) {
  const no = toStr(orderNumber).trim();
  if (!no) throw new Error('invalid order_number');

  const clean = sanitizePatch(patch);
  const base = buildUpdateSQL('orders', clean);
  if (!base) return 0;

  const sql = base + `order_number=@__no`;
  const stmt = db.prepare(sql);

  const tx = db.transaction(() => {
    const exist = getByNumberStmt.get(no);
    if (!exist) return 0;
    const params = { ...clean, __no: no };
    const info = stmt.run(params);
    return info.changes || 0;
  });
  return tx();
}

/* ===================== IPC 注册 ===================== */
function handleOnce(channel, fn) { ipcMain.removeHandler(channel); ipcMain.handle(channel, fn); }

// 保存/单条
handleOnce('db:save-order', (_e, payload) => {
  try { return { ok: !!saveOrder(payload) }; }
  catch (err) {
    console.error('[DB] save failed:', err?.stack || err);
    try { console.error('[DB] lastOrderPreview =', safeStringify(payload)); } catch {}
    return { ok: false, error: err?.message || String(err) };
  }
});

// 批量 upsert（用于 fetch /pos/orders_today 后同步到本地）
handleOnce('db:upsert-batch', (_e, ordersArray) => {
  try {
    const stat = upsertBatch(ordersArray || []);
    return { ok: true, ...stat };
  } catch (err) {
    console.error('[DB] upsert-batch failed:', err?.stack || err);
    return { ok: false, error: err?.message || String(err) };
  }
});

// 更新
handleOnce('db:update-order-by-id', (_e, id, patch) => {
  try {
    const changes = updateOrderById(id, patch);
    const updated = changes ? getByIdStmt.get(Number(id)) : null;
    return { ok: true, changes, data: updated };
  } catch (err) {
    console.error('[DB] update by id failed:', err?.stack || err);
    return { ok: false, error: err?.message || String(err) };
  }
});
handleOnce('db:update-order-by-number', (_e, no, patch) => {
  try {
    const changes = updateOrderByNumber(no, patch);
    const updated = changes ? getByNumberStmt.get(String(no)) : null;
    return { ok: true, changes, data: updated };
  } catch (err) {
    console.error('[DB] update by number failed:', err?.stack || err);
    return { ok: false, error: err?.message || String(err) };
  }
});

// 查询
handleOnce('db:get-orders-today', () => { try { return getOrdersToday(); } catch (e) { console.error(e); return []; } });
handleOnce('db:get-order-by-number', (_e, no) => { try { return getOrderByNumber(no); } catch (e) { console.error(e); return null; } });
handleOnce('db:get-order-by-id', (_e, id) => { try { return getOrderById(id); } catch (e) { console.error(e); return null; } });
handleOnce('db:list-recent', (_e, limit=50) => { try { return listRecent(limit); } catch (e) { console.error(e); return []; } });

/* ===================== 导出 ===================== */
module.exports = {
  dbPath, db,
  saveOrder, upsertBatch,
  updateOrderById, updateOrderByNumber,
  getOrderByNumber, getOrderById, listRecent, getOrdersToday
};
