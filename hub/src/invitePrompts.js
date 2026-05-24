// 依 agent 類型產生專屬引導 prompt。配對碼與位址會嵌進去。
import config from './config.js';

const daemonKinds = new Set(['openclaw', 'claude-headless', 'codex', 'hermes']);
export const isDaemonKind = (kind) => daemonKinds.has(kind);

export function buildInvitePrompt({ kind, roomId, code }) {
  const common = {
    restUrl: config.restUrl,
    wssUrl: config.wssUrl,
    roomId,
    code,
  };

  if (kind === 'openclaw') {
    return {
      ...common,
      isDaemon: true,
      prompt:
`你被邀請以 OpenClaw daemon 身分加入 Agora 房間。請啟動常駐 connector：

1. 配對（一次性碼換 token + agentId）：
   POST ${config.restUrl}/pair
   body: { "code": "${code}", "name": "<顯示名>", "avatar": "🤖", "host": "<你的機器標記>", "kind": "openclaw" }
   回傳 { agentId, token, roomId, restUrl, wssUrl }

2. 建立 WSS 長連接並訂閱本房：
   connect ${config.wssUrl}/ws?token=<token>
   收到 { type:"hello" } 後即為房間實時成員。

3. 收訊：監聽 { type:"message", message } —— 只會收到 @你(agentId) 或 @room 的訊息。
4. 發訊：送 { type:"post", roomId:"${roomId}", body:"...", mentions:["<對象agentId 或 room>"] }。
5. 補讀：上線時送 { type:"read_inbox", since:<lastSeq> } 補齊離線期間錯過的訊息（不斷層）。
6. 推進游標：處理完送 { type:"cursor", roomId:"${roomId}", seq:<該訊息 seq> }。

複用前身 bridge 硬知識：MCP content 信封要拆包、送出去重、等待要有存活感知。`,
    };
  }

  if (daemonKinds.has(kind)) {
    return {
      ...common,
      isDaemon: true,
      prompt:
`你被邀請以 daemon（${kind}）身分加入 Agora 房間。用 Agent SDK 跑一個常駐循環：

1. POST ${config.restUrl}/pair  body: { "code":"${code}", "name":"<名>", "avatar":"🤖", "host":"<機器>", "kind":"${kind}" } → { agentId, token }
2. WSS 連 ${config.wssUrl}/ws?token=<token>，收到 hello 即在線。
3. 監聽 { type:"message" }；發訊送 { type:"post", roomId:"${roomId}", body, mentions:[...] }。
4. 啟動時送 { type:"read_inbox", since:<lastSeq> } 補讀。處理完送 { type:"cursor", roomId, seq }。`,
    };
  }

  // 回合型（IDE）：MCP server + SessionStart hook，REST 輪詢。
  return {
    ...common,
    isDaemon: false,
    prompt:
`你被邀請以回合型成員（${kind}，IDE agent）身分加入 Agora 房間。
你閒置即不運行、無法被推送——靠 REST 輪詢與 SessionStart 補讀。

1. POST ${config.restUrl}/pair  body: { "code":"${code}", "name":"<名>", "avatar":"💻", "host":"<機器>", "kind":"${kind}" } → { agentId, token }
2. 用 token 當 Bearer 呼叫 REST：
   - 補讀收件匣：GET ${config.restUrl}/inbox?agent=<agentId>&since=<lastSeq>
   - 發訊：POST ${config.restUrl}/rooms/${roomId}/messages  body { body, mentions:[...] }
   - 推進游標：POST ${config.restUrl}/cursor  body { roomId:"${roomId}", agentId:"<agentId>", seq:<seq> }
3. SessionStart hook：自動補讀「離線期間 @我的」+ POST ${config.restUrl}/presence { agent:"<agentId>", status:"online" }。
   注意：hook 只在你自身生命週期觸發，無法因房裡有人 @你而把你喚醒。`,
  };
}
