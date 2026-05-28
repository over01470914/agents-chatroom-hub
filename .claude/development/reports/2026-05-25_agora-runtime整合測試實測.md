# agora-runtime 整合測試 — 本機（Windows）實測

- 日期：2026-05-25
- 受測構件：`connectors/agora-runtime/`（daemon agent 真實執行期）
- 測試文檔：`.claude/development/tests/agora-runtime_整合測試.md`
- 環境：Windows 10 Pro / Node.js v24.15.0 / hub 在 `127.0.0.1:8787`（`better-sqlite3` 後端，已在執行中，version 0.1.0）/ secret 預設 `dev-secret-change-me`
- 一句話：TC-01 ~ TC-10 **全 PASS**（自動 10 斷言 + 手動 7 斷言），整條「喚醒 → 有界脈絡組裝 → backend 推理 → 帶出處回寫 → 游標推進」迴圈在 Windows + better-sqlite3 hub 上驗證通過。

## 怎麼跑的

```
# hub 已在 127.0.0.1:8787 執行中（health: {"ok":true,"name":"agora-hub","version":"0.1.0"}）
# 兩支腳本皆自行建房、發碼、spawn runtime、做斷言。

# TC-01~TC-08（自動）
node .claude/development/tests/agora-runtime_integration_test.mjs --rest http://127.0.0.1:8787

# TC-09~TC-10（手動/進階，本次新增驅動腳本）
node .claude/development/tests/agora-runtime_manual_tc09_tc10.mjs --rest http://127.0.0.1:8787
```

> 沙盒備註提到沙盒須改 `node:sqlite` 並把「起 hub + 跑測試」塞同一指令；本機則是 hub 常駐（better-sqlite3）、測試另開分頁直接打 REST，與 sqlite 後端無關，照樣通過。

## 結果

### TC-01 ~ TC-08（`agora-runtime_integration_test.mjs`，自動斷言）

| 測試項 | 結果 |
|---|---|
| TC-01 被 @ 後喚醒並回覆 | PASS |
| TC-02 組裝撈到 reply_to 上文（可見脈絡 2 則） | PASS |
| TC-03a 回覆 `reply_to` == 觸發訊息 | PASS |
| TC-03b 回覆 `relates` 含背景訊息（出處） | PASS |
| TC-04 人類觸發 → 回覆 `@room` | PASS |
| TC-05 收件匣降噪（不理 `@別人`） | PASS |
| TC-06 憑證持久（state 含同一 agentId）＋ 重連無新成員 | PASS |
| TC-07 不斷層補齊停機期間提問（起始游標=30，非 0） | PASS |
| TC-08 恰好一次（對 q1 的回覆數 == 1） | PASS |

`結果：PASS 10 / FAIL 0`

最終 transcript（節錄）：

```
#29 翰[human] to=[]                      : 背景：2F A棟樓高 340，外牆 TOL 200…
#30 翰[human] to=[agentId] reply_to=#29  : @OpenClaw-RT 依上面的背景，外牆模板扣除原則…
#31 OpenClaw-RT[agent] to=[room] reply_to=#30 relates=1 : （mock）可見脈絡（2 則主線）…標出處
#32 翰[human] to=[不存在 id]             : @somebody-else 這則不是給 RT 的。（不觸發）
#33 翰[human] to=[agentId]               : @OpenClaw-RT 停機期間補一題…（runtime 當時離線）
#34 OpenClaw-RT[agent] to=[room] reply_to=#33 : （resume 後游標接 30 補處理）
```

關鍵 log 佐證：首次加入 `cursor_seq=0`；kill 後不帶 `--code`、同 `--state` 重啟顯示「以既有身分重連 agentId=…（同一個）」「起始游標 cursor_seq=30」→ 證實穩定身分 + 不斷層 + 不重複。

### TC-09 ~ TC-10（`agora-runtime_manual_tc09_tc10.mjs`，手動/進階）

| 測試項 | 結果 |
|---|---|
| TC-09 長 reply_to 鏈觸發後有回覆（未丟錯） | PASS |
| TC-09 出現降級摘要提示「前文 N 則已省略…ids:」 | PASS |
| TC-09 thread 截到上限內（14 祖先+1 觸發=15 → 截到 6 主線） | PASS |
| TC-10 明確錯誤訊息（提示要設 `OPENCLAW_GATEWAY_URL`） | PASS |
| TC-10 錯誤訊息參考 README | PASS |
| TC-10 不默默退回 echo／不靜默成功（房內無 agent 回覆） | PASS |

`結果：PASS 7 / FAIL 0`

- **TC-09**：建 14 則 reply_to 鏈當前文 + 1 則觸發；以 `--maxMessages 8` 啟動 mock runtime。組裝後 thread 被截為最近 6 則（`keepRecent=max(6, floor(8/2))=6`），回覆內含
  `（前文 9 則已省略以控管脈絡長度；如需可用 search_context 展開，ids: …）`，無錯誤丟出。符合預期。
- **TC-10**：`--backend openclaw` 且刻意自子程序 env 移除 `OPENCLAW_GATEWAY_URL`。觸發後 runtime log 印出
  `backend 失敗： openclaw backend 尚未設定 endpoint。請設環境變數（例如 OPENCLAW_GATEWAY_URL / HERMES_URL）… 詳見 connectors/agora-runtime/README.md`，且房內**無**任何 agent 訊息（不退回 echo、不靜默成功）。符合預期。

## 驗收

- TC-01 ~ TC-08：自動斷言全 PASS。
- TC-09、TC-10：手動/進階預期皆目視 + 斷言確認 PASS。
- 與沙盒上一次（TC-01~TC-08 全 PASS，node:sqlite hub）一致；本次再加 TC-09/TC-10 並改在 Windows + better-sqlite3 hub 驗證。

## 備註 / 限制（沿用測試文檔 §6）

- 真實 OpenClaw/Hermes 仍未端對端串接；以 `httpAgent` adapter 縫對接（設 `OPENCLAW_GATEWAY_URL`/`HERMES_URL` 後用 `--backend openclaw/hermes`）。
- 摘要降級為「列出省略 ids」的結構化提示，非語意摘要。
- 本次新增的 TC-09/TC-10 驅動腳本：`.claude/development/tests/agora-runtime_manual_tc09_tc10.mjs`。
