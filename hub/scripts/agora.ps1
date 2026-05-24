# Agora REST helper for Windows PowerShell
# 解決：直接用 Invoke-RestMethod 送中文會變成「?」的問題。
# 根因：PowerShell（尤其 5.1）把字串 body 用非 UTF-8 編碼送出，中文在送出前就被換成 ?。
# 解法：本 helper 一律把 JSON 轉成 UTF-8 位元組（byte[]）再送，繞過字串編碼那一步。
#
# 用法：
#   . .\agora.ps1                                  # dot-source 載入函式（注意前面那個點）
#   $env:AGORA_HUB    = 'http://127.0.0.1:8787'    # 可選，預設就是這個
#   $env:AGORA_SECRET = '<你的 secret>'             # 可選，省略會自動讀 ..\config.json
#   $r = New-AgoraRoom -Name 'test01'
#   Send-AgoraMessage -Room $r.id -Message '你好，世界！@翰' -Mentions room
#   Get-AgoraMessages -Room $r.id | Format-Table seq, author_name, body

$OutputEncoding = [System.Text.Encoding]::UTF8
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

function Get-AgoraConfig {
  param([string]$Hub, [string]$Secret)
  if (-not $Hub)    { $Hub = $env:AGORA_HUB }
  if (-not $Hub)    { $Hub = 'http://127.0.0.1:8787' }
  if (-not $Secret) { $Secret = $env:AGORA_SECRET }
  if (-not $Secret) {
    try { $Secret = (Get-Content -Raw "$PSScriptRoot\..\config.json" | ConvertFrom-Json).secret } catch {}
  }
  return @{ Hub = $Hub.TrimEnd('/'); Secret = $Secret }
}

function Invoke-Agora {
  param([string]$Method, [string]$Path, [object]$Body, [string]$Hub, [string]$Secret)
  $c = Get-AgoraConfig -Hub $Hub -Secret $Secret
  $headers = @{ Authorization = "Bearer $($c.Secret)" }
  $uri = "$($c.Hub)$Path"
  if ($null -ne $Body) {
    $json  = $Body | ConvertTo-Json -Compress -Depth 8
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)   # ← 關鍵：以 UTF-8 位元組送出
    return Invoke-RestMethod -Uri $uri -Method $Method -Headers $headers `
      -ContentType 'application/json; charset=utf-8' -Body $bytes
  }
  return Invoke-RestMethod -Uri $uri -Method $Method -Headers $headers
}

function New-AgoraRoom {
  param([Parameter(Mandatory)][string]$Name, [string]$Hub, [string]$Secret)
  Invoke-Agora -Method Post -Path '/rooms' -Body @{ name = $Name } -Hub $Hub -Secret $Secret
}

function Send-AgoraMessage {
  param(
    [Parameter(Mandatory)][string]$Room,
    [Parameter(Mandatory)][string]$Message,
    [string[]]$Mentions = @('room'),
    [string]$AuthorId = 'ps-user',
    [string]$AuthorName = 'PowerShell',
    [string]$Hub, [string]$Secret
  )
  Invoke-Agora -Method Post -Path "/rooms/$Room/messages" -Body @{
    body = $Message; mentions = $Mentions; authorId = $AuthorId; authorName = $AuthorName
  } -Hub $Hub -Secret $Secret
}

function Get-AgoraMessages {
  param([Parameter(Mandatory)][string]$Room, [int]$Since = 0, [string]$Hub, [string]$Secret)
  Invoke-Agora -Method Get -Path "/rooms/$Room/messages?since=$Since" -Hub $Hub -Secret $Secret
}

function Get-AgoraMembers {
  param([Parameter(Mandatory)][string]$Room, [string]$Hub, [string]$Secret)
  Invoke-Agora -Method Get -Path "/rooms/$Room/members" -Hub $Hub -Secret $Secret
}
