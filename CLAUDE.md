# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 專案狀態

**目前是設計階段，尚無程式碼。** 倉庫只有一份設計文檔 `multi-agent-chatroom-design.md`（代號 **Agora**，v0.1）。動手寫任何程式碼前務必先讀它——它自帶完整背景，不依賴外部脈絡。尚無 git、無 build/lint/test、無 package.json。

## 這個專案在做什麼

一個**中央 hub 服務**，讓來自**不同宿主機、不同廠牌**的 AI agent（OpenClaw / headless Claude / Codex / Cursor / Trae …）在共享房間中用 `@mention` 協作，像 Slack 一樣。核心價值是「多方、跨機、**不斷層**」——晚加入或離線重連的成員都能從任意點補齊上下文。

前身專案 `openclaw-agent-mcp-bridge` 只能做「一個 IDE agent ↔ 一個 OpenClaw」兩方對話；本專案把協作層從「寄生在某 agent 的 chatbox」升級成中立、持久、可定址、可重放的房間。

## 不可違反的架構約束（動手前必讀，見設計文檔 §3、§5）

這幾條決定整個系統長相，違反它們的設計都走不通：

1. **Agent 分兩類，行為根本不同**：
   - **daemon 常駐型**（OpenClaw、headless Claude/Codex 用 Agent SDK 跑的循環）= 真實時成員，可被 WSS 推送。
   - **回合型 turn-based**（IDE 裡的 Claude Code / Cursor / Trae）= 閒置即不運行，**無法被外部訊息喚醒**。它們像離線的人：@它進收件匣，下次上線才補讀。不要為「叫醒閒置 IDE agent」做任何設計（明確非目標）。

2. **所有人連向中央 hub**：雲端連本地 Windows 很難（NAT/防火牆），所以 hub 建在有公網/可達地址的服務器上，**所有 agent（含本地）一律連出去**。GUI 也是 hub 的客戶端。不假設任何 agent 可被反向連接。

3. **排序以 hub 的單調 `seq` 為準，不信任何本地時間戳**：跨宿主機時鐘會偏（clock skew）。前身 bridge 用時間戳判斷回覆，跨機就出問題——本專案改用 hub 落庫的自增 `seq` 作為排序與游標權威。

4. **傳輸層：WSS 為主，SSH 只兜底**：持久雙向推送用 WebSocket(WSS)；只有 agent 在封閉內網連 WSS 都出不去時，才用 SSH 隧道。**不要上 message bus（Kafka/NATS）**——回合型成員是輪詢的用不到推送，而「有序、可游標、持久 append log」用一張 SQL 表加自增 id 就夠。

5. **身分與宿主解耦**：每成員有穩定 `agentId`(uuid) + `name` + `avatar` + `host`。同廠牌可多實例，靠 agentId 區分。

## 四個構件

1. **Hub**：核心服務、真相源。兩個入口——WSS（daemon 實時推送）、HTTPS REST（回合型 poll + GUI）。
2. **Connector**：每類 agent 一個適配器。daemon 類 = 常駐 WS 連接；回合型 = MCP 工具 / REST 輪詢（前身 `openclaw-agent-mcp-bridge` 演化成這個 connector）。
3. **GUI**：建房、邀請、成員列表（name/avatar/host/在線狀態）、訊息流、人類發言框。人類視為特殊 agent（kind=human），統一訊息模型。
4. **Invite / Pairing**：依 agent 類型產生專屬引導 prompt + 一次性配對碼（含 hub 地址、roomId、token、有效期）。

## 訊息模型（設計文檔 §6）

- **mention**：訊息可 `@agentId`（多個）或 `@room`（廣播）。成員只收「@我的」→ 定址 + 降噪。
- **queue 收件匣**：每成員一條持久游標 `cursor_seq`，`read_mentions(me, since_seq)` 補齊離線期間錯過的訊息 → 不斷層。
- **relate 線程**：訊息可帶 `reply_to=<uuid>` + `relates`（引用的 message/room uuid 列表）。

資料模型（起步用 SQLite）：`rooms` / `agents` / `members`(含 cursor_seq) / `messages`(seq 為排序權威主鍵) / `presence`(online|away|gone)。

## 計畫中的技術選型（設計文檔 §9，尚未落地）

- **Hub**：Node.js + `ws`(WSS) + Express(REST) + SQLite(`better-sqlite3`)，單進程起步。
- **GUI**：Phase 1 建議純本地 Web 頁（Vite + 輕量框架），REST + 一條 WSS 看實時流。不必漂亮。
- **Connector**：headless 用各自 Agent SDK 寫常駐循環連 WSS；IDE 用 MCP server 暴露 `post_message / read_inbox / read_room / set_presence` + SessionStart hook。

## Roadmap（當前優先級）

按 Phase 推進，**目前首要目標是 Phase 1 MVP**：GUI + 成功邀請第一個 agent（建議 OpenClaw，最易接）+ 人類在房裡跟它來回聊、訊息持久刷新不丟。Phase 0 是 Hub 骨架（SQLite schema + REST + 一條 WSS，能用 curl 建房發訊息）。Phase 2 起才加第二個 agent、mention 過濾、跨宿主機。詳見設計文檔 §10。

## 複用前身的硬知識（寫 connector 時直接套）

MCP content 信封要拆包、送出要去重、等待要有存活感知、session key 慣例、OpenClaw gateway 配置（`tools.sessions.visibility:"all"` + `gateway.tools.allow`）、協作協議（主導/輔助 + 目標 + 終止 token `⟦∎COLLAB_FIN∎⟧` + 不打轉）。

## 安全（起步最小版）

hub 是可寫共享存儲，**有公網時務必開鑑權**，否則任何人可讀寫所有房。起步只做單一共享 secret + 一次性短時效配對碼 + 房間級隔離（成員只能讀寫自己加入的房）。端到端加密、細粒度權限留待後期。
