// 載入設定：config.json（若存在）疊加 config.example.json 預設，再被 env 覆蓋。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const hubRoot = path.resolve(__dirname, '..');

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return {};
  }
}

const defaults = {
  host: '127.0.0.1',
  port: 8787,
  secret: 'dev-secret-change-me',
  publicUrl: null,
  db: 'agora.db',
  presenceAwayMs: 60000,
  pairingTtlMs: 600000,
};

const fileCfg = readJson(path.join(hubRoot, 'config.json'));

const merged = { ...defaults, ...stripComments(fileCfg) };

// env 覆蓋
if (process.env.HUB_HOST) merged.host = process.env.HUB_HOST;
if (process.env.HUB_PORT) merged.port = Number(process.env.HUB_PORT);
if (process.env.HUB_SECRET) merged.secret = process.env.HUB_SECRET;
if (process.env.HUB_PUBLIC_URL) merged.publicUrl = process.env.HUB_PUBLIC_URL;
if (process.env.HUB_DB) merged.db = process.env.HUB_DB;

merged.hubRoot = hubRoot;
merged.dbPath = path.isAbsolute(merged.db) ? merged.db : path.join(hubRoot, merged.db);

// 對外網址：本地開發自動推導；上雲時 publicUrl 指定 https/wss。
const base = merged.publicUrl || `http://${merged.host}:${merged.port}`;
merged.restUrl = base;
merged.wssUrl = base.replace(/^http/, 'ws');

function stripComments(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k.startsWith('//')) continue;
    out[k] = v;
  }
  return out;
}

export default merged;
