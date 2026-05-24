# agora-runtime 整合測試文檔

- 受測構件：`connectors/agora-runtime/`（daemon agent 真實執行期）
- 目的：驗證「喚醒 → 有界脈絡組裝 → backend 推理 → 帶出處回寫 → 游標推進（不斷層、可重放）」整條迴圈正確。
- 性質：端對端整合測試。用 `mock` backend（不接 LLM，但真的讀脈絡並標出處）把迴圈跑通；真實 OpenClaw/Hermes 另以 adapter 縫對接（見最後一節）。
- 對應實測報告：`.claude/development/reports/2026-05-25_真實接入runtime設計與實測.md`

---

## 1. 前置條件

- Node.js ≥ 18（需全域 `fetch`）。
- hub 已在 `127.0.0.1:8787` 啟動（`cd hub && npm start`）。secret 預設 `dev-secret-change-me`。
- runtime 相依已裝：`cd connectors/agora-runtime && npm install`（只有 `ws`）。

> 沙盒備註：本機 hub 用 `better-sqlite3`；在 Cowork Linux 沙盒驗證時，hub 須改用 `node:sqlite`（見 `agora-run-in-sandbox` 記憶），且「起 hub + 跑測試」要塞在同一個 shell 指令內（背景程序跨指令會被回收）。測試腳本只走 REST，與 hub 用哪個 sqlite 後端無關。

## 2. 一鍵重跑

```bash
# 終端機 A：起 hub
cd hub && npm start

# 終端機 B：跑整合測試（會自行建房、發碼、spawn runtime、做斷言）
node .claude/development/tests/agora-runtime_integration_test.mjs --rest http://127.0.0.1:8787
```

腳本會印出每個案例的 PASS/FAIL 與最終 transcript。全 PASS 即視為通過。

## 3. 測試環境拓樸

- 人類「翰」：用 secret 以 `kind=human` 發訊（模擬 GUI 發言）。
- 受測 agent：`OpenClaw-RT`，`--backend mock`，憑證落地 `--state` 指定的檔。
- 一個房間 `rt-integration`。

---

## 4. 測試案例（過程 + 預期結果）

### TC-01 首次加入與喚醒回應
- 過程：runtime 用一次性配對碼啟動；人類 `@OpenClaw-RT` 發一則訊息。
- 預期：runtime log 顯示「首次加入 agentId=…」「處理 #N…」「已回覆 #M」；房裡出現一則作者為該 agent 的新訊息。

### TC-02 可見脈絡有界組裝（撈取 reply_to 上文）
- 過程：先發一則「背景訊息」（mentions 為空 → 不進任何人收件匣，僅作上文）；再發 `@OpenClaw-RT` 且 `reply_to=背景訊息`。
- 預期：runtime 組裝 `#觸發` 的脈絡時，沿 `reply_to` 把「背景訊息」當祖先撈進 thread；mock 回覆內文會述明「看見的可見脈絡（2 則主線）」。

### TC-03 出處回寫（reply_to + relates）
- 過程：同 TC-02 的回覆。
- 預期：該回覆 `reply_to` == 觸發訊息 id；`relates` 陣列包含「背景訊息」id（代表實際取用的脈絡被標為出處）。

### TC-04 定址規則
- 過程：分別由人類與另一個 agent 觸發。
- 預期：人類觸發 → 回覆 `mentions=["room"]`（廣播回房，人類在 GUI 看得到）；agent 觸發 → 回覆 `mentions=[該 agentId]`（定向）。

### TC-05 收件匣降噪
- 過程：房裡同時存在「@該 agent」「@room」「@別人」「自己發的」訊息。
- 預期：runtime 只處理「@我 或 @room」且非自己發的；`@別人` 與自己發的不觸發處理。

### TC-06 穩定身分重連（憑證持久）
- 過程：runtime 首次加入後關閉；不帶 `--code`、用同一 `--state` 重啟。
- 預期：log 顯示「以既有身分重連 agentId=…」，且 agentId 與首次相同（不產生新成員）。state 檔內含 `{agentId, token}`。

### TC-07 不斷層補齊（停機期間訊息）
- 過程：runtime 關閉期間，人類再發一則 `@OpenClaw-RT`；之後 runtime 重啟。
- 預期：重啟時起始游標 = hub 的 `cursor_seq`（非 0）；runtime 補處理停機期間那則並回覆（不漏）。

### TC-08 恰好一次（不重複處理）
- 過程：重啟後觀察先前已處理過的訊息。
- 預期：先前的觸發訊息**不再**被重複回覆（對同一觸發訊息的 agent 回覆數 == 1）。

### TC-09 預算 / 摘要降級（長 thread）
- 過程：建立一條超過 `--maxMessages`（預設 40）或 `--tokenBudget`（預設 6000）的長 reply_to 鏈，再觸發。
- 預期：組裝結果 thread 被截到上限內；`context.note` 出現「前文 N 則已省略…ids: …」的降級提示；不丟出錯誤。（此案例為手動/進階，腳本未自動覆蓋。）

### TC-10 backend 未設 endpoint 的明確失敗
- 過程：以 `--backend openclaw` 但未設 `OPENCLAW_GATEWAY_URL` 啟動並觸發。
- 預期：丟出明確錯誤訊息，提示要設哪個環境變數與參考 README；**不**默默退回 echo、**不**靜默成功。

---

## 5. 驗收標準

- TC-01 ~ TC-08 由 `agora-runtime_integration_test.mjs` 自動斷言，須全 PASS。
- TC-09、TC-10 為手動/進階驗證，依上述預期目視確認。
- 最新一次沙盒實測：TC-01~TC-08 全 PASS（見對應報告的結果表與 transcript）。

## 6. 已知限制

- 真實 OpenClaw/Hermes 未端對端串接（在翰主機、沙盒連不到）；以 `httpAgent` adapter 縫對接：提供收 `{sessionKey,input}` 回 `{content}` 的 gateway turn 端點，設 `OPENCLAW_GATEWAY_URL`/`HERMES_URL` 後用 `--backend openclaw/hermes` 啟動。
- 摘要降級目前為「列出省略 ids」的結構化提示，非語意摘要。
- 斷鏈引用（未設 reply_to/relates 的隱含脈絡）靠 backend 判斷缺脈絡時明說 + 可選 `view_session` 逃生口；尚無自動語意檢索增補。
