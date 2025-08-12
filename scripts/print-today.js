const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const dbPath = path.join(__dirname, '..', 'data', 'orders.db');
if (!fs.existsSync(dbPath)) {
  console.log('Database not found.');
  process.exit(0);
}
try {
  const query = "SELECT order_number, data, source_json, created_at FROM orders WHERE date(created_at)=date('now','localtime') ORDER BY created_at DESC;";
  const result = execSync(`sqlite3 ${dbPath} "${query}"`, { encoding: 'utf8' });
  console.log(result.trim());
} catch (e) {
  console.error('Failed to query orders:', e.message);
}
