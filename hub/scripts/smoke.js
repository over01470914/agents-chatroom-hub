// 端到端 smoke test：假設 hub 已啟動（npm start）。
// 跑：建房 → 人類發訊 → 邀請 openclaw → 配對 → WSS 連線 → 推送 → agent 經 WS 發訊 → 收件匣補讀。
import WebSocket from 'ws';

const REST = process.env.HUB_REST || 'http://127.0.0.1:8787';
const WSS = process.env.HUB_WSS || 'ws://127.0.0.1:8787';
import fs from 'node:fs';
let cfgSecret = 'dev-secret-change-me';
try { cfgSecret = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8')).secret || cfgSecret; } catch {}
const SECRET = process.env.HUB_SECRET || cfgSecret;

let pass = 0, fail = 0;
function check(cond, label) {
  if (cond) { pass++; console.log('  ✓', label); }
  else { fail++; console.log('  ✗', label); }
}
const auth = (tok) => ({ Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' });
const j = (r) => r.json();

async function main() {
  console.log('agora-hub smoke test →', REST);

  const health = await fetch(`${REST}/health`).then(j);
  check(health.ok === true, 'GET /health');

  const room = await fetch(`${REST}/rooms`, { method: 'POST', headers: auth(SECRET), body: JSON.stringify({ name: 'smoke-room' }) }).then(j);
  check(!!room.id, 'POST /rooms 建房');

  // 人類發訊（走獨立路徑，不註冊成 agent）
  const m1 = await fetch(`${REST}/rooms/${room.id}/messages`, {
    method: 'POST', headers: auth(SECRET),
    body: JSON.stringify({ body: 'hello room', authorId: 'human-1', authorName: '翰', mentions: ['room'] }),
  }).then(j);
  check(typeof m1.seq === 'number', 'POST 訊息（human）拿到 seq');

  const log1 = await fetch(`${REST}/rooms/${room.id}/messages?since=0`, { headers: auth(SECRET) }).then(j);
  check(log1.length === 1 && log1[0].author_kind === 'human', 'GET 房間訊息（游標讀）');

  // 邀請 openclaw
  const invite = await fetch(`${REST}/invite`, { method: 'POST', headers: auth(SECRET), body: JSON.stringify({ roomId: room.id, kind: 'openclaw' }) }).then(j);
  check(!!invite.pairingCode && invite.isDaemon === true && /agora_join/.test(invite.prompt), 'POST /invite 產生加入金鑰 + prompt');

  // 配對（用碼換 token）
  const paired = await fetch(`${REST}/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: invite.pairingCode, name: 'EchoBot', avatar: '🤖', host: 'sandbox', kind: 'openclaw' }) }).then(j);
  check(!!paired.agentId && !!paired.token && paired.roomId === room.id, 'POST /pair 拿到 agentId + token');

  // 配對碼一次性
  const reuse = await fetch(`${REST}/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: invite.pairingCode, name: 'x', kind: 'openclaw' }) }).then((r) => r.status);
  check(reuse === 400, '配對碼一次性（重用被拒）');

  // 成員列表含新 agent
  const members = await fetch(`${REST}/rooms/${room.id}/members`, { headers: auth(SECRET) }).then(j);
  check(members.some((x) => x.id === paired.agentId), 'GET 成員列表含新 agent');

  // WSS 連線 + hello + 推送
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WSS}/ws?token=${paired.token}`);
    const timer = setTimeout(() => { reject(new Error('WS timeout')); ws.close(); }, 5000);
    let gotHello = false, gotPush = false, gotPosted = false;

    ws.on('message', async (raw) => {
      const ev = JSON.parse(raw.toString());
      if (ev.type === 'hello') {
        gotHello = true;
        check(ev.agent.id === paired.agentId, 'WSS hello（身分正確）');
        // 人類 @這個 agent → 應推送
        await fetch(`${REST}/rooms/${room.id}/messages`, {
          method: 'POST', headers: auth(SECRET),
          body: JSON.stringify({ body: `@${paired.agentId} ping`, authorId: 'human-1', authorName: '翰', mentions: [paired.agentId] }),
        });
      } else if (ev.type === 'message') {
        gotPush = true;
        check(ev.message.mentions.includes(paired.agentId), 'WSS 收到推送（@我的）');
        // agent 經 WS 回訊
        ws.send(JSON.stringify({ type: 'post', roomId: room.id, body: 'pong', mentions: ['room'] }));
      } else if (ev.type === 'posted') {
        gotPosted = true;
        check(typeof ev.seq === 'number', 'WSS req:post 成功（agent 發訊）');
        clearTimeout(timer);
        ws.close();
        check(gotHello && gotPush && gotPosted, 'WSS 端到端流程');
        resolve();
      }
    });
    ws.on('error', reject);
  });

  // 收件匣補讀（REST 視角）
  const inbox = await fetch(`${REST}/inbox?agent=${paired.agentId}&since=0`, { headers: auth(paired.token) }).then(j);
  check(inbox.length >= 1 && inbox.every((m) => m.author_id !== paired.agentId), 'GET /inbox 補讀（@我的、排除自己）');

  console.log(`\n結果：${pass} 通過 / ${fail} 失敗`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('smoke 失敗：', e.message); process.exit(1); });
