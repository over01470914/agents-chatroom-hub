// HTTPS REST：回合型成員 + GUI + 人類入口。router 工廠，注入 postMessage（落庫+推送）。
import express from 'express';
import config from './config.js';
import * as store from './db.js';
import { requireSecret, requireActor } from './auth.js';
import { buildInvitePrompt, isDaemonKind } from './invitePrompts.js';

export function makeRouter({ postMessage }) {
  const r = express.Router();
  r.use(express.json());

  r.get('/health', (req, res) => res.json({ ok: true, name: 'agora-hub', version: '0.1.0' }));

  // ---- rooms ----
  r.post('/rooms', requireSecret, (req, res) => {
    const name = (req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name_required' });
    res.json(store.createRoom(name));
  });

  r.get('/rooms', requireActor, (req, res) => res.json(store.listRooms()));

  r.get('/rooms/:id', requireActor, (req, res) => {
    const room = store.getRoom(req.params.id);
    if (!room) return res.status(404).json({ error: 'not_found' });
    res.json({ ...room, members: store.listMembers(room.id) });
  });

  r.get('/rooms/:id/members', requireActor, (req, res) => {
    res.json(store.listMembers(req.params.id));
  });

  // 加成員（GUI 操作或 pair 流程內部呼叫）
  r.post('/rooms/:id/join', requireSecret, (req, res) => {
    const { agentId } = req.body || {};
    if (!store.getRoom(req.params.id)) return res.status(404).json({ error: 'room_not_found' });
    if (!store.getAgent(agentId)) return res.status(404).json({ error: 'agent_not_found' });
    store.addMember(req.params.id, agentId);
    res.json({ ok: true });
  });

  // ---- messages ----
  r.post('/rooms/:id/messages', requireActor, (req, res) => {
    const room = store.getRoom(req.params.id);
    if (!room) return res.status(404).json({ error: 'room_not_found' });
    const { body, mentions = [], replyTo = null, relates = null } = req.body || {};
    if (!body) return res.status(400).json({ error: 'body_required' });

    let authorId, authorKind, authorName;
    if (req.actor.kind === 'agent') {
      const a = req.actor.agent;
      if (!store.isMember(room.id, a.id)) return res.status(403).json({ error: 'not_a_member' });
      authorId = a.id; authorKind = 'agent'; authorName = a.name;
      store.touchActivity(a.id);
    } else {
      // human 走獨立路徑：不註冊成 agent，身分由 GUI 提供。
      authorId = req.body?.authorId || 'human';
      authorKind = 'human';
      authorName = req.body?.authorName || 'Human';
    }

    const saved = postMessage({ roomId: room.id, authorId, authorKind, authorName, body, mentions, replyTo, relates });
    res.json({ seq: saved.seq, id: saved.id, created_at: saved.created_at });
  });

  r.get('/rooms/:id/messages', requireActor, (req, res) => {
    const since = Number(req.query.since || 0);
    res.json(store.readRoom(req.params.id, since));
  });

  // ---- inbox（@我的）----
  r.get('/inbox', requireActor, (req, res) => {
    const agentId = req.query.agent;
    if (!agentId) return res.status(400).json({ error: 'agent_required' });
    if (req.actor.kind === 'agent' && req.actor.agent.id !== agentId)
      return res.status(403).json({ error: 'forbidden' });
    if (req.actor.kind === 'agent') store.touchActivity(agentId);
    const since = Number(req.query.since || 0);
    res.json(store.readInbox(agentId, since));
  });

  // ---- cursor ----
  r.post('/cursor', requireActor, (req, res) => {
    const { roomId, agentId, seq } = req.body || {};
    if (req.actor.kind === 'agent' && req.actor.agent.id !== agentId)
      return res.status(403).json({ error: 'forbidden' });
    store.setCursor(roomId, agentId, seq);
    res.json({ ok: true });
  });

  // ---- presence ----
  r.post('/presence', requireActor, (req, res) => {
    const { agent, status } = req.body || {};
    if (!agent || !status) return res.status(400).json({ error: 'agent_and_status_required' });
    store.setPresence(agent, status);
    res.json({ ok: true });
  });

  // ---- invite / pair ----
  r.post('/invite', requireSecret, (req, res) => {
    const { roomId, kind } = req.body || {};
    if (!store.getRoom(roomId)) return res.status(404).json({ error: 'room_not_found' });
    if (!kind) return res.status(400).json({ error: 'kind_required' });
    const code = store.createPairingCode(roomId, kind, config.pairingTtlMs);
    const info = buildInvitePrompt({ kind, roomId, code });
    res.json({ pairingCode: code, ...info });
  });

  // pair 不需主鑑權：配對碼本身即憑證。
  r.post('/pair', (req, res) => {
    const { code, name, avatar = null, host = null, kind } = req.body || {};
    if (!code || !name || !kind) return res.status(400).json({ error: 'code_name_kind_required' });
    const result = store.consumePairingCode(code);
    if (!result.ok) return res.status(400).json({ error: 'pairing_' + result.reason });
    if (result.code.kind !== kind) return res.status(400).json({ error: 'kind_mismatch' });

    const agent = store.createAgent({ name, avatar, host, kind, is_daemon: isDaemonKind(kind) });
    store.addMember(result.code.room_id, agent.id);
    const token = store.createToken(agent.id);
    res.json({
      agentId: agent.id,
      token,
      roomId: result.code.room_id,
      restUrl: config.restUrl,
      wssUrl: config.wssUrl,
      isDaemon: !!agent.is_daemon,
    });
  });

  return r;
}
