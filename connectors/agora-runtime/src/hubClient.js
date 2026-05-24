// Hub 客戶端：REST + WSS。封裝 daemon agent 需要的全部 hub 互動。
// 不碰 better-sqlite3，純 fetch + ws，沙盒與 Windows 皆可跑。
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';

export class HubClient {
  constructor({ restUrl = 'http://127.0.0.1:8787', statePath = null } = {}) {
    this.restUrl = restUrl.replace(/\/$/, '');
    this.wssUrl = null;
    this.token = null;
    this.agentId = null;
    this.roomId = null;
    this.name = null;
    this.statePath = statePath;
    this.ws = null;
    this.connected = false;
    this.reconnectTimer = null;
    this.onPush = null; // (message) => void
  }

  async api(p, method = 'GET', body) {
    const headers = { 'Content-Type': 'application/json' };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    const res = await fetch(this.restUrl + p, {
      method, headers, body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    if (!res.ok) { const e = new Error(data.error || `HTTP ${res.status} on ${p}`); e.status = res.status; throw e; }
    return data;
  }

  // ---- 身分持久：穩定 daemon 身分，重啟不換 agentId（不斷層的前提）----
  loadState() {
    if (!this.statePath || !fs.existsSync(this.statePath)) return null;
    try { return JSON.parse(fs.readFileSync(this.statePath, 'utf8')); } catch { return null; }
  }
  saveState() {
    if (!this.statePath) return;
    try {
      fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
      fs.writeFileSync(this.statePath, JSON.stringify({
        restUrl: this.restUrl, roomId: this.roomId, agentId: this.agentId, token: this.token, name: this.name,
      }, null, 2));
    } catch { /* best effort */ }
  }

  // 用既有憑證重連（不重新 pair）；驗證 token 仍有效。回傳是否成功。
  async resume() {
    const s = this.loadState();
    if (!s || !s.token || !s.roomId || !s.agentId) return false;
    this.restUrl = s.restUrl || this.restUrl;
    this.token = s.token; this.roomId = s.roomId; this.agentId = s.agentId; this.name = s.name;
    try {
      // token 有效性 + 取得 wss 位址：打一個需鑑權的端點
      await this.api(`/rooms/${this.roomId}/members`);
      this.wssUrl = this.restUrl.replace(/^http/, 'ws');
      return true;
    } catch { this.token = null; return false; }
  }

  // 首次加入：用一次性配對碼換 token，落地憑證。
  async joinWithCode({ hubUrl, code, name, kind = 'agent', avatar = '🤖', host = 'agent' }) {
    if (hubUrl) this.restUrl = hubUrl.replace(/\/$/, '');
    const r = await this.api('/pair', 'POST', { code, name, kind, avatar, host });
    this.token = r.token; this.agentId = r.agentId; this.roomId = r.roomId; this.name = name;
    this.wssUrl = r.wssUrl || this.restUrl.replace(/^http/, 'ws');
    this.saveState();
    return r;
  }

  connectWs() {
    if (!this.token || !this.wssUrl) return;
    const ws = new WebSocket(`${this.wssUrl}/ws?token=${this.token}`);
    this.ws = ws;
    ws.on('message', (raw) => {
      let ev; try { ev = JSON.parse(raw.toString()); } catch { return; }
      if (ev.type === 'hello') this.connected = true;
      else if (ev.type === 'message' && this.onPush) this.onPush(ev.message);
    });
    ws.on('close', () => { this.connected = false; this.scheduleReconnect(); });
    ws.on('error', () => {});
  }
  scheduleReconnect() {
    if (this.reconnectTimer || !this.token) return;
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.connectWs(); }, 3000);
  }

  // ---- 語意操作 ----
  async members() { return this.api(`/rooms/${this.roomId}/members`); }
  async myCursor() {
    const me = (await this.members()).find((m) => m.id === this.agentId);
    return me ? Number(me.cursor_seq || 0) : 0;
  }
  async inbox(sinceSeq = 0) { return this.api(`/inbox?agent=${this.agentId}&since=${sinceSeq}`); }
  async viewRoom(sinceSeq = 0) { return this.api(`/rooms/${this.roomId}/messages?since=${sinceSeq}`); }
  async context(id) { return this.api(`/context/${id}`); }
  async setCursor(seq) { return this.api('/cursor', 'POST', { roomId: this.roomId, agentId: this.agentId, seq }); }
  async setPresence(status) { return this.api('/presence', 'POST', { agent: this.agentId, status }); }
  async post({ body, mentions = ['room'], replyTo = null, relates = null }) {
    return this.api(`/rooms/${this.roomId}/messages`, 'POST', { body, mentions, replyTo, relates });
  }
}
