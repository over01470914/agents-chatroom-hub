// 載入設定。首次執行若無 config.json，會自動產生（含隨機 secret）→ 零設定啟動。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const hubRoot = path.resolve(__dirname, '..');
const configPath = path.join(hubRoot, 'config.json');

const defaults = {
  host: '127.0.0.1',
  port: 8787,
  secret: null,        // 自動產生
  publicUrl: null,
  db: 'agora.db',
  presenceAwayMs: 60000,
  pairingTtlMs: 600000,
  repoUrl: 'https://cnb.cool/apps.devs/agents-chatroom',
};

function stripComments(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) { if (!k.startsWith('//')) out[k] = v; }
  return out;
}

// 自動初始化：沒有 config.json 就建一份，secret 隨機。
export function ensureConfig() {
  if (fs.existsSync(configPath)) return false;
  const cfg = { ...defaults, secret: randomBytes(24).toString('hex') };
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + '\n');
  return true;
}
ensureConfig();

let fileCfg = {};
try { fileCfg = stripComments(JSON.parse(fs.readFileSync(configPath, 'utf8'))); } catch { fileCfg = {}; }

const merged = { ...defaults, ...fileCfg };
// 萬一 config.json 沒有 secret（舊檔），補一個並寫回。
if (!merged.secret) {
  merged.secret = randomBytes(24).toString('hex');
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    raw.secret = merged.secret;
    fs.writeFileSync(configPath, JSON.stringify(raw, null, 2) + '\n');
  } catch { /* ignore */ }
}

// env 覆蓋
if (process.env.HUB_HOST) merged.host = process.env.HUB_HOST;
if (process.env.HUB_PORT) merged.port = Number(process.env.HUB_PORT);
if (process.env.HUB_SECRET) merged.secret = process.env.HUB_SECRET;
if (process.env.HUB_PUBLIC_URL) merged.publicUrl = process.env.HUB_PUBLIC_URL;
if (process.env.HUB_DB) merged.db = process.env.HUB_DB;

merged.hubRoot = hubRoot;
merged.configPath = configPath;
merged.dbPath = path.isAbsolute(merged.db) ? merged.db : path.join(hubRoot, merged.db);

const base = merged.publicUrl || `http://${merged.host}:${merged.port}`;
merged.restUrl = base;
merged.wssUrl = base.replace(/^http/, 'ws');
// 是否為本機、可安全把 secret 自動帶給同源 GUI
merged.isLocal = !merged.publicUrl && /^(127\.0\.0\.1|localhost)$/.test(merged.host);

export default merged;
