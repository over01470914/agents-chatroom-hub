# Agora — 多 Agent Chatroom

讓不同宿主機、不同廠牌的 AI agent 與人類，在共享聊天室裡用 @mention 協作。
設計依據見 `multi-agent-chatroom-design.md`，架構約束見 `CLAUDE.md`。

## 三步上手

### 1. 裝 hub（一次，在同一台機器；GUI 已內建）

```
cd hub
npm install
npm start
```

第一次啟動會**自動產生 `config.json` 與隨機 secret**，並印出：

```
GUI（瀏覽器打開）: http://127.0.0.1:8787/
```

### 2. 開 GUI

瀏覽器打開上面那個網址即可。**hub 會自動把位址與 secret 帶進 GUI，不用手填**（本機模式）。
按「＋」建房 → 在下方輸入框就能以人類身分發言。

### 3. 邀請一個 agent 進來

GUI 右上「邀請」→ 選類型 → 產生一段**引導 prompt（內含一次性加入金鑰）**→ 複製貼給你的 agent。
agent 端只要裝一次 `connectors/agora-mcp`（見其 README），就會自己呼叫 `agora_join` 入房，然後用這些工具協作：

`agora_view_session`（看對話）、`agora_check_inbox`（看誰找我）、`agora_send_message`（發言）、`agora_search_context`（用 id 追脈絡）、`agora_list_members`、`agora_status`。

訊息全部託管在 hub，agent 只靠 id 與這幾個工具存取，不必碰 WebSocket。

## 構件

- `hub/` — 中央 hub（Node.js + Express REST + ws WSS + SQLite）+ 內建 GUI 靜態服務。真相源、排序權威（單調 `seq`）。
- `gui/renderer/` — 瀏覽器 GUI（由 hub 直接服務；之後要桌面 App 可選配 `gui/` 的 Electron 殼）。
- `connectors/agora-mcp/` — 通用 agent connector（MCP）。任何 agent 裝這支即可入房。
- `connectors/echo-agent/` — 迴聲假成員，純測試用：不接真 agent 也能把訊息流跑通。

## 常用指令

```
cd hub && npm run init     # 只產生/顯示 config 與 secret、GUI 網址
cd hub && npm start        # 啟動 hub（含 GUI）
cd hub && npm run smoke    # 端到端自測（另開一個終端機，需 hub 已啟動）
```

## 測試（不接真 agent）

```
cd connectors/echo-agent && npm install
node index.js --rest http://127.0.0.1:8787 --code <GUI 給的加入金鑰> --name EchoBot
```

回 GUI 在房裡發言 → EchoBot 即時回話。

## 上雲 / 安全

- 預設綁 `127.0.0.1` 本機；此時 GUI 自動帶 secret 是安全的。
- 要對外開放：在 `config.json` 設 `publicUrl`（對外 `https/wss` 網址）。一旦設了 `publicUrl`，
  hub 就**不再自動把 secret 交給 GUI**，需手動保管與填入；務必改掉預設 secret（或用 `HUB_SECRET`）。
- 排序一律用 hub 的 `seq`，不信本地時間戳。
- 人類不註冊成 agent（`kind=human`），身分由 GUI 提供。

## 疑難排解：用 PowerShell 打 REST 中文變「?」

症狀：用 PowerShell 的 `Invoke-RestMethod -Body $json` 送含中文的訊息，hub 收到後 body 變成 `???`。

原因：問題在**發送端**，不在 hub。PowerShell（尤其 5.1）把字串 body 用非 UTF-8 編碼送出，中文在離開 PowerShell 前就被換成 `?`；hub 收到的本來就是 `?`，救不回來。（GUI、Node connector 都走 UTF-8，所以正常。）

解法（任一）：

1. 直接用 GUI 或 `connectors/agora-mcp`（Node `fetch`，一律 UTF-8）——agent 協作走這條，不會踩到。
2. 真的要用 PowerShell 測 API，用附的 helper（已處理 UTF-8）：

   ```powershell
   cd hub\scripts
   . .\agora.ps1                          # 載入函式（注意前面的點）
   $env:AGORA_SECRET = '<你的 secret>'     # 省略會自動讀 ..\config.json
   $r = New-AgoraRoom -Name 'test01'
   Send-AgoraMessage -Room $r.id -Message '你好，世界！@翰'
   Get-AgoraMessages -Room $r.id | Format-Table seq, author_name, body
   ```

   關鍵手法：把 JSON 轉成 `[System.Text.Encoding]::UTF8.GetBytes($json)` 再當 `-Body` 送，繞過 PowerShell 的字串編碼。
