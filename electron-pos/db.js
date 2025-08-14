// db.js — Electron 主进程：稳健版
const { app, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

// ---------- 配置 & 路径 ----------
const ENV_DB = process.env.NOVA_DB_PATH && process.env.NOVA_DB_PATH.trim();
const defaultDbPath = path.join('D:', 'NovaAsia1', 'data', 'orders.db'); // 兼容你原方案
const userDataDbPath = app?.getPath ? path.join(app.getPath('userData'), 'orders.db') : defaultDbPath;

// 优先级：环境变量 > 你的 D 盘路径 > userData
const dbPath = ENV_DB || defaultDbPath || userDataDbPath;
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
console.log('[DB] file =', dbPath);

// ---------- 连接 ----------
const db = new Database(dbPath, { timeout: 8000 }); // 8s 超时，防止 “database is locked”
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ---------- 安全 JSON ----------
function safeStringify(v) {
  try { return JSON.stringify(v); }
  catch (e) {
    try { return JSON.stringify({ __stringify_error__: String(e) }); }
    catch { return '{"__stringify_error__":"unknown"}'; }
  }
}

// ---------- 工具 ----------
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

// ---------- 首次建表 ----------
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

// ---------- 轻量“自愈迁移” ----------
function ensureColumn(table, column, type) {
  const row = db.prepare(`PRAGMA table_info(${table})`).all()
    .find(r => r.name === column);
  if (!row) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type};`);
    console.log(`[DB] MIGRATION: add ${table}.${column} ${type}`);
  }
}
ensureColumn('orders', 'bron', 'TEXT');
ensureColumn('orders', 'discount_amount', 'REAL');
ensureColumn('orders', 'discount_code', 'TEXT');
ensureColumn('orders', 'discountAmount', 'REAL');
ensureColumn('orders', 'discountCode', 'TEXT');

// 把 camelCase 合并到 snake_case（可选：按需启用一次）
function unifyDiscountOnce() {
  const has = db.prepare(`
    SELECT EXISTS(
      SELECT 1 FROM orders 
      WHERE (discount_amount IS NULL OR discount_amount=0) 
        AND (discountAmount IS NOT NULL AND discountAmount!=0)
    ) AS need
  `).get().need;
  if (has) {
    const tx = db.transaction(() => {
      db.exec(`
        UPDATE orders
        SET discount_amount = COALESCE(discount_amount, discountAmount),
            discount_code   = COALESCE(discount_code,   discountCode)
        WHERE (discountAmount IS NOT NULL AND discountAmount!=0)
           OR (discountCode   IS NOT NULL AND discountCode   !='');
      `);
    });
    tx();
    console.log('[DB] MIGRATION: unify discountAmount/discountCode -> discount_amount/discount_code');
  }
}
// 可选择调用一次（若你决定统一字段）
// unifyDiscountOnce();

// ---------- 映射 & 校验 ----------
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
  const bron           = toStr(pick(o,'bron','source') || 'pos'); // 关键：保证一定有

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

// ---------- 预编译 SQL ----------
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

// ---------- 事务包装 ----------
const txUpsert = db.transaction((row) => upsertStmt.run(row));

// ---------- API ----------
function saveOrder(order)  {
  try {
    const row = toRow(order);
    txUpsert(row);
    return true;
  } catch (err) {
    // 带参数快照便于追查
    console.error('[DB] save failed:', err?.stack || err);
    try { console.error('[DB] lastOrderPreview =', safeStringify(order)); } catch {}
    return false;
  }
}
function getOrderByNumber(no) { try { return getByNumberStmt.get(String(no || '')) || null; } catch (e) { console.error(e); return null; } }
function getOrderById(id)     { try { return getByIdStmt.get(Number(id)) || null; } catch (e) { console.error(e); return null; } }
function listRecent(limit=50) { try { return listRecentStmt.all(Number(limit)); } catch (e) { console.error(e); return []; } }
function getOrdersToday()     { try { return listTodayStmt.all(); } catch (e) { console.error(e); return []; } }

// ---------- IPC ----------
function handleOnce(channel, fn) { ipcMain.removeHandler(channel); ipcMain.handle(channel, fn); }

handleOnce('db:save-order', (_e, payload) => ({ ok: !!saveOrder(payload) }));
handleOnce('db:get-orders-today', () => { try { return getOrdersToday(); } catch (e) { console.error(e); return []; } });
handleOnce('db:get-order-by-number', (_e, no) => { try { return getOrderByNumber(no); } catch (e) { console.error(e); return null; } });
handleOnce('db:get-order-by-id', (_e, id) => { try { return getOrderById(id); } catch (e) { console.error(e); return null; } });
handleOnce('db:list-recent', (_e, limit=50) => { try { return listRecent(limit); } catch (e) { console.error(e); return []; } });

// ---------- exports ----------
module.exports = {
  dbPath, db,
  saveOrder, getOrderByNumber, getOrderById, listRecent, getOrdersToday
};
