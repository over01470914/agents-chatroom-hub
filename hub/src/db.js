// SQLite 存取層。所有 SQL 集中在這，外部只用語意函式。
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import config from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

const now = () => Date.now();

// ---- rooms ----
export function createRoom(name) {
  const id = randomUUID();
  db.prepare('INSERT INTO rooms (id, name, created_at) VALUES (?,?,?)').run(id, name, now());
  return getRoom(id);
}
export function getRoom(id) {
  return db.prepare('SELECT * FROM rooms WHERE id=?').get(id);
}
export function listRooms() {
  return db.prepare('SELECT * FROM rooms ORDER BY created_at DESC').all();
}

// ---- agents ----
export function createAgent({ name, avatar = null, host = null, kind, is_daemon }) {
  const id = randomUUID();
  db.prepare(
    'INSERT INTO agents (id, name, avatar, host, kind, is_daemon, created_at) VALUES (?,?,?,?,?,?,?)'
  ).run(id, name, avatar, host, kind, is_daemon ? 1 : 0, now());
  setPresence(id, 'away');
  return getAgent(id);
}
export function getAgent(id) {
  return db.prepare('SELECT * FROM agents WHERE id=?').get(id);
}

// ---- members ----
export function addMember(roomId, agentId) {
  db.prepare(
    'INSERT OR IGNORE INTO members (room_id, agent_id, joined_at, cursor_seq) VALUES (?,?,?,0)'
  ).run(roomId, agentId, now());
}
export function listMembers(roomId) {
  return db
    .prepare(
      `SELECT a.id, a.name, a.avatar, a.host, a.kind, a.is_daemon,
              m.joined_at, m.cursor_seq,
              COALESCE(p.status, 'gone') AS status, p.last_seen
         FROM members m
         JOIN agents a ON a.id = m.agent_id
         LEFT JOIN presence p ON p.agent_id = a.id
        WHERE m.room_id = ?
        ORDER BY m.joined_at ASC`
    )
    .all(roomId);
}
export function roomsForAgent(agentId) {
  return db.prepare('SELECT room_id FROM members WHERE agent_id=?').all(agentId).map((r) => r.room_id);
}
export function isMember(roomId, agentId) {
  return !!db.prepare('SELECT 1 FROM members WHERE room_id=? AND agent_id=?').get(roomId, agentId);
}
export function setCursor(roomId, agentId, seq) {
  db.prepare('UPDATE members SET cursor_seq=? WHERE room_id=? AND agent_id=?').run(seq, roomId, agentId);
}

// ---- messages ----
export function postMessage({ roomId, authorId, authorKind, authorName, body, mentions = [], replyTo = null, relates = null }) {
  const id = randomUUID();
  const info = db
    .prepare(
      `INSERT INTO messages (id, room_id, author_id, author_kind, author_name, mentions, reply_to, relates, body, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      id,
      roomId,
      authorId,
      authorKind,
      authorName,
      JSON.stringify(mentions),
      replyTo,
      relates ? JSON.stringify(relates) : null,
      body,
      now()
    );
  return getMessageBySeq(info.lastInsertRowid);
}
function hydrate(row) {
  if (!row) return row;
  return {
    ...row,
    mentions: JSON.parse(row.mentions || '[]'),
    relates: row.relates ? JSON.parse(row.relates) : null,
  };
}
export function getMessageBySeq(seq) {
  return hydrate(db.prepare('SELECT * FROM messages WHERE seq=?').get(seq));
}
export function readRoom(roomId, sinceSeq = 0, limit = 200) {
  return db
    .prepare('SELECT * FROM messages WHERE room_id=? AND seq>? ORDER BY seq ASC LIMIT ?')
    .all(roomId, sinceSeq, limit)
    .map(hydrate);
}
// 收件匣：@我的（或 @room）、seq 大於游標的訊息，跨它加入的所有房。
export function readInbox(agentId, sinceSeq = 0, limit = 200) {
  const rooms = roomsForAgent(agentId);
  if (rooms.length === 0) return [];
  const placeholders = rooms.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT * FROM messages
        WHERE room_id IN (${placeholders}) AND seq > ?
        ORDER BY seq ASC LIMIT ?`
    )
    .all(...rooms, sinceSeq, limit)
    .map(hydrate);
  return rows.filter(
    (m) => m.author_id !== agentId && (m.mentions.includes('room') || m.mentions.includes(agentId))
  );
}

// ---- presence ----
export function setPresence(agentId, status) {
  db.prepare(
    `INSERT INTO presence (agent_id, status, last_seen) VALUES (?,?,?)
     ON CONFLICT(agent_id) DO UPDATE SET status=excluded.status, last_seen=excluded.last_seen`
  ).run(agentId, status, now());
}
export function touchActivity(agentId) {
  setPresence(agentId, 'online');
}
// 把太久沒活動的 online 降為 away（回合型成員用）。daemon 由 WS 斷線直接設 gone。
export function sweepPresence(awayMs) {
  const cutoff = now() - awayMs;
  db.prepare("UPDATE presence SET status='away' WHERE status='online' AND last_seen < ?").run(cutoff);
}

// ---- pairing / tokens ----
export function createPairingCode(roomId, kind, ttlMs) {
  const code = randomUUID().replace(/-/g, '').slice(0, 12);
  db.prepare(
    'INSERT INTO pairing_codes (code, room_id, kind, expires_at, used, created_at) VALUES (?,?,?,?,0,?)'
  ).run(code, roomId, kind, now() + ttlMs, now());
  return code;
}
export function consumePairingCode(code) {
  const row = db.prepare('SELECT * FROM pairing_codes WHERE code=?').get(code);
  if (!row) return { ok: false, reason: 'not_found' };
  if (row.used) return { ok: false, reason: 'used' };
  if (row.expires_at < now()) return { ok: false, reason: 'expired' };
  db.prepare('UPDATE pairing_codes SET used=1 WHERE code=?').run(code);
  return { ok: true, code: row };
}
export function createToken(agentId) {
  const token = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
  db.prepare('INSERT INTO tokens (token, agent_id, created_at) VALUES (?,?,?)').run(token, agentId, now());
  return token;
}
export function agentByToken(token) {
  const row = db.prepare('SELECT agent_id FROM tokens WHERE token=?').get(token);
  return row ? getAgent(row.agent_id) : null;
}

export default db;

// ---- context 查找（search_context_id 用）----
export function getMessageById(id) {
  return hydrate(db.prepare('SELECT * FROM messages WHERE id=?').get(id));
}
// 給一則訊息 id，回傳它本身 + 上溯的 reply_to 祖先 + 直接回覆 + relates 引用它的訊息。
export function getContext(id, limit = 50) {
  const msg = getMessageById(id);
  if (!msg) return null;
  const ancestors = [];
  const seen = new Set([msg.id]);
  let cur = msg;
  while (cur.reply_to && !seen.has(cur.reply_to)) {
    const parent = getMessageById(cur.reply_to);
    if (!parent) break;
    ancestors.unshift(parent); seen.add(parent.id); cur = parent;
  }
  const replies = db
    .prepare('SELECT * FROM messages WHERE room_id=? AND reply_to=? ORDER BY seq ASC LIMIT ?')
    .all(msg.room_id, id, limit).map(hydrate);
  const related = db
    .prepare('SELECT * FROM messages WHERE room_id=? AND relates LIKE ? ORDER BY seq ASC LIMIT ?')
    .all(msg.room_id, `%${id}%`, limit).map(hydrate)
    .filter((m) => Array.isArray(m.relates) && m.relates.includes(id));
  return { message: msg, ancestors, replies, related };
}
