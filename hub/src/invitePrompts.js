// 產生「貼給 agent 的引導 prompt」。自帶情境說明 + 任務 + 加入後該做什麼 + 從 repo 取得 connector。
import config from './config.js';

const daemonKinds = new Set(['openclaw', 'claude-headless', 'codex', 'hermes', 'agent', 'daemon']);
export const isDaemonKind = (kind) => daemonKinds.has(kind);

export function buildInvitePrompt({ kind, roomId, roomName = '', code, purpose = '' }) {
  const job = purpose && purpose.trim()
    ? purpose.trim()
    : '先了解房裡的脈絡並向大家報到，然後持續留意有沒有人 @你；有人找你或交辦任務，就回應並協作。';

  const prompt =
`你正在被邀請加入「Agora」——一個讓多個 AI agent 與人類在同一個聊天室裡用 @提及 互相協作的系統。
你會成為房間「${roomName}」的一員；房裡可能有人類與其他 agent，他們會用「@你」對你說話、提問或交辦工作，你也可以 @他們。所有訊息都保存在中央 hub，你離線再回來也補得齊，不會斷掉脈絡。

── 你在這裡的任務 ──
${job}

── 第一步：裝上 connector（只需一次）──
Agora 用一個 MCP connector 幫你收發訊息，你不用自己處理連線或 WebSocket，只要呼叫工具。
1. 取得程式（從 repo）：
   git clone ${config.repoUrl}
   cd agents-chatroom/connectors/agora-mcp
   npm install
2. 把它加進你的 MCP 設定（鍵名各家略異，通常是 mcpServers）；args 用你剛 clone 下來的本機絕對路徑：
   { "command": "node", "args": ["<你 clone 的路徑>/agents-chatroom/connectors/agora-mcp/server.js"] }

── 第二步：加入房間 ──
呼叫工具 agora_join，參數：
{ "hub_url": "${config.restUrl}", "code": "${code}", "name": "<幫自己取個顯示名>", "kind": "${kind}" }
其中 code 就是這組一次性加入金鑰（會過期）：${code}

── 第三步：加入後就照這個循環做事 ──
1. 先 agora_view_session　——　看房裡目前在聊什麼，掌握脈絡。
2. 再 agora_send_message { "message": "我是<名>，已加入。<簡述你能幫什麼／在等什麼指示>", "to": ["everyone"] }　——　報到讓大家知道你上線了。
3. 之後反覆 agora_check_inbox　——　看有沒有人 @你；有就用 agora_send_message 回應、協作。
   要追某則訊息的來龍去脈 → agora_search_context { "id": "<訊息 id>" }。
   想知道房裡有誰 → agora_list_members。

工具一覽：agora_join / agora_view_session / agora_check_inbox / agora_send_message / agora_search_context / agora_list_members / agora_status。
協作守則：明確分工與目標、收到終止 token ⟦∎COLLAB_FIN∎⟧ 即結束、不要原地打轉。`;

  return { isDaemon: isDaemonKind(kind), restUrl: config.restUrl, wssUrl: config.wssUrl, repoUrl: config.repoUrl, roomId, code, prompt };
}
