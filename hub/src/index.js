// Hub 進程入口：REST + WSS + 靜態 GUI 接到同一個 HTTP server，共用 db。
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';
import readline from 'node:readline';
import express from 'express';
import config from './config.js';
import * as store from './db.js';
import { makeRouter } from './rest.js';
import { attachWss, broadcast } from './wss.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const guiDir = path.resolve(__dirname, '../../gui/renderer');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

// ---- 啟動 / 埠占用接管 ----

const loopbackOf = (host) => (/^(0\.0\.0\.0|::)$/.test(host) ? '127.0.0.1' : host);

function printBanner() {
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
}

// 嘗試綁定一次：listening → resolve；error → reject（保留 err.code）。
function tryListen() {
  return new Promise((resolve, reject) => {
    const onError = (e) => { server.removeListener('listening', onListening); reject(e); };
    const onListening = () => { server.removeListener('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(config.port, config.host);
  });
}

// 探測占用該埠的服務是不是「同一個 chatroom hub」：打 /health 看 name 是否為 agora-hub。
function probeHub(host, port) {
  return new Promise((resolve) => {
    const req = http.get({ host: loopbackOf(host), port, path: '/health', timeout: 1500 }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { const j = JSON.parse(data); resolve(j && j.name === 'agora-hub' ? j : null); }
        catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

// 該埠是否已無人 listen（連線被拒 = free）。
function portIsFree(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: loopbackOf(host), port });
    socket.setTimeout(800);
    socket.on('connect', () => { socket.destroy(); resolve(false); });
    socket.on('error', () => resolve(true));
    socket.on('timeout', () => { socket.destroy(); resolve(false); });
  });
}

// 找出 LISTENING 在該埠的程序 PID（跨 Windows / POSIX）。
function findPidsOnPort(port) {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    const cmd = isWin
      ? 'netstat -ano'
      : `lsof -nP -iTCP:${port} -sTCP:LISTEN -t 2>/dev/null || ss -ltnpH 'sport = :${port}' 2>/dev/null`;
    exec(cmd, { windowsHide: true }, (err, stdout) => {
      if (!stdout) return resolve([]);
      const pids = new Set();
      if (isWin) {
        for (const line of stdout.split(/\r?\n/)) {
          if (!/LISTENING/i.test(line)) continue;
          if (!new RegExp(`[:.]${port}\\b`).test(line)) continue;
          const parts = line.trim().split(/\s+/);
          const pid = parts[parts.length - 1];
          if (/^\d+$/.test(pid) && pid !== '0') pids.add(pid);
        }
      } else {
        const viaSs = [...stdout.matchAll(/pid=(\d+)/g)].map((m) => m[1]);
        if (viaSs.length) viaSs.forEach((p) => pids.add(p));
        else stdout.split(/\r?\n/).forEach((l) => { if (/^\d+$/.test(l.trim())) pids.add(l.trim()); });
      }
      resolve([...pids].filter((p) => p !== String(process.pid)));
    });
  });
}

// 結束某 PID，回報是否成功（含錯誤訊息，例如權限不足）。
function killPid(pid) {
  return new Promise((resolve) => {
    const cmd = process.platform === 'win32' ? `taskkill /F /PID ${pid}` : `kill -9 ${pid}`;
    exec(cmd, { windowsHide: true }, (err, stdout, stderr) => {
      resolve({ pid, ok: !err, msg: ((stderr || stdout || '').trim()) || (err ? err.message : '') });
    });
  });
}

// 反覆殺掉該埠上的 listener，直到埠釋放或逾時。回 { freed, results }。
async function killAllOnPort(host, port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const results = [];
  let announced = false;
  while (Date.now() < deadline) {
    const pids = await findPidsOnPort(port);
    if (pids.length === 0 && (await portIsFree(host, port))) return { freed: true, results };
    if (pids.length && !announced) { console.error(`  正在結束舊 hub（PID ${pids.join(', ')}）…`); announced = true; }
    for (const pid of pids) results.push(await killPid(pid));
    await sleep(350);
  }
  return { freed: await portIsFree(host, port), results };
}

function ask(question) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) return resolve(''); // 非互動環境：不自動殺，視為「否」
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (a) => { rl.close(); resolve(a); });
  });
}

async function start() {
  // 1) 先正常嘗試綁定
  try { await tryListen(); printBanner(); return; }
  catch (e) { if (e.code !== 'EADDRINUSE') throw e; }

  // 2) 埠被占用：判斷是否同一個 chatroom
  console.error(`\n  ⚠️  ${config.host}:${config.port} 已被占用。`);
  const hub = await probeHub(config.host, config.port);
  if (!hub) {
    console.error(`  占用該埠的不是 Agora chatroom（/health 無回應或非 agora-hub）。`);
    console.error(`  為安全起見不會動它。請設環境變數 HUB_PORT 換埠，或自行處理占用程序後再啟動。\n`);
    process.exit(1);
  }
  console.error(`  偵測到占用者是另一個 Agora chatroom hub 實例（${hub.name} v${hub.version}）。`);

  // 3) 詢問是否接管
  const ans = (await ask(`  要殺掉舊的服務、改由這次啟動接管嗎？[y/N] `)).trim().toLowerCase();
  if (ans !== 'y' && ans !== 'yes') {
    console.error(`  已取消啟動，沿用既有服務即可（或設 HUB_PORT 換埠另開）。\n`);
    process.exit(0);
  }

  // 4) 殺掉該埠所有 listener，輪詢等埠真正釋放
  const { freed, results } = await killAllOnPort(config.host, config.port, 8000);
  for (const r of results) if (!r.ok) console.error(`  ⚠️  結束 PID ${r.pid} 失敗：${r.msg || '未知錯誤'}`);
  if (!freed) {
    const failed = results.filter((r) => !r.ok).map((r) => r.pid);
    console.error(`  舊程序結束後埠仍未釋放。`);
    if (failed.length) console.error(`  PID ${failed.join(', ')} 可能需要系統管理員權限才能結束（請用系統管理員開終端機，或手動執行 taskkill /F /PID ${failed[0]}）。`);
    else console.error(`  可能仍有其他程序占用該埠，或作業系統尚未釋放。請稍候重試，或設 HUB_PORT 換埠啟動。`);
    console.error('');
    process.exit(1);
  }

  // 5) 重試綁定（埠剛釋放，給作業系統一點時間）
  console.error(`  舊 hub 已結束，正在接管…`);
  for (let i = 0; i < 6; i++) {
    try { await tryListen(); printBanner(); return; }
    catch (e) { if (e.code !== 'EADDRINUSE') throw e; await sleep(500); }
  }
  console.error(`  接管後仍無法綁定該埠，放棄。請手動檢查殘留程序，或設環境變數 HUB_PORT 換埠啟動。\n`);
  process.exit(1);
}

start();
