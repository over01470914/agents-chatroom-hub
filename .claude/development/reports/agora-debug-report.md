# Agora Debug Report - Message Encoding Issue

## 驗證結果摘要

### ✅ 成功確認的事項

1. **成功加入房間** - 可透過配對碼 + REST API 加入
2. **WebSocket 連線正常** - echo-agent 可維持長連
3. **REST API 發訊正常** - 可發送並寫入 hub
4. **收訊正常** - inbox / messages API 都能拿到資料

---

## ❌ 發現的問題：Message Encoding 異常

### 問題描述
部分訊息的 `body` 欄位出現亂碼（???置換），編碼不一致。

### 詳細觀察

| Seq | 發送者 | 原始內容（推測） | 實際讀取到的內容 |
|-----|--------|----------------|----------------|
| 1 | Human | 邀請 QClaw 加入 test01... @?! | `???!?? QClaw,????? test01 ???????????????,?????????????????????????????????? @?!` |
| 2 | QClaw (7b37f57d) | 收到「Human」說：邀請... | 同上（複製錯誤） |
| 3 | QClaw (ab8d1069) | 收到「Human」說：邀請... | 同上 |
| 4 | QClaw (ab8d1069) | 大家好！我是 QClaw... | 同上 |
| 5 | 翰 (human-dvijer) | 你好 | `你好` ✅ 正常 |
| 8 | 翰 (human-dvijer) | 你好 | `你好` ✅ 正常 |

### 關鍵發現
- **問題訊息全都是我用 REST API (Invoke-RestMethod) 發送的**
- **"翰" 手動發送的 "你好" 完全正常**
- 推測問題出在：**PowerShell 的 `Invoke-RestMethod` 在發送 JSON body 時，中文未正確 UTF-8 編碼**，或 Hub 的 REST API 接收時未正確解碼

### 測試對照組
```
# 翰透過 GUI/人類方式發送（正常）
seq=5, body="你好"  ✅

# 我透過 REST API PowerShell 發送（亂碼）
seq=4, body="???!?? QClaw..."  ❌
```

---

## 房間目前狀態

- **Room ID**: `a499fb4a-f425-4283-b4e8-8f1aadcc2cc4`
- **房間名**: test01
- **Hub URL**: `http://127.0.0.1:8787`
- **Hub Secret**: `dev-secret-change-me`

### 成員列表

| Agent ID | 名稱 | 狀態 | Cursor Seq |
|----------|------|------|-----------|
| `7b37f57d-aa4d-48b6-a7a2-5dce0ce0bd60` | QClaw | away | 8 |
| `ab8d1069-dddc-4914-a8cd-2f50b73698c6` | QClaw | online | 9 |

### 我的 session 身份
- **Agent ID**: `ab8d1069-dddc-4914-a8cd-2f50b73698c6`
- **Token**: `402f46c1a8d44238a7b956d45e7f6bd81a34e3a825f642eba79e3115dff01def`

---

## 訊息流程對比

### 正常訊息流程（翰 → Hub → 讀取）
```
翰(GUI/原生客戶端)
  → Hub (body="你好", UTF-8) ✅
  → Hub 存入 SQLite (UTF-8) ✅
  → 我讀取 (body="你好") ✅
```

### 異常訊息流程（我 → Hub → 讀取）
```
我(PowerShell Invoke-RestMethod)
  → Hub (body 編碼未知，可能非 UTF-8) ❌
  → Hub 存入 SQLite (已損壞)
  → 我讀取 (body="???!??...") ❌
```

---

## 推測根因

**PowerShell `Invoke-RestMethod` 的 `-Body` 參數在發送 JSON 字串時，若字串含中文字，預設可能使用非 UTF-8 編碼（如系統預設編碼）傳輸，導致 Hub 收到後存入 SQLite 的資料已經是亂碼。**

### 可能的修復方向
1. Hub 端：在 `rest.js` 的 `/rooms/:id/messages` handler 中，明確指定 `charset=utf-8`，或對 body 進行編碼正規化
2. 發送端：PowerShell 發送時明確指定 UTF-8 encoding
3. 資料庫層：存入前做 `Buffer` / `TextEncoder` 正規化

---

## 相關檔案路徑

- Hub repo: `C:\Users\over0\.qclaw\workspace\connectors\agora-mcp\`
- Hub REST 實作: `hub\src\rest.js`
- Hub 資料庫實作: `hub\src\db.js`
- Echo-agent (connector 範本): `connectors\echo-agent\index.js`
- 静音监听器: `connectors\echo-agent\index-silent.js`
- 配置備忘: `memory\agora-config.md`

---

## OpenClaw Session 資訊（本 session）

- Session ID: `agent:main:session-1779613516772-aq3ldp`
- 對話 ID (conversationId): 需用 `session_status` 查看
- Cron Job ID (inbox checker): `f80aa251-4cab-41d9-8ac6-4355334138e2`


---

## 修復結論（2026-05-24）

### 診斷確認
在 sandbox 重現，三組對照：

| 測試 | 送出方式 | hub 讀回 |
|------|----------|----------|
| A | 正確 UTF-8 位元組（curl / Node fetch / GUI） | `邀請 QClaw 加入 test01，你好嗎？@翰` ✅ |
| B | 模擬 PowerShell 以 ASCII 編碼字串 | `?? QClaw ??` ❌（完全重現本報告症狀）|
| C | `Content-Type: application/json; charset=utf-8` | `測試中文 ✅` ✅ |

**結論：hub 對 UTF-8 完全正確（存/讀皆正常）。亂碼發生在 PowerShell 發送端——中文在離開 PowerShell 前就被換成 `?`，送到 hub 時已是 `?`，伺服器端無法復原。** 已損壞的 seq 1–4 無法救回，僅能修正之後的發送。

### 修復內容（repo）
1. 新增 `hub/scripts/agora.ps1`：UTF-8 安全的 PowerShell helper（`New-AgoraRoom` / `Send-AgoraMessage` / `Get-AgoraMessages` / `Get-AgoraMembers`）。關鍵是把 JSON 轉成 `[Text.Encoding]::UTF8.GetBytes()` 再當 `-Body` 送，繞過 PowerShell 字串編碼。
2. README 新增「疑難排解：用 PowerShell 打 REST 中文變 ?」。

### 給 QClaw / 其他 agent 的建議
不要用 PowerShell `Invoke-RestMethod` 直接打 REST。改用 `connectors/agora-mcp`（Node `fetch`，一律 UTF-8）的工具：`agora_send_message` / `agora_view_session` / `agora_check_inbox`。走 connector 就不會有編碼問題。

### hub 端無需改碼
`express.json()` 預設以 UTF-8 解析、`res.json()` 回 `charset=utf-8`，皆正確；不需要也無法在伺服器端「修正」已被換成 `?` 的位元組。
