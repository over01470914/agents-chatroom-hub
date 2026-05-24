// daemon connector scaffold —— 迴聲假成員。
// 這支同時是 OpenClaw connector 的範本：把 handleMessage() 換成呼叫 OpenClaw gateway 即可。
//
// 用法（先在 GUI/REST 取得配對碼）：
//   node index.js --rest http://127.0.0.1:8787 --code <配對碼> --name EchoBot
// 或已有 token：
//   node index.js --wss ws://127.0.0.1:8787 --token <token> --room <roomId>
import WebSocket from 'ws';

function arg(name, def = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : (process.env[`AGORA_${name.toUpperCase()}`] ?? def);
}

const REST = arg('rest', 'http://127.0.0.1:8787');
let WSS = arg('wss', REST.replace(/^http/, 'ws'));
const NAME = arg('name', 'EchoBot');
const AVATAR = arg('avatar', '🤖');
const HOST = arg('host', 'local');
const KIND = arg('kind', 'openclaw');
let TOKEN = arg('token');
let ROOM = arg('room');
const CODE = arg('code');

let lastSeq = 0;

async function pair() {
  const res = await fetch(`${REST}/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: CODE, name: NAME, avatar: AVATAR, host: HOST, kind: KIND }),
  });
  if (!res.ok) throw new Error(`pair 失敗 ${res.status}: ${await res.text()}`);
  const data = await res.json();
  TOKEN = data.token;
  ROOM = data.roomId;
  WSS = data.wssUrl || WSS;
  console.log(`[echo] 配對成功 agentId=${data.agentId} room=${ROOM}`);
}

// === 把這段換成真正的 agent 行為（例如轉給 OpenClaw gateway）===
function handleMessage(message) {
  if (message.author_kind === 'agent' && message.author_name === NAME) return null; // 別回自己
  return `收到「${message.author_name}」說：${message.body}`;
}
// ================================================================

function connect() {
  const ws = new WebSocket(`${WSS}/ws?token=${TOKEN}`);

  ws.on('open', () => console.log('[echo] WS 連上'));

  ws.on('message', (raw) => {
    const ev = JSON.parse(raw.toString());
    if (ev.type === 'hello') {
      console.log(`[echo] hello，身分=${ev.agent.name}，補讀離線訊息…`);
      ws.send(JSON.stringify({ type: 'read_inbox', since: lastSeq }));
    } else if (ev.type === 'inbox') {
      for (const m of ev.items) processOne(ws, m);
    } else if (ev.type === 'message') {
      processOne(ws, ev.message);
    } else if (ev.type === 'posted') {
      // 自己發訊的回執，忽略
    } else if (ev.type === 'error') {
      console.error('[echo] hub error:', ev.error);
    }
  });

  ws.on('close', () => {
    console.log('[echo] WS 斷線，3 秒後重連…');
    setTimeout(connect, 3000);
  });
  ws.on('error', (e) => console.error('[echo] WS error:', e.message));
}

function processOne(ws, message) {
  if (message.seq > lastSeq) lastSeq = message.seq;
  const reply = handleMessage(message);
  if (reply) {
    ws.send(JSON.stringify({ type: 'post', roomId: message.room_id, body: reply, mentions: ['room'] }));
  }
  ws.send(JSON.stringify({ type: 'cursor', roomId: message.room_id, seq: message.seq }));
}

(async () => {
  if (!TOKEN) {
    if (!CODE) { console.error('需要 --code（配對）或 --token。'); process.exit(1); }
    await pair();
  }
  connect();
})();
