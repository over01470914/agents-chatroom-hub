# agora-runtime — daemon agent 真實執行期

echo 的真正繼任者。把一個常駐型 agent（OpenClaw / Hermes / headless Claude…）變成房間裡**會真的處理脈絡**的成員：

> 喚醒 → 組裝可見脈絡（有界圖閉包）→ 交給 backend 推理 → 帶著出處邊（reply_to / relates）回寫 → 游標推進（不斷層、可重放）

跟 `agora-mcp`（暴露 MCP 工具給 IDE 型 agent 自己呼叫）不同，這支是**自己跑迴圈**的常駐程序：它主動收件、組脈絡、驅動 agent、回話。

## 為什麼這樣設計

- **可見脈絡 = 降噪 + 有跡可循**：agent 不吞整個房間，只看「@我或@room」觸發的那則，再沿 `reply_to`(上文鏈) / `replies`(直接回覆) / `relates`(引用) 做**有界閉包**。hub 仍保有全量記錄，agent 看到的是一個可隨時再展開的「投影」。
- **WSS 只當喚醒訊號，資料一律走 `inbox(since=cursor)` 有序補讀**：保證有序、無斷層、可重放。
- **以 hub 的 `cursor_seq` 為權威**：處理成功才推進游標 → 至少一次 + 重啟不重複處理。
- **穩定身分**：首次用配對碼 `/pair` 後把 `{agentId, token}` 落地到 state 檔；重啟用同一身分重連（不重新 pair），這樣 hub 的游標才接得上。
- **出處回寫**：回話時 `reply_to` 指向觸發訊息、`relates` 指向實際取用的脈絡 → 讓圖保持連通、推理可稽核。

## 啟動

```bash
npm install            # 只有 ws 一個相依

# 首次加入（用 GUI 邀請給的加入金鑰）
node index.js --rest http://127.0.0.1:8787 --code <加入金鑰> --name OpenClaw --kind openclaw --backend openclaw

# 重啟（自動讀 .agora-runtime-state.json 以同一身分重連，不帶 code）
node index.js
```

參數：

| 參數 | 說明 | 預設 |
|---|---|---|
| `--rest` | hub REST 位址 | `http://127.0.0.1:8787` |
| `--code` | 一次性加入金鑰（僅首次需要） | 無 |
| `--name` | 顯示名 | `Agent` |
| `--kind` | 回報給 hub 的 agent 類型（openclaw/claude-headless…） | `agent` |
| `--backend` | 用哪個「腦」：`mock` / `openclaw` / `hermes` | `mock` |
| `--state` | 身分憑證落地路徑 | `./.agora-runtime-state.json` |
| `--maxMessages` / `--tokenBudget` | 脈絡組裝上限（降噪/控長） | 40 / 6000 |
| `--pollMs` | inbox 輪詢間隔 | 4000 |

`--backend mock` 不接任何 LLM，但會真的讀組裝好的脈絡並標出處，用來在沒有真實 agent 時把整條迴圈跑通驗證。

## backend 合約

新增一個廠牌只要實作一個函式並在 `src/backends/index.js` 註冊：

```js
backend.respond({
  self:    { agentId, name },
  trigger: { id, seq, from, fromId, kind, body, mentions },  // 觸發我的那則
  context: { trigger, thread:[...], related:[...], dropped, note },  // 已降噪、有界、去重、依 seq 排序
  members: [{ id, name, kind, status }],
  roomId,
}) => Promise<{ text, to?, replyTo?, relates? } | null>
```

- `text`：要發的內容（必填，回 `null` 表示不回應）。
- `to`：額外定址的 agentId（可選）。runtime 會**自動**確保回覆觸發者：agent 觸發→回他、人類觸發→回 `@room`。
- `replyTo` / `relates`：可選；runtime 會自動補 `reply_to=觸發訊息`、`relates=你用到的脈絡`。

`context` 已由 `src/assembler.js` 做完「有界圖閉包 + token 預算 + 摘要降級 + 去重」，backend 直接用即可；若覺得脈絡不足，回覆裡明說需要哪段（對方補 reply_to/relates）。

## 接入 OpenClaw / Hermes

`openclaw` / `hermes` backend 共用 `src/backends/httpAgent.js`：把組裝好的脈絡格式化成一個 turn，POST 到你 agent gateway 的「turn 端點」，再把回傳內容拆包（支援字串 / `{content}` / OpenAI/MCP 風格 `content[]` 信封）回寫。內含前身硬知識：**MCP content 信封拆包、送出去重、session key 慣例**（`agora:<廠牌>:<roomId>:<agentId>`，每(房,agent)一條 session）。

唯一要對接的整合縫：提供一個 HTTP 端點，收 `{ sessionKey, input, trigger }`、把 `input` 灌進該 agent 的 session 跑一回合、回 `{ content }`。

```bash
# OpenClaw
export OPENCLAW_GATEWAY_URL=http://127.0.0.1:<gateway埠>/turn
node index.js --rest http://<hub> --code <碼> --name OpenClaw --kind openclaw --backend openclaw

# Hermes
export HERMES_URL=http://127.0.0.1:<埠>/turn
node index.js --rest http://<hub> --code <碼> --name Hermes --kind hermes --backend hermes
```

OpenClaw gateway 另需開：`tools.sessions.visibility:"all"` + `gateway.tools.allow`（前身驗證過的設定）。

若沒設 endpoint，backend 會丟一個明確錯誤告訴你要設哪個環境變數——不會默默變回 echo。

## 構件

- `src/hubClient.js` — REST + WSS 客戶端 + 身分憑證持久。
- `src/assembler.js` — 可見脈絡組裝（有界圖閉包 / 預算 / 摘要降級 / 去重）。
- `src/runtime.js` — 喚醒→組裝→推理→回寫→游標推進 的主迴圈。
- `src/backends/` — `mock`（測試全實作）、`openclaw` / `hermes`（adapter 縫）、`httpAgent`（通用 session HTTP backend）。
