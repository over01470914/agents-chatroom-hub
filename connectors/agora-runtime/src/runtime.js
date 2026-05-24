// AgoraRuntime：daemon agent 的執行期迴圈。
// 設計：WSS 推送「只當喚醒訊號」，真正的資料一律走 inbox(since=cursor) 有序補讀 →
//       保證有序、無斷層、可重放；以 hub 的 cursor 為權威 → 重啟不重複處理。
import { assembleContext } from './assembler.js';

export class AgoraRuntime {
  constructor({ hub, backend, opts = {} }) {
    this.hub = hub;
    this.backend = backend;
    this.opts = opts;
    this.lastSeq = 0;
    this.handled = new Set();
    this.polling = false;
    this.pollQueued = false;
    this.pollTimer = null;
    this.log = opts.log || ((...a) => console.error('[runtime]', ...a));
  }

  async start({ join } = {}) {
    const hub = this.hub;
    // 1) 取得身分：優先用既有憑證重連（穩定身分），否則用配對碼加入
    const resumed = await hub.resume();
    if (resumed) this.log(`以既有身分重連：agentId=${hub.agentId} room=${hub.roomId}`);
    else {
      if (!join || !join.code) throw new Error('無既有憑證且未提供加入金鑰（--code）。');
      const r = await hub.joinWithCode(join);
      this.log(`首次加入：agentId=${r.agentId} room=${r.roomId} isDaemon=${r.isDaemon}`);
    }

    // 2) 游標以 hub 為準（重啟不重複處理）
    this.lastSeq = await hub.myCursor();
    this.log(`起始游標 cursor_seq=${this.lastSeq}`);

    // 3) 上線 + WSS 推送當喚醒
    await hub.setPresence('online').catch(() => {});
    hub.onPush = () => this.pollNow();
    hub.connectWs();

    // 4) 先補讀一次離線期間漏的，再進入輪詢
    await this.poll();
    const interval = this.opts.pollMs ?? 4000;
    this.pollTimer = setInterval(() => this.poll(), interval);
    this.log(`已就緒，輪詢間隔 ${interval}ms`);
  }

  pollNow() { if (this.polling) { this.pollQueued = true; return; } this.poll(); }

  async poll() {
    if (this.polling) { this.pollQueued = true; return; }
    this.polling = true;
    try {
      const rows = await this.hub.inbox(this.lastSeq);
      rows.sort((a, b) => a.seq - b.seq);
      for (const m of rows) {
        if (this.handled.has(m.id)) { this.lastSeq = Math.max(this.lastSeq, m.seq); continue; }
        if (m.author_id === this.hub.agentId) { this.lastSeq = Math.max(this.lastSeq, m.seq); continue; }
        await this.handle(m);
        this.handled.add(m.id);
        this.lastSeq = Math.max(this.lastSeq, m.seq);
        await this.hub.setCursor(this.lastSeq).catch(() => {}); // 處理成功才推進游標
      }
    } catch (e) {
      this.log('poll 失敗：', e.message);
    } finally {
      this.polling = false;
      if (this.pollQueued) { this.pollQueued = false; setImmediate(() => this.poll()); }
    }
  }

  async handle(msg) {
    const hub = this.hub;
    this.log(`處理 #${msg.seq} 來自 ${msg.author_name}: ${String(msg.body).slice(0, 60)}`);

    // 組裝可見脈絡（有界圖閉包）
    const context = await assembleContext(hub, msg.id, {
      maxMessages: this.opts.maxMessages, tokenBudget: this.opts.tokenBudget,
    });
    const members = (await hub.members()).map((m) => ({ id: m.id, name: m.name, kind: m.kind, status: m.status }));
    const trigger = {
      id: msg.id, seq: msg.seq, from: msg.author_name, fromId: msg.author_id,
      kind: msg.author_kind, body: msg.body, mentions: msg.mentions || [],
    };

    let out;
    try {
      out = await this.backend.respond({ self: { agentId: hub.agentId, name: hub.name }, trigger, context, members, roomId: hub.roomId });
    } catch (e) {
      this.log('backend 失敗：', e.message);
      return; // 不推進前可重試；此處選擇略過該則避免卡死，錯誤已記錄
    }
    if (!out || !out.text) { this.log('backend 無輸出，略過回覆'); return; }

    // 定址：對 agent 觸發者回他；對人類觸發者廣播回房。可併入 backend 指定的 agentId。
    const memberIds = new Set(members.map((m) => m.id));
    const norm = (t) => (/^(everyone|all|room)$/i.test(t) ? 'room' : t);
    const primary = trigger.kind === 'agent' ? trigger.fromId : 'room';
    const extra = (out.to || []).map(norm).filter((t) => t === 'room' || memberIds.has(t));
    const mentions = [...new Set([primary, ...extra])];

    // 出處回寫：reply_to=觸發訊息，relates=實際取用脈絡（排除 reply_to 本身）
    const relates = [...new Set((out.relates || []).filter((id) => id && id !== trigger.id))].slice(0, 30);

    const saved = await hub.post({ body: out.text, mentions, replyTo: trigger.id, relates: relates.length ? relates : null });
    this.log(`已回覆 #${saved.seq} → mentions=${JSON.stringify(mentions)} relates=${relates.length}`);
  }

  stop() { if (this.pollTimer) clearInterval(this.pollTimer); }
}
