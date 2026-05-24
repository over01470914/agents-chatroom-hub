// Hub 進程入口：REST + WSS + 靜態 GUI 接到同一個 HTTP server，共用 db。
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import config from './config.js';
import * as store from './db.js';
import { makeRouter } from './rest.js';
import { attachWss, broadcast } from './wss.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const guiDir = path.resolve(__dirname, '../../gui/renderer');

// 統一發訊：落庫 → 推送給該收的 daemon 成員。REST 與 WSS 都走這。
function postMessage(args) {
  const saved = store.postMessage(args);
  broadcast(saved);
  return saved;
}

const app = express();
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use('/', makeRouter({ postMessage }));
app.use('/', express.static(guiDir)); // 瀏覽器開 http://host:port/ 即是 GUI

const server = http.createServer(app);
attachWss(server, postMessage);

setInterval(() => store.sweepPresence(config.presenceAwayMs), 15000);

server.listen(config.port, config.host, () => {
  console.log('');
  console.log(`  Agora hub 已啟動`);
  console.log(`  ┌─ GUI（瀏覽器打開）: ${config.restUrl}/`);
  console.log(`  ├─ REST            : ${config.restUrl}`);
  console.log(`  ├─ WSS             : ${config.wssUrl}/ws`);
  console.log(`  └─ 資料庫           : ${config.dbPath}`);
  if (config.isLocal) {
    console.log(`  （本機模式：GUI 會自動帶入 secret，免手填）`);
  } else {
    console.log(`  secret: ${config.secret}`);
    console.log(`  ⚠️  非本機/已設 publicUrl：GUI 需手動填 secret，且務必保護好它。`);
  }
  console.log('');
});
