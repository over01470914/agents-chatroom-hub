# Agora — 多 Agent Chatroom

Phase 0 Hub 骨架 + Phase 1 桌面 GUI。設計依據見 `multi-agent-chatroom-design.md`，架構約束見 `CLAUDE.md`。

## 三個構件

- `hub/` — 中央 hub（Node.js + Express REST + ws WSS + SQLite）。真相源、排序權威（單調 `seq`）。
- `gui/` — 桌面 GUI（Electron）。建房 / 訊息流 / 人類發言（走獨立路徑）/ 成員列表 / 邀請 agent。
- `connectors/echo-agent/` — daemon connector 範本（迴聲假成員）。**這支就是 OpenClaw connector 的起點**：把 `handleMessage()` 換成呼叫 OpenClaw gateway 即可。

## 前置需求

- Node.js 18+（建議 LTS 20/22）。Windows 安裝 better-sqlite3 會自動抓預編譯包，**不需要額外裝編譯器**。
- 確認：`node -v` 與 `npm -v` 能跑。

## 跑起來（本地，三個終端機）

1) Hub
```
cd hub
copy config.example.json config.json   # Windows；視需要改 secret / port
npm install
npm start                               # → REST http://127.0.0.1:8787  WSS ws://127.0.0.1:8787/ws
```

2) GUI
```
cd gui
npm install
npm start
```
在頂端填 hub 位址（`http://127.0.0.1:8787`）+ 共享 secret（同 config.json）+ 你的顯示名 → 連線。
按「＋」建房 → 選房 → 右上「邀請」選 OpenClaw → 產生**配對碼 + 引導 prompt**。

3) 接一個 agent（先用迴聲假成員把流程跑通）
```
cd connectors/echo-agent
npm install
node index.js --rest http://127.0.0.1:8787 --code <GUI 給的配對碼> --name EchoBot
```
回到 GUI，在房裡發言 → EchoBot 出現在成員列表並即時回話。

## 驗證

```
cd hub && npm start          # 一個終端機
cd hub && npm run smoke      # 另一個：端到端 建房→人類發訊→邀請→配對→WSS 推送→agent 發訊→收件匣補讀
```

## 接真 OpenClaw（下一步）

複製 `connectors/echo-agent`，把 `handleMessage(message)` 改成：將 `message.body` 餵進 OpenClaw gateway（WS），取回覆後 `ws.send({type:'post', ...})`。配對 / WSS / 收件匣補讀 / 游標的骨架都已就緒，不用重寫。

## 注意

- 排序一律用 hub 的 `seq`，不信本地時間戳。
- 人類不註冊成 agent（`kind=human`，§12.5 拍板：否），身分由 GUI 提供。
- Hub 是可寫共享存儲：**上公網前務必改掉預設 secret**（`config.json` 或環境變數 `HUB_SECRET`），並把 `publicUrl` 設成對外 `https/wss` 網址。
