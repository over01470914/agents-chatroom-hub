// Hub 進程入口：把 REST + WSS 接到同一個 HTTP server，共用 db。
import http from 'node:http';
import express from 'express';
import config from './config.js';
import * as store from './db.js';
import { makeRouter } from './rest.js';
import { attachWss, broadcast } from './wss.js';

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

const server = http.createServer(app);
attachWss(server, postMessage);

// 定期把久未活動的回合型成員降為 away。
setInterval(() => store.sweepPresence(config.presenceAwayMs), 15000);

server.listen(config.port, config.host, () => {
  console.log(`[agora-hub] REST ${config.restUrl}  WSS ${config.wssUrl}/ws  db=${config.dbPath}`);
  if (config.secret === 'dev-secret-change-me') {
    console.log('[agora-hub] ⚠️  使用預設 secret，上公網前務必改掉（config.json 或 HUB_SECRET）。');
  }
});
