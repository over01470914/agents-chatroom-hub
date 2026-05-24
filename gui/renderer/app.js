// Agora GUI renderer。純客戶端：REST 輪詢 hub。由 hub 直接服務時會自動帶入 hubUrl+secret。
'use strict';

const $ = (id) => document.getElementById(id);
const LS = window.localStorage;
const httpOrigin = /^https?:$/.test(location.protocol) ? location.origin : null;

// ---- 自訂談窗 / 提示（取代瀏覽器 alert/prompt，避免某些環境下瀏覽器原生談窗失效）----
const ui = {
  _overlay: null, _toasts: null,
  _dlg() {
    if (this._overlay) return this._overlay;
    const o = document.createElement('div');
    o.id = 'uiDialog'; o.className = 'hidden';
    document.body.appendChild(o);
    this._overlay = o; return o;
  },
  _toastHost() {
    if (this._toasts) return this._toasts;
    const t = document.createElement('div'); t.id = 'uiToasts';
    document.body.appendChild(t); this._toasts = t; return t;
  },
  toast(message, type = 'info', ms = 3200) {
    const host = this._toastHost();
    const el = document.createElement('div');
    el.className = 'toast ' + type; el.textContent = message;
    host.appendChild(el);
    setTimeout(() => el.remove(), ms);
  },
  _open({ message, withInput = false, def = '', ok = '確定', cancel = null }) {
    return new Promise((resolve) => {
      const o = this._dlg();
      o.innerHTML = '';
      const box = document.createElement('div'); box.className = 'ui-box';
      const msg = document.createElement('div'); msg.className = 'ui-msg'; msg.textContent = message;
      box.appendChild(msg);
      let input = null;
      if (withInput) {
        input = document.createElement('input'); input.value = def; box.appendChild(input);
      }
      const actions = document.createElement('div'); actions.className = 'ui-actions';
      const close = (val) => { o.classList.add('hidden'); o.innerHTML = ''; resolve(val); };
      if (cancel) {
        const cb = document.createElement('button'); cb.className = 'cancel'; cb.textContent = cancel;
        cb.onclick = () => close(withInput ? null : false); actions.appendChild(cb);
      }
      const okb = document.createElement('button'); okb.textContent = ok;
      okb.onclick = () => close(withInput ? input.value.trim() : true); actions.appendChild(okb);
      box.appendChild(actions); o.appendChild(box); o.classList.remove('hidden');
      if (input) { input.focus(); input.addEventListener('keydown', (e) => { if (e.key === 'Enter') okb.click(); }); }
      o.onkeydown = (e) => { if (e.key === 'Escape' && cancel) close(withInput ? null : false); };
    });
  },
  alert(message) { return this._open({ message, ok: '好' }); },
  confirm(message) { return this._open({ message, ok: '確定', cancel: '取消' }); },
  prompt(message, def = '') { return this._open({ message, withInput: true, def, ok: '確定', cancel: '取消' }); },
};

const state = {
  hubUrl: LS.getItem('agora.hubUrl') || httpOrigin || 'http://127.0.0.1:8787',
  secret: LS.getItem('agora.secret') || '',
  humanName: LS.getItem('agora.humanName') || '翰',
  humanId: LS.getItem('agora.humanId') || ('human-' + Math.random().toString(36).slice(2, 8)),
  room: null, lastSeq: 0, members: [], msgTimer: null, memberTimer: null,
};
LS.setItem('agora.humanId', state.humanId);

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
function setStatus(on, text) { const el = $('connStatus'); el.textContent = text; el.className = 'status ' + (on ? 'on' : 'off'); }

async function tryAutoConfig() {
  if (!httpOrigin) return false;
  try {
    const cfg = await fetch(httpOrigin + '/app-config').then((r) => r.json());
    if (cfg.hubUrl) { state.hubUrl = cfg.hubUrl; $('hubUrl').value = cfg.hubUrl; }
    if (cfg.secret) { state.secret = cfg.secret; $('secret').value = cfg.secret; }
    return !!cfg.secret;
  } catch { return false; }
}

async function connect() {
  state.hubUrl = $('hubUrl').value.trim().replace(/\/$/, '');
  state.secret = $('secret').value;
  state.humanName = $('humanName').value.trim() || '翰';
  LS.setItem('agora.hubUrl', state.hubUrl);
  LS.setItem('agora.secret', state.secret);
  LS.setItem('agora.humanName', state.humanName);
  try {
    const h = await fetch(state.hubUrl + '/health').then((r) => r.json());
    if (!h.ok) throw new Error('health 回應異常');
    setStatus(true, '已連線');
    await loadRooms();
  } catch (e) {
    setStatus(false, '連線失敗');
    ui.toast(`連線失敗：無法連到 ${state.hubUrl}。確認 hub 已啟動、位址與 secret 正確。`, 'error', 5000);
    console.error(e);
  }
}

async function loadRooms() {
  const rooms = await api('/rooms').then((r) => r.json());
  const ul = $('roomList'); ul.innerHTML = '';
  for (const room of rooms) {
    const li = document.createElement('li');
    li.textContent = room.name; li.dataset.id = room.id;
    if (state.room && room.id === state.room.id) li.classList.add('active');
    li.onclick = () => selectRoom(room);
    ul.appendChild(li);
  }
}
async function newRoom() {
  if (state.connStatusOff && !state.secret) { /* noop */ }
  const name = await ui.prompt('房間名稱：');
  if (!name) return;
  try {
    const room = await api('/rooms', { method: 'POST', body: JSON.stringify({ name }) }).then((r) => r.json());
    if (room.error) throw new Error(room.error);
    await loadRooms(); selectRoom(room);
    ui.toast(`已建立房間「${name}」`, 'ok');
  } catch (e) {
    ui.toast('建立房間失敗：' + e.message + '（是否已連線？）', 'error', 5000);
  }
}
function selectRoom(room) {
  state.room = room; state.lastSeq = 0;
  $('roomTitle').textContent = room.name; $('messages').innerHTML = '';
  [...$('roomList').children].forEach((li) => li.classList.toggle('active', li.dataset.id === room.id));
  startPolling(); refreshMembers();
}

function startPolling() {
  clearInterval(state.msgTimer); clearInterval(state.memberTimer);
  pollMessages();
  state.msgTimer = setInterval(pollMessages, 1500);
  state.memberTimer = setInterval(refreshMembers, 3000);
}
async function pollMessages() {
  if (!state.room) return;
  try {
    const rows = await api(`/rooms/${state.room.id}/messages?since=${state.lastSeq}`).then((r) => r.json());
    for (const m of rows) { appendMessage(m); if (m.seq > state.lastSeq) state.lastSeq = m.seq; }
  } catch { /* 下次再試 */ }
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
  if (!state.room) { ui.toast('請先選一個房間', 'error'); return; }
  const input = $('msgInput'); const body = input.value.trim();
  if (!body) return;
  const target = $('mentionSel').value;
  input.value = '';
  try {
    await api(`/rooms/${state.room.id}/messages`, {
      method: 'POST',
      body: JSON.stringify({ body, authorId: state.humanId, authorName: state.humanName, mentions: [target] }),
    });
    pollMessages();
  } catch (e) { ui.toast('送出失敗：' + e.message, 'error'); }
}

async function refreshMembers() {
  if (!state.room) return;
  try { state.members = await api(`/rooms/${state.room.id}/members`).then((r) => r.json()); } catch { return; }
  const ul = $('memberList'); ul.innerHTML = '';
  for (const m of state.members) {
    const li = document.createElement('li');
    li.innerHTML =
      `<span class="dot ${m.status}"></span>` +
      `<span class="avatar">${esc(m.avatar || '🤖')}</span>` +
      `<span class="mname">${esc(m.name)}<div class="mhost">${esc(m.host || '')} · ${esc(m.kind)}</div></span>`;
    ul.appendChild(li);
  }
  const sel = $('mentionSel'); const cur = sel.value;
  sel.innerHTML = '<option value="room">@全房</option>';
  for (const m of state.members) {
    const o = document.createElement('option'); o.value = m.id; o.textContent = '@' + m.name; sel.appendChild(o);
  }
  if ([...sel.options].some((o) => o.value === cur)) sel.value = cur;
}

function openInvite() {
  if (!state.room) { ui.toast('請先選一個房間', 'error'); return; }
  $('inviteRoomName').textContent = state.room.name;
  $('inviteResult').classList.add('hidden');
  $('inviteModal').classList.remove('hidden');
}
async function genInvite() {
  try {
    const kind = $('inviteKind').value;
    const purpose = ($('invitePurpose')?.value || '').trim();
    const res = await api('/invite', { method: 'POST', body: JSON.stringify({ roomId: state.room.id, kind, purpose }) }).then((r) => r.json());
    if (res.error) throw new Error(res.error);
    $('pairCode').textContent = res.pairingCode;
    $('invitePrompt').value = res.prompt;
    $('inviteResult').classList.remove('hidden');
  } catch (e) { ui.toast('產生邀請失敗：' + e.message, 'error', 5000); }
}
function copy(text) {
  if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(() => ui.toast('已複製', 'ok', 1500)).catch(() => { fallbackCopy(text); ui.toast('已複製', 'ok', 1500); });
  else { fallbackCopy(text); ui.toast('已複製', 'ok', 1500); }
}
function fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); } catch { /* ignore */ }
  document.body.removeChild(ta);
}

$('connectBtn').onclick = connect;
$('newRoomBtn').onclick = newRoom;
$('sendBtn').onclick = sendMessage;
$('msgInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendMessage(); });
$('inviteBtn').onclick = openInvite;
$('genInviteBtn').onclick = genInvite;
$('closeInviteBtn').onclick = () => $('inviteModal').classList.add('hidden');
$('copyCodeBtn').onclick = () => copy($('pairCode').textContent);
$('copyPromptBtn').onclick = () => copy($('invitePrompt').value);

(async () => {
  const auto = await tryAutoConfig();
  if (auto || state.secret) connect();
})();
