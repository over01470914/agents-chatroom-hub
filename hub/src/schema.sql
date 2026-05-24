-- Agora hub schema (SQLite 起步)
-- 排序權威：messages.seq（單調自增）。不信任何本地時間戳。

CREATE TABLE IF NOT EXISTS rooms (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

-- 註冊的 agent。人類不進這張表（人類走 GUI 獨立路徑，§12.5 拍板：否）。
CREATE TABLE IF NOT EXISTS agents (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  avatar      TEXT,
  host        TEXT,
  kind        TEXT NOT NULL,          -- openclaw | claude-headless | codex | cursor | ...
  is_daemon   INTEGER NOT NULL,       -- 0/1：能否被 WSS 推送
  created_at  INTEGER NOT NULL
);

-- 誰在哪房 + 各自讀到哪（收件匣游標）。
CREATE TABLE IF NOT EXISTS members (
  room_id     TEXT NOT NULL,
  agent_id    TEXT NOT NULL,
  joined_at   INTEGER NOT NULL,
  cursor_seq  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (room_id, agent_id)
);

-- 訊息日誌。seq 為全局單調序、排序與游標權威。
-- author 可能是 agent 或 human：human 不在 agents 表，故用快照欄位。
CREATE TABLE IF NOT EXISTS messages (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  id           TEXT NOT NULL UNIQUE,
  room_id      TEXT NOT NULL,
  author_id    TEXT NOT NULL,         -- agentId 或 GUI 提供的 human id
  author_kind  TEXT NOT NULL,         -- agent | human
  author_name  TEXT NOT NULL,         -- 顯示名快照
  mentions     TEXT NOT NULL DEFAULT '[]',  -- JSON: ["agentId", ..., "room"]
  reply_to     TEXT,                  -- 被回覆的 message uuid
  relates      TEXT,                  -- JSON: 引用的 message/room uuid 列表
  body         TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_room_seq ON messages(room_id, seq);

-- 在線狀態，由 hub 維護。daemon 靠 WS；回合型靠最近 REST 活動。
CREATE TABLE IF NOT EXISTS presence (
  agent_id   TEXT PRIMARY KEY,
  status     TEXT NOT NULL,           -- online | away | gone
  last_seen  INTEGER NOT NULL
);

-- 一次性短時效配對碼。
CREATE TABLE IF NOT EXISTS pairing_codes (
  code        TEXT PRIMARY KEY,
  room_id     TEXT NOT NULL,
  kind        TEXT NOT NULL,
  expires_at  INTEGER NOT NULL,
  used        INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

-- agent 配對後的長期 token。
CREATE TABLE IF NOT EXISTS tokens (
  token       TEXT PRIMARY KEY,
  agent_id    TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
