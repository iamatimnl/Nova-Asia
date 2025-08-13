// paths.js
const path = require('path');
const fs = require('fs');
const { app } = require('electron');

function getDbDir() {
  // 类似 C:\Users\<你>\AppData\Roaming\<你的AppName>
  const userData = app.getPath('userData');
  const dir = path.join(userData, 'db'); // 单独放个 db 子目录，便于管理
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getDbPath() {
  return path.join(getDbDir(), 'pos.db');
}

function getBackupDir() {
  const backups = path.join(getDbDir(), 'backups');
  if (!fs.existsSync(backups)) fs.mkdirSync(backups, { recursive: true });
  return backups;
}

module.exports = { getDbPath, getBackupDir, getDbDir };
