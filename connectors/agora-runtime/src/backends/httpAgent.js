// 通用「session 型 LLM agent」HTTP backend。OpenClaw / Hermes 等只要其 gateway 能接受一個
// 「turn 請求」並回一段文字，就能套這支。內含前身硬知識：MCP content 信封拆包、送出去重、session key 慣例。
//
// 整合縫（唯一需要對接的地方）：endpoint 收到 { sessionKey, input } 後，把 input 灌進該 agent 的 session
// 跑一回合，回 { content } 或 OpenAI/MCP 風格的 content 陣列。transport 預設用 HTTP POST。

function unpackEnvelope(data) {
  // 支援 { content: "..." } / { content: [{type:'text',text}] } / { text } / OpenClaw MCP 信封
  if (data == null) return '';
  if (typeof data === 'string') return data;
  if (typeof data.text === 'string') return data.text;
  const c = data.content ?? data.message ?? data.output;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c.map((p) => (typeof p === 'string' ? p : (p?.text ?? p?.content ?? ''))).join('').trim();
  }
  if (c && typeof c === 'object' && typeof c.text === 'string') return c.text;
  return '';
}

function buildTurn({ self, trigger, context, members }) {
  const ctxLines = context.thread.map((m) => `#${m.seq} ${m.from}（${m.kind}）: ${m.body}`);
  const relLines = context.related.map((m) => `[引用] #${m.seq} ${m.from}: ${m.body}`);
  const parts = [
    `你是聊天室成員「${self.name}」。以下是與這次被提及相關的「可見脈絡」（已降噪，只含與你被 @ 有關的線程與引用）：`,
    ctxLines.join('\n') || '（無前文）',
    relLines.length ? '\n相關引用：\n' + relLines.join('\n') : '',
    context.note ? '\n' + context.note : '',
    `\n現在 ${trigger.from} 對你說：「${trigger.body}」`,
    `\n房間成員：${members.map((m) => `${m.name}(${m.kind})`).join(', ')}。`,
    `請只根據以上可見脈絡回應；若發現缺少必要脈絡，明說你需要哪一段（對方可補 reply_to/relates）。`,
  ];
  return parts.filter(Boolean).join('\n');
}

export function createHttpAgentBackend({ kind, endpoint, sessionKeyPrefix = 'agora:', headers = {}, timeoutMs = 60000 }) {
  if (!endpoint) {
    return {
      kind,
      async respond() {
        throw new Error(
          `${kind} backend 尚未設定 endpoint。請設環境變數（例如 OPENCLAW_GATEWAY_URL / HERMES_URL）指向你的 agent gateway 的 turn 端點，` +
          `該端點收 { sessionKey, input } 回 { content }。詳見 connectors/agora-runtime/README.md 的「接入 OpenClaw / Hermes」。`
        );
      },
    };
  }
  const sent = new Set(); // 送出去重（前身教訓）
  return {
    kind,
    async respond(input) {
      const { roomId, self, trigger } = input;
      const sessionKey = `${sessionKeyPrefix}${roomId}:${self.agentId}`; // session key 慣例：每(房,agent)一條
      const turn = buildTurn(input);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      let data;
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...headers },
          body: JSON.stringify({ sessionKey, input: turn, trigger: trigger.id }),
          signal: ctrl.signal,
        });
        const text = await res.text();
        try { data = text ? JSON.parse(text) : {}; } catch { data = { content: text }; }
        if (!res.ok) throw new Error(data.error || `gateway HTTP ${res.status}`);
      } finally { clearTimeout(timer); }

      const out = unpackEnvelope(data).trim();
      // 送出去重：同一 trigger 的相同輸出只回一次（避免 gateway 重送）
      const dedupeKey = `${trigger.id}:${out}`;
      if (sent.has(dedupeKey) || !out) return null;
      sent.add(dedupeKey);
      return { text: out, to: [trigger.fromId].filter(Boolean), replyTo: trigger.id, relates: [] };
    },
  };
}
