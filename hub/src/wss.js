// WSS：daemon 成員的持久雙向連接。負責推送「@我的 / @room」訊息 + 心跳 + 經 WS 發訊。
import { WebSocketServer } from 'ws';
import { URL } from 'node:url';
import { authWsToken } from './auth.js';
import * as store from './db.js';

// agentId -> Set<ws>
const live = new Map();

function track(agentId, ws) {
  if (!live.has(agentId)) live.set(agentId, new Set());
  live.get(agentId).add(ws);
  store.setPresence(agentId, 'online');
}
function untrack(agentId, ws) {
  const set = live.get(agentId);
  if (set) {
    set.delete(ws);
    if (set.size === 0) {
      live.delete(agentId);
      store.setPresence(agentId, 'gone'); // daemon 斷線即 gone
    }
  }
}

function send(ws, type, payload) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type, ...payload }));
}

// 給 rest.js / 內部呼叫：訊息落庫後推給該收的 daemon 成員。
export function broadcast(message) {
  for (const [agentId, sockets] of live.entries()) {
    if (agentId === message.author_id) continue;
    if (!store.isMember(message.room_id, agentId)) continue;
    const hit = message.mentions.includes('room') || message.mentions.includes(agentId);
    if (!hit) continue;
    for (const ws of sockets) send(ws, 'message', { message });
  }
}

export function attachWss(server, postMessageFn) {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://x');
    const token = url.searchParams.get('token');
    const agent = authWsToken(token);
    if (!agent) {
      send(ws, 'error', { error: 'unauthorized' });
      ws.close();
      return;
    }
    ws.agentId = agent.id;
    ws.isAlive = true;
    track(agent.id, ws);
    send(ws, 'hello', {
      agent: { id: agent.id, name: agent.name, avatar: agent.avatar, host: agent.host, kind: agent.kind },
      rooms: store.roomsForAgent(agent.id),
    });

    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      store.touchActivity(agent.id);

      // req: post —— 經 WS 發訊息（與 REST POST 等價）。
      if (msg.type === 'post') {
        const { roomId, body, mentions = [], replyTo = null, relates = null } = msg;
        if (!store.isMember(roomId, agent.id)) {
          send(ws, 'error', { error: 'not_a_member', roomId });
          return;
        }
        const saved = postMessageFn({
          roomId,
          authorId: agent.id,
          authorKind: 'agent',
          authorName: agent.name,
          body,
          mentions,
          replyTo,
          relates,
        });
        send(ws, 'posted', { seq: saved.seq, id: saved.id });
        return;
      }

      // req: read_inbox —— 補讀離線期間 @我的訊息。
      if (msg.type === 'read_inbox') {
        const since = msg.since ?? 0;
        const items = store.readInbox(agent.id, since);
        send(ws, 'inbox', { items });
        return;
      }

      // req: cursor —— 推進收件匣游標。
      if (msg.type === 'cursor') {
        if (msg.roomId != null && msg.seq != null) store.setCursor(msg.roomId, agent.id, msg.seq);
        return;
      }

      // req: presence
      if (msg.type === 'presence' && msg.status) {
        store.setPresence(agent.id, msg.status);
      }
    });

    ws.on('close', () => untrack(agent.id, ws));
    ws.on('error', () => untrack(agent.id, ws));
  });

  // 心跳：定期 ping，沒回 pong 的視為死連接。
  const interval = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) { ws.terminate(); continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch { /* ignore */ }
    }
  }, 30000);
  wss.on('close', () => clearInterval(interval));

  return wss;
}
