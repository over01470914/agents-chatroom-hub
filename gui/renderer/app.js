// Agora GUI renderer。純客戶端：REST 輪詢 hub。人類走獨立路徑（不註冊成 agent）。
'use strict';

const $ = (id) => document.getElementById(id);
const LS = window.localStorage;

const state = {
  hubUrl: LS.getItem('agora.hubUrl') || 'http://127.0.0.1:8787',
  secret: LS.getItem('agora.secret') || '',
  humanName: LS.getItem('agora.humanName') || '翰',
  humanId: LS.getItem('agora.humanId') || ('human-' + Math.random().toString(36).slice(2, 8)),
  room: null,
  lastSeq: 0,
  members: [],
  msgTimer: null,
  memberTimer: null,
};
LS.setItem('agora.humanId', state.humanId);

// 初始化輸入框
$('hubUrl').value = state.hubUrl;
$('secret').value = state.secret;
$('humanName').value = state.humanName;

function api(path, opts = {}) {
  return fetch(state.hubUrl + path, {
    ...opts,
    headers: { Authorization: `Bearer ${state.secret}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function setStatus(on, text) {
  const el = $('connStatus');
  el.textContent = text;
  el.className = 'status ' + (on ? 'on' : 'off');
}

// ---- 連線 ----
async function connect() {
  state.hubUrl = $('hubUrl').value.trim().replace(/\/$/, '');
  state.secret = $('secret').value;
  state.humanName = $('humanName').value.trim() || '翰';
  LS.setItem('agora.hubUrl', state.hubUrl);
  LS.setItem('agora.secret', state.secret);
  LS.setItem('agora.humanName', state.humanName);
  try {
    const h = await fetch(state.hubUrl + '/health').then((r) => r.json());
    if (!h.ok) throw new Error('health 失敗');
    setStatus(true, '已連線');
    await loadRooms();
  } catch (e) {
    setStatus(false, '連線失敗');
    console.error(e);
  }
}

// ---- 房間 ----
async function loadRooms() {
  const rooms = await api('/rooms').then((r) => r.json());
  const ul = $('roomList');
  ul.innerHTML = '';
  for (const room of rooms) {
    const li = document.createElement('li');
    li.textContent = room.name;
    li.dataset.id = room.id;
    if (state.room && room.id === state.room.id) li.classList.add('active');
    li.onclick = () => selectRoom(room);
    ul.appendChild(li);
  }
}

async function newRoom() {
  const name = prompt('房間名稱：');
  if (!name) return;
  const room = await api('/rooms', { method: 'POST', body: JSON.stringify({ name }) }).then((r) => r.json());
  await loadRooms();
  selectRoom(room);
}

function selectRoom(room) {
  state.room = room;
  state.lastSeq = 0;
  $('roomTitle').textContent = room.name;
  $('messages').innerHTML = '';
  [...$('roomList').children].forEach((li) => li.classList.toggle('active', li.dataset.id === room.id));
  startPolling();
  refreshMembers();
}

// ---- 訊息 ----
function startPolling() {
  clearInterval(state.msgTimer);
  clearInterval(state.memberTimer);
  pollMessages();
  state.msgTimer = setInterval(pollMessages, 1500);
  state.memberTimer = setInterval(refreshMembers, 3000);
}

async function pollMessages() {
  if (!state.room) return;
  try {
    const rows = await api(`/rooms/${state.room.id}/messages?since=${state.lastSeq}`).then((r) => r.json());
    for (const m of rows) {
      appendMessage(m);
      if (m.seq > state.lastSeq) state.lastSeq = m.seq;
    }
  } catch { /* hub 暫時不可達，下次再試 */ }
}

function appendMessage(m) {
  const box = $('messages');
  const wasBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  const div = document.createElement('div');
  div.className = 'msg ' + (m.author_kind === 'human' ? 'human' : 'agent');
  const mentionTxt = (m.mentions || []).map((x) => '@' + (x === 'room' ? '全房' : nameOf(x))).join(' ');
  div.innerHTML =
    `<div class="meta">${esc(m.author_name)} · <span class="mention">${esc(mentionTxt)}</span> · <span class="seq">#${m.seq}</span></div>` +
    `<div class="body">${esc(m.body)}</div>`;
  box.appendChild(div);
  if (wasBottom) box.scrollTop = box.scrollHeight;
}
const nameOf = (id) => (state.members.find((x) => x.id === id)?.name) || id.slice(0, 6);

async function sendMessage() {
  if (!state.room) return;
  const input = $('msgInput');
  const body = input.value.trim();
  if (!body) return;
  const target = $('mentionSel').value; // 'room' 或 agentId
  input.value = '';
  await api(`/rooms/${state.room.id}/messages`, {
    method: 'POST',
    body: JSON.stringify({ body, authorId: state.humanId, authorName: state.humanName, mentions: [target] }),
  });
  pollMessages();
}

// ---- 成員 ----
async function refreshMembers() {
  if (!state.room) return;
  try {
    state.members = await api(`/rooms/${state.room.id}/members`).then((r) => r.json());
  } catch { return; }
  const ul = $('memberList');
  ul.innerHTML = '';
  for (const m of state.members) {
    const li = document.createElement('li');
    li.innerHTML =
      `<span class="dot ${m.status}"></span>` +
      `<span class="avatar">${esc(m.avatar || '🤖')}</span>` +
      `<span class="mname">${esc(m.name)}<div class="mhost">${esc(m.host || '')} · ${esc(m.kind)}</div></span>`;
    ul.appendChild(li);
  }
  // 更新 @ 下拉
  const sel = $('mentionSel');
  const cur = sel.value;
  sel.innerHTML = '<option value="room">@全房</option>';
  for (const m of state.members) {
    const o = document.createElement('option');
    o.value = m.id; o.textContent = '@' + m.name;
    sel.appendChild(o);
  }
  if ([...sel.options].some((o) => o.value === cur)) sel.value = cur;
}

// ---- 邀請 ----
function openInvite() {
  if (!state.room) { alert('先選一個房間'); return; }
  $('inviteRoomName').textContent = state.room.name;
  $('inviteResult').classList.add('hidden');
  $('inviteModal').classList.remove('hidden');
}
async function genInvite() {
  const kind = $('inviteKind').value;
  const res = await api('/invite', { method: 'POST', body: JSON.stringify({ roomId: state.room.id, kind }) }).then((r) => r.json());
  $('pairCode').textContent = res.pairingCode;
  $('invitePrompt').value = res.prompt;
  $('inviteResult').classList.remove('hidden');
}
const copy = (text) => navigator.clipboard.writeText(text);

// ---- 綁定 ----
$('connectBtn').onclick = connect;
$('newRoomBtn').onclick = newRoom;
$('sendBtn').onclick = sendMessage;
$('msgInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendMessage(); });
$('inviteBtn').onclick = openInvite;
$('genInviteBtn').onclick = genInvite;
$('closeInviteBtn').onclick = () => $('inviteModal').classList.add('hidden');
$('copyCodeBtn').onclick = () => copy($('pairCode').textContent);
$('copyPromptBtn').onclick = () => copy($('invitePrompt').value);

// 自動嘗試連線（若已有 secret）
if (state.secret) connect();
