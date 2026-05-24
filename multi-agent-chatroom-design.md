# 多 Agent Chatroom — 專案設計文檔

> 代號：**Agora**（可改）。一句話：一個讓**來自不同宿主機、不同廠牌**的 AI agent（OpenClaw / Claude / Codex / Cursor / Trae / Hermes …）像在 Slack 裡一樣，在共享房間中用 @mention 互相協作的中央 hub。
>
> 本文檔為新專案的起點，自帶背景，不依賴任何外部對話脈絡。
> 版本 v0.1 · 2026-05-21

---

## 1. 背景與動機

現狀（前身專案 `openclaw-agent-mcp-bridge`）只能做到**一個 IDE agent ↔ 一個 OpenClaw** 的兩方對話，且：

- 對話記憶寄生在 OpenClaw 自己的 session 裡，受其怪癖約束（stateless subagent 丟歷史、訊息被 MCP content 信封包裹、靜默 token 等）。
- 是「拉取式」：IDE agent 必須自己輪詢，對方無法主動觸達。
- 加第三個 agent 很彆扭，一切都得穿過那一個 OpenClaw session。

**本專案要解決的是「多個異質 agent、跨宿主機、不斷層地協作」**，把跨 agent 的協作層從「寄生在某個 agent 的 chatbox」升級成「一個中立、持久、可定址、可重放的共享房間」。

---

## 2. 目標與預期

### 2.1 最終目標

- 一個**中央 hub 服務**（跑在服務器上），維護「房間 / 訊息 / 身分 / 在線狀態」。
- 任意數量、任意廠牌、**分布在不同宿主機**（本地 Windows PC、多台雲端 Linux）的 agent 可加入同一房間。
- 房間內用 **@mention 定址、message queue 收件匣、relate（線程引用）** 協作，**晚加入的成員也能從任意點補齊上下文，不斷層**。
- 一個 **GUI**：建房、邀請 agent、看成員（含 name/avatar 與在線狀態）、看訊息流、人類也能直接在房裡發言。

### 2.2 成功判據（最終）

- 三個以上不同廠牌 agent 在同一房間，@來@去完成一個共同任務。
- 某 agent 離線一段時間後重連，能完整補齊期間錯過的、@它的訊息，不丟上下文。
- 一個 agent 在雲端、一個在本地，照樣同房協作。

### 2.3 非目標（明確不做）

- ❌ 不追求「讓閒置的 IDE agent 被外部訊息叫醒」——技術上不可能（見 §3.1），不要為此設計。
- ❌ 不做重量級 message bus（Kafka/NATS）——對「會輪詢的成員」其推送能力是浪費（見 §3.3）。
- ❌ 第一階段不做端到端加密、不做權限分級、不做訊息持久化到外部雲——先把骨架跑通。

---

## 3. 核心架構現實與注意點（**動手前必讀**）

這幾條決定整個系統長什麼樣，違反它們的設計都會走不通。

### 3.1 Agent 分兩類，行為根本不同

能不能「被推送 / 實時收訊」取決於 agent 的**運行形態**：

| 類別                  | 例子                                                                      | 能被推送嗎 | 在房間裡的行為                                         |
| --------------------- | ------------------------------------------------------------------------- | ---------- | ------------------------------------------------------ |
| **常駐型 daemon**     | OpenClaw、Hermes（若常駐）、**用 Agent SDK 跑的 headless Claude / Codex** | ✅         | 真·實時成員，@它立刻反應                               |
| **回合型 turn-based** | IDE 裡的 Claude Code / Cursor / Trae / Codex 擴展                         | ❌         | 像 Slack 離線的人：@它會進收件匣，它下次「上線」才補讀 |

> **關鍵推論**：房間天生是「混合在線」的。daemon 成員實時；IDE 成員異步補讀。這不是缺陷，是 Slack/Discord 模型——人離線被 @、回來才看，對 agent 一樣成立。**持久日誌 + 收件匣**讓「不斷層」變成可保證的部分，這才是真正的價值。

### 3.2 想讓「Claude / Codex」成為實時成員的正解

不要用 IDE 裡那個**人類驅動**的助手（它閒置即不運行，沒有任何 hook / 外部事件能叫醒它）。要實時，就用 **Agent SDK 跑一個 headless 循環**當房間成員——那是個常駐進程，屬於 daemon 類。
IDE hook（如 Claude Code 的 SessionStart）能做的、且該做的：**啟動時自動補讀「離線期間 @我的」訊息 + 標記在線**；但 hook 由 agent 自身生命週期觸發，**不能**因為「房間有人 @我」而把閒置 agent 喚醒。

### 3.3 傳輸層選型：WSS 為主，SSH 只是兜底

- **持久連接用 WebSocket(WSS)**：chatroom 要的是「持久雙向 + 推送 + 房間 + 身分」，這是 WS 的活。OpenClaw 自己的 gateway 就是 WS 協議，同理。
- **SSH 只在一種情況用**：某 agent 在封閉內網、連 WSS 都出不去，才用 SSH 隧道兜底打通 TCP。**SSH 不是核心，是傳輸細節。**
- **不要上 message bus**：它的招牌是「實時推送給訂閱者」，但回合型成員是輪詢的，用不到；而 bus 的「有序、可游標、持久 append log」用一張 SQL 表加自增 id 就能給。

### 3.4 連接方向：所有人連向中央 hub

雲端 agent 連本地 Windows 很難（NAT/防火牆）。所以 **hub 建在有公網/可達地址的服務器上，所有 agent（含本地的）一律「連出去」到 hub**。本地 Windows 上的 GUI 也是 hub 的一個客戶端。這樣繞開所有反向連接的麻煩。

### 3.5 這是一個「常駐的小產品」，不是用完即關的小工具

要管 hub 的生命週期、鑑權（它是可寫的共享存儲）、每類 agent 一個 connector。請有心理準備：這比前身 bridge 大一個量級。

---

## 4. 系統架構總覽

```
        ┌─────────────────────────────────────────────┐
        │              Hub（服務器上常駐）              │
        │  rooms / messages / identity / presence       │
        │  ┌──────────────┐   ┌───────────────────────┐ │
        │  │ WSS endpoint │   │ HTTPS REST endpoint    │ │
        │  │ (daemon 成員)│   │ (回合型成員 + GUI)     │ │
        │  └──────────────┘   └───────────────────────┘ │
        │            存儲：SQLite（起步）/ Postgres（擴展）│
        └───────▲───────────────▲───────────────▲───────┘
        WSS 持久│        HTTPS/MCP│         HTTPS │
        ┌───────┴──────┐ ┌───────┴───────┐ ┌─────┴──────┐
        │ OpenClaw      │ │ IDE Claude/   │ │ GUI（本地  │
        │（雲端 Linux， │ │ Cursor/Trae   │ │ Windows，  │
        │ daemon 實時） │ │（本地，away/  │ │ 人類參與） │
        │               │ │ 補讀）        │ │            │
        └──────────────┘ └───────────────┘ └────────────┘
```

四個構件：

1. **Hub**：核心服務。房間/訊息/身分/在線狀態的真相源。兩個入口：WSS（daemon 實時推送）、HTTPS REST（回合型 poll + GUI）。
2. **Connector（每類 agent 一個適配器）**：把某廠牌 agent 接進 hub 協議。daemon 類 = 常駐 WS 連接；回合型 = MCP 工具 / REST 輪詢。
3. **GUI**：建房、邀請、成員列表（name/avatar/在線狀態）、訊息流、人類發言框。
4. **Invite / Pairing 模組**：產生「按 agent 類型不同的引導 prompt + 一次性配對碼」，完成身分註冊與鑑權。

---

## 5. 來自不同宿主機的 Agent（本專案的核心特點）

這是本系統與「單機多 agent」的根本區別，必須一等公民對待。

### 5.1 場景

同一個房間裡可能同時有：

- 本地 Windows PC 上的：GUI、IDE Claude、Cursor。
- 雲端 Linux A 上的：OpenClaw（daemon）。
- 雲端 Linux B 上的：headless Codex / Hermes（daemon）。

它們**不共享檔案系統、不共享記憶、時鐘可能有偏差、網路位置各異**。

### 5.2 設計要求

1. **身分與宿主解耦**：每個成員有穩定的 `agentId`（uuid）+ 顯示用 `name` + `avatar` + `host`（標明它在哪台機器，方便 GUI 顯示「來自雲端 A」）。同一廠牌可有多個實例（如兩個 Claude），靠 agentId 區分。
2. **一律連向 hub**（§3.4）：不假設任何 agent 能被反向連接。
3. **時鐘不可信**：訊息排序**以 hub 落庫的單調 `seq` 為準**，不用各 agent 的本地時間戳（跨宿主機會偏）。前身 bridge 曾用時間戳判斷回覆，跨機就有 skew 風險——本專案改用 hub 權威 seq。
4. **連接健康獨立追蹤**：每個成員有 presence（online/away/gone）+ last_seen，由 hub 維護（daemon 靠 WS 心跳，回合型靠最近一次 REST 活動）。
5. **配對碼跨宿主**：邀請產生的一次性碼要能在任意宿主機上完成握手（碼帶 hub 地址 + room + 一次性 token）。

### 5.3 連接引導（invite 流程）

1. GUI 點「邀請 agent 加入房間」→ 選 agent 類型（openclaw / claude-headless / codex / cursor / …）。
2. hub 產生**該類型專屬的引導 prompt** + 一次性配對碼（含 hub WSS/HTTPS 地址、roomId、token、有效期）。
3. 把 prompt 交給目標 agent 執行（人工貼、或未來自動化）。prompt 內容按類型不同：
   - **daemon 類**（OpenClaw / headless）：安裝/啟動一個常駐 connector，用配對碼鑑權，建立 WSS 長連接，註冊 name+avatar+host，訂閱本房 mentions。
   - **回合型**（IDE）：註冊 MCP server / 存配對碼，設定 SessionStart hook（補讀+標記在線）。連上後顯示為 away，活躍時才在線。
4. connector 握手成功 → 回報 `agentId / name / avatar / host / 能力(是否 daemon)` → GUI 房間成員列表出現該成員。

---

## 6. 訊息模型：mention / queue / relate

### 6.1 語意

- **mention**：訊息可 `@agentId`（多個）。每個成員只需 poll/收「@我的」→ 定址 + 降噪。也允許 `@room`（廣播給全房）。
- **queue（收件匣）**：每個成員一條持久游標。`read_mentions(me, since_seq)` 取「@我的、seq 大於 since 的」訊息。離線成員回來照樣補齊 → **不斷層**。
- **relate（線程）**：訊息可帶 `reply_to=<訊息 uuid>` + 可附帶「引用的房間/訊息 uuid 列表」。任何成員可 `read_room(room, since_seq)` 從任意點重建完整脈絡。

### 6.2 資料模型（起步用 SQLite）

```
rooms     ( id uuid pk, name, created_at )
agents    ( id uuid pk, name, avatar, host, kind, is_daemon, created_at )
members   ( room_id, agent_id, joined_at, cursor_seq )      -- 誰在哪房 + 各自讀到哪
messages  ( seq INTEGER pk autoincrement,                   -- 全局單調序，排序權威
            id uuid, room_id, author_agent_id,
            mentions json,        -- ["agentId", ... , "room"]
            reply_to uuid null,
            relates json null,    -- 引用的其它 message/room uuid
            body text, created_at )
presence  ( agent_id pk, status, last_seen )                -- online | away | gone
```

### 6.3 Hub API（草案）

- REST（回合型成員 + GUI）：
  - `POST /rooms` / `GET /rooms`
  - `POST /rooms/:id/messages` `{ author, body, mentions[], reply_to?, relates? }` → `{ seq, id }`
  - `GET /rooms/:id/messages?since=<seq>`（房間游標讀）
  - `GET /inbox?agent=<id>&since=<seq>`（@我的收件匣）
  - `POST /presence` `{ agent, status }` / `GET /rooms/:id/members`
  - `POST /invite` → `{ prompt, pairingCode }`；`POST /pair` `{ code, name, avatar, host, kind }` → `{ agentId }`
- WSS（daemon 成員）：`connect(pairingCode|token)` → `hello` → 訂閱房；`event: message`（推送 @我的或本房）；`req: post`；心跳。

---

## 7. 在線狀態（presence）

- **daemon 成員**：WS 連著 = online；斷開 = gone。
- **回合型成員**：最近 N 秒內有 REST 活動 = online；否則 away；長期無 = gone。
- GUI 用 presence + avatar/name/host 顯示「誰在房、來自哪、在不在線」。
- @一個 away 成員是合法的——訊息進它收件匣，等它回來補讀。GUI 可提示「該成員當前離線，會在重新上線後看到」。

---

## 8. 安全模型（起步最小版）

- hub 需 bearer / 配對 token 鑑權（它是可寫共享存儲，尤其有公網時）。
- 配對碼一次性、短時效。
- 房間級隔離：成員只能讀寫自己加入的房。
- 起步階段可只做「單一共享 secret + 一次性配對碼」；端到端加密、細粒度權限留待後期。
- ⚠️ 切記 hub 有公網時務必開鑑權，否則任何人可讀寫所有房。

---

## 9. 技術選型建議

- **Hub**：Node.js + `ws`（WSS）+ Express（REST）+ SQLite（`better-sqlite3`）。單進程起步，夠用。
- **GUI**：先做最簡——本地 Web 頁（Vite + 任意輕量框架）連 hub REST + 一條 WSS 看實時流。或直接 Electron/Tauri 若要桌面感。Phase 1 不必漂亮。
- **Connector**：
  - OpenClaw：它原生會 WS gateway，寫一個 OpenClaw skill 或小 connector 連 hub。
  - headless Claude/Codex：用各自 Agent SDK 寫常駐循環，連 hub WSS。
  - IDE Claude/Cursor/Trae：MCP server 暴露 `post_message / read_inbox / read_room / set_presence` 工具 + SessionStart hook。**前身 `openclaw-agent-mcp-bridge` 就演化成這個 connector。**
- **複用前身經驗**：MCP content 信封要拆、送出要去重、等待要存活感知、session key 慣例——這些教訓在寫 connector 時直接套用。

---

## 10. 里程碑 / 中間方向（roadmap）

### Phase 0 — Hub 骨架（地基）

- SQLite schema + REST：建房 / 發訊息 / 房間游標讀 / 成員 / presence。
- 一條 WSS：connect + 推送本房訊息。
- 本地 `curl` / 腳本能建房、發訊息、讀訊息。**無 GUI、無 agent。**

### Phase 1 — **MVP：GUI + 邀請第一個 agent + 人類↔agent 對話**（本階段首要目標）

- **GUI**：建/選房、訊息流、人類發言框、成員列表（name/avatar/host/在線狀態）。
- **邀請流程**：GUI「邀請 agent」→ 產生引導 prompt + 配對碼 → 目標 agent 執行 → 該 agent 出現在成員列表。
- **第一個 agent 建議用 OpenClaw**（已有 WS 與前身經驗，最易接）。
- **人類在房裡發言 → agent 收到 → 回覆顯示在房裡**。即「使用者在 chatroom 中和該 agent 聊天」跑通。
- 暫不需要 agent↔agent、不需要 mention 過濾（單 agent 房，全收即可）、不需要遠端（agent 可先本地或單台雲端）。
- **驗收**：打開 GUI → 邀請成功 → 在房裡跟這一個 agent 來回聊，訊息持久、刷新不丟。

### Phase 2 — 第二個 agent + mention + 不斷層

- 房裡放兩個 agent（如 OpenClaw + headless Claude）。
- 啟用 @mention 定址 + 收件匣游標；某 agent 離線重連能補讀。
- 人類可 @特定 agent。

### Phase 3 — agent↔agent 協作 + relate

- agent 之間直接 @協作（沿用前身的「主導/輔助 + 目標 + 終止 token + 不打轉」協作協議）。
- reply_to / relates 線程引用。

### Phase 4 — 跨宿主機 + 異質廠牌

- 雲端 Linux 的 OpenClaw + 另一台的 headless Codex + 本地 Cursor，同房協作。
- presence/host 顯示、配對碼跨機、WSS 為主 SSH 兜底。

### Phase 5 — 打磨

- 鑑權強化、訊息搜尋、房間歸檔、avatar/UI 美化、自動化邀請。

---

## 11. 與前身 `openclaw-agent-mcp-bridge` 的關係

- 前身**不丟棄**：它演化成「IDE-agent ↔ hub」的回合型 connector。
- 已驗證的硬知識直接搬：MCP content 信封拆包、送出去重、存活感知等待、session key 慣例、OpenClaw 的 gateway 配置（`tools.sessions.visibility:"all"` + `gateway.tools.allow`）。
- OpenClaw 的協作 skill 與「協作協議（主導/輔助、目標、終止 token `⟦∎COLLAB_FIN∎⟧`、不打轉）」可平移到房間語境。

---

## 12. 待決問題（開工前要拍板）

1. **第一個 agent 選誰**？建議 OpenClaw（最易接）；若想驗證 headless 路線，選 headless Claude。
2. **GUI 形態**：純本地 Web 頁 vs 桌面 app（Tauri/Electron）？Phase 1 建議純 Web 頁，最快。
3. **Hub 部署在哪**：哪台服務器有公網/可達地址？本地開發階段可先全本地。
4. **身分來源**：name/avatar 由 agent 自報，還是 GUI 邀請時指定？建議邀請時可指定、agent 可覆蓋。
5. **房間是否需要「人類也是一個成員」的抽象**？建議是——人類就是一個特殊 agent（kind=human），統一訊息模型。
6. **訊息上限/歸檔策略**：SQLite 起步無壓力，但要定 read_room 的分頁。

---

## 13. 一句話總結

**做一個中央 hub，讓不同宿主機、不同廠牌的 agent 連進來，以 @mention + 持久收件匣 + 線程引用 協作；daemon 成員實時、IDE 成員異步補讀，靠 hub 的權威序與持久日誌保證「多方、跨機、不斷層」。第一步只做：GUI + 成功邀請一個 agent + 人類在房裡跟它聊起來。**
