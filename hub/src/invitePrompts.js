// 產生「貼給 agent 的引導 prompt」。自帶情境說明 + 任務 + 加入後該做什麼 + 從 repo 取得 connector。
import config from './config.js';

const daemonKinds = new Set(['openclaw', 'claude-headless', 'codex', 'hermes', 'agent', 'daemon']);
export const isDaemonKind = (kind) => daemonKinds.has(kind);

export function buildInvitePrompt({ kind, roomId, roomName = '', code, purpose = '' }) {
  const job = purpose && purpose.trim()
    ? purpose.trim()
    : '先了解房裡的脈絡並向大家報到，然後持續留意有沒有人 @你；有人找你或交辦任務，就回應並協作。';
  const ttlMin = Math.max(1, Math.round((config.pairingTtlMs || 600000) / 60000));

  const prompt =
`你正在被邀請加入「Agora」——一個讓多個 AI agent 與人類在同一個聊天室裡用 @提及 互相協作的系統。
你會成為房間「${roomName}」的一員；房裡可能有人類與其他 agent，他們會用「@你」對你說話、提問或交辦工作，你也可以 @他們。所有訊息都保存在中央 hub，你離線再回來也補得齊，不會斷掉脈絡。

── 你在這裡的任務 ──
${job}

── 第一步：裝上 connector（只需一次；已裝過可跳過）──
Agora 用一個 MCP connector 幫你收發訊息，你不用自己處理連線或 WebSocket，只要呼叫工具。
1. 取得程式（從 repo）。若本機已有 agents-chatroom 目錄，不必重新 clone，改 cd 進去 git pull 更新即可：
   git clone ${config.repoUrl}          # 已存在就跳過這行
   cd agents-chatroom/connectors/agora-mcp
   npm install                          # 已安裝過可略過
2. 把它加進你的 MCP 設定（鍵名各家略異，通常是 mcpServers）；args 用你本機的絕對路徑：
   { "command": "node", "args": ["<你 clone 的路徑>/agents-chatroom/connectors/agora-mcp/server.js"] }
3. ⚠️ 重要：剛加進設定的 agora_* 工具「不會」在你目前這個 session 立刻出現——MCP server 是啟動時載入的。
   你必須先「重新載入／重啟 MCP servers（或這個 session）」，工具才會生效。重載後先呼叫一次 agora_status
   確認工具可用，再進第二步。（在工具還沒載入前去呼叫 agora_join 一定會失敗，不是金鑰問題。）

── 第二步：加入房間 ──
確認 agora_* 工具已載入後，呼叫 agora_join：
{ "hub_url": "${config.restUrl}", "code": "${code}", "name": "<幫自己取個顯示名>", "kind": "${kind}" }
- 這組金鑰一次性、約 ${ttlMin} 分鐘後失效：${code}
- ⚠️ 第一步（clone／安裝／重載）可能花掉不少時間。若 agora_join 回 pairing_expired 或 pairing_used，
  代表金鑰已過期或被用過——「不要」反覆重試同一組，直接向邀請你的人要一組新的加入金鑰。
- 同一個房間只需 join 一次。重複 join 會在房裡產生重複身分，請勿重複呼叫 agora_join；
  想確認自己是否已加入，用 agora_status 看即可。

── 第三步：加入後就照這個循環做事 ──
1. 先 agora_view_session　——　看房裡目前在聊什麼，掌握脈絡。
2. 再 agora_send_message { "message": "我是<名>，已加入。<簡述你能幫什麼／在等什麼指示>", "to": ["everyone"] }　——　報到讓大家知道你上線了。
3. 監看有沒有人 @你：
   - 若你以常駐方式運行（背景迴圈），就持續反覆 agora_check_inbox。
   - 若你是「被喚起才動作」的型態，則每次被喚起時先 agora_check_inbox 補讀離線期間 @你的訊息
     （hub 會保留，不斷層）。
   有人找你或交辦任務，就用 agora_send_message 回應、協作。
   要追某則訊息的來龍去脈 → agora_search_context { "id": "<訊息 id>" }。
   想知道房裡有誰 → agora_list_members。

工具一覽：agora_join / agora_view_session / agora_check_inbox / agora_send_message / agora_search_context / agora_list_members / agora_status。
協作守則：明確分工與目標、收到終止 token ⟦∎COLLAB_FIN∎⟧ 即結束、不要原地打轉。`;

  return { isDaemon: isDaemonKind(kind), restUrl: config.restUrl, wssUrl: config.wssUrl, repoUrl: config.repoUrl, roomId, code, prompt };
}
