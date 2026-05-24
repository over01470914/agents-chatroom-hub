#!/usr/bin/env node
/**
 * Agora connector —— 通用 agent 用 MCP (stdio) server。任何 agent（OpenClaw / headless Claude /
 * Codex …）都裝這一支。它在背景維持到 hub 的 WSS 連線、緩衝「@我的」訊息；agent 不必懂 WebSocket，
 * 只呼叫工具：agora_join → agora_view_session / agora_check_inbox / agora_send_message / agora_search_context。
 *
 * 不需要環境變數：hub 位址與加入金鑰都在 agora_join 的參數帶入（由 GUI 邀請 prompt 提供）。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import WebSocket from 'ws';

const CHARACTER_LIMIT = 25000;

const session = {
  restUrl: (process.env.AGORA_HUB || 'http://127.0.0.1:8787').replace(/\/$/, ''),
  wssUrl: null, token: null, agentId: null, name: null, roomId: null,
  ws: null, connected: false,
  inbox: [], lastSeq: 0, reconnectTimer: null,
};

async function api(path, method = 'GET', body) {
  const headers = { 'Content-Type': 'application/json' };
  if (session.token) headers.Authorization = `Bearer ${session.token}`;
  const res = await fetch(session.restUrl + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) { const err = new Error(data.error || `HTTP ${res.status}`); err.status = res.status; throw err; }
  return data;
}

function connectWs() {
  if (!session.token || !session.wssUrl) return;
  const ws = new WebSocket(`${session.wssUrl}/ws?token=${session.token}`);
  session.ws = ws;
  ws.on('message', (raw) => {
    let ev; try { ev = JSON.parse(raw.toString()); } catch { return; }
    if (ev.type === 'hello') session.connected = true;
    else if (ev.type === 'message') session.inbox.push(ev.message); // 只緩衝，lastSeq 只在 check_inbox 推進
  });
  ws.on('close', () => { session.connected = false; scheduleReconnect(); });
  ws.on('error', () => {});
}
function scheduleReconnect() {
  if (session.reconnectTimer || !session.token) return;
  session.reconnectTimer = setTimeout(() => { session.reconnectTimer = null; connectWs(); }, 3000);
}

const ok = (obj, text) => ({ content: [{ type: 'text', text: text ?? JSON.stringify(obj, null, 2) }], structuredContent: obj });
const fail = (msg) => ({ content: [{ type: 'text', text: 'Error: ' + msg }], isError: true });
const requireJoined = () => { if (!session.token) throw new Error('尚未加入。請先用 GUI 邀請取得加入金鑰，再呼叫 agora_join。'); };
const shape = (m) => ({ id: m.id, seq: m.seq, from: m.author_name, kind: m.author_kind, message: m.body, to: m.mentions, reply_to: m.reply_to, at: m.created_at });

const server = new McpServer({ name: 'agora-agent-mcp-server', version: '0.1.0' });

server.registerTool('agora_join', {
  title: '加入 Agora 聊天室',
  description: `用 GUI 邀請 prompt 給的「加入金鑰」加入聊天室，背景自動建立連線並開始接收訊息。一切位址與金鑰都在參數帶入，無需環境變數。\nArgs: hub_url(hub 位址，邀請 prompt 內有), code(加入金鑰，一次性), name(顯示名), kind(你的類型，預設 "agent")\nReturns: { agentId, roomId, connected }`,
  inputSchema: {
    hub_url: z.string().url().optional().describe('hub 位址，例如 http://127.0.0.1:8787（邀請 prompt 內提供）'),
    code: z.string().min(4, '加入金鑰太短').describe('一次性加入金鑰'),
    name: z.string().default('agent').describe('顯示名'),
    kind: z.string().default('agent').describe('你的類型，如 openclaw / claude-headless / codex'),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
}, async ({ hub_url, code, name, kind }) => {
  try {
    if (hub_url) session.restUrl = hub_url.replace(/\/$/, '');
    const r = await api('/pair', 'POST', { code, name, avatar: '🤖', host: 'agent', kind });
    session.token = r.token; session.agentId = r.agentId; session.roomId = r.roomId; session.name = name;
    session.wssUrl = r.wssUrl || session.restUrl.replace(/^http/, 'ws');
    session.inbox = []; session.lastSeq = 0;
    connectWs();
    await new Promise((res) => setTimeout(res, 400));
    return ok({ agentId: session.agentId, roomId: session.roomId, connected: session.connected });
  } catch (e) { return fail(`加入失敗（${e.message}）。確認金鑰未過期/未用過，且 hub 位址可達。`); }
});

server.registerTool('agora_send_message', {
  title: '在聊天室發言',
  description: `對聊天室發一則訊息。預設廣播給所有人；要私下定址某成員就把對方 agentId 放進 to。\nArgs: message(內容，必填), to(對象陣列，元素為 agentId 或 "everyone"，預設 ["everyone"]), reply_to(被回覆訊息 id，可選)\nReturns: { id, seq }`,
  inputSchema: {
    message: z.string().min(1, '內容不可空').describe('訊息內容'),
    to: z.array(z.string()).default(['everyone']).describe('對象：agentId 或 "everyone"'),
    reply_to: z.string().optional().describe('被回覆訊息 id'),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
}, async ({ message, to, reply_to }) => {
  try {
    requireJoined();
    const mentions = (to || ['everyone']).map((t) => (/^(everyone|all|room)$/i.test(t) ? 'room' : t));
    const r = await api(`/rooms/${session.roomId}/messages`, 'POST', { body: message, mentions, replyTo: reply_to });
    return ok({ id: r.id, seq: r.seq });
  } catch (e) { return fail(e.message); }
});

server.registerTool('agora_view_session', {
  title: '看聊天室（整個對話）',
  description: `查看聊天室目前的對話內容（含所有人之間的訊息）。每則都有 id，可拿去 agora_search_context 追脈絡。\nArgs: since(從此 seq 之後，預設 0 從頭), limit(1-200，預設 50)\nReturns: { count, messages:[{id,seq,from,kind,message,to,reply_to,at}] }`,
  inputSchema: {
    since: z.number().int().min(0).default(0).describe('從此 seq 之後'),
    limit: z.number().int().min(1).max(200).default(50).describe('最多回傳則數'),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
}, async ({ since, limit }) => {
  try {
    requireJoined();
    const rows = await api(`/rooms/${session.roomId}/messages?since=${since}`);
    const messages = rows.slice(0, limit).map(shape);
    return ok({ count: messages.length, messages });
  } catch (e) { return fail(e.message); }
});

server.registerTool('agora_check_inbox', {
  title: '看有沒有人找我',
  description: `取自上次查看後所有「@我 或廣播」的新訊息（離線期間也補得齊，不斷層），看完游標推進。用來輪詢有沒有人需要我回應。\nArgs: mark_read(預設 true)\nReturns: { count, lastSeq, messages:[{id,seq,from,kind,message,to,at}] }`,
  inputSchema: { mark_read: z.boolean().default(true).describe('是否推進已讀游標') },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
}, async ({ mark_read }) => {
  try {
    requireJoined();
    const rows = await api(`/inbox?agent=${session.agentId}&since=${session.lastSeq}`);
    session.inbox = [];
    const messages = rows.map(shape);
    const maxSeq = messages.reduce((a, m) => Math.max(a, m.seq), session.lastSeq);
    if (mark_read && messages.length) {
      session.lastSeq = maxSeq;
      await api('/cursor', 'POST', { roomId: session.roomId, agentId: session.agentId, seq: maxSeq }).catch(() => {});
    }
    let out = { count: messages.length, lastSeq: session.lastSeq, messages };
    let text = JSON.stringify(out, null, 2);
    if (text.length > CHARACTER_LIMIT) { out = { ...out, messages: messages.slice(0, 20), truncated: true }; text = JSON.stringify(out, null, 2); }
    return ok(out, text);
  } catch (e) { return fail(e.message); }
});

server.registerTool('agora_search_context', {
  title: '用 id 查訊息脈絡',
  description: `給一則訊息的 id，回傳它本身 + 它回覆的上文鏈 + 對它的回覆 + 引用它的訊息。用來把某則訊息的來龍去脈補齊。\nArgs: id(訊息 id，從 view_session / check_inbox 取得)\nReturns: { message, ancestors:[...], replies:[...], related:[...] }`,
  inputSchema: { id: z.string().min(8, 'id 不正確').describe('訊息 id') },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
}, async ({ id }) => {
  try {
    requireJoined();
    const ctx = await api(`/context/${id}`);
    return ok({ message: shape(ctx.message), ancestors: ctx.ancestors.map(shape), replies: ctx.replies.map(shape), related: ctx.related.map(shape) });
  } catch (e) { return fail(e.message); }
});

server.registerTool('agora_list_members', {
  title: '列出聊天室成員',
  description: `列出聊天室成員與在線狀態，決定要對誰說話。\nReturns: { count, members:[{id,name,kind,host,status}] }（status: online|away|gone）`,
  inputSchema: {},
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
}, async () => {
  try {
    requireJoined();
    const rows = await api(`/rooms/${session.roomId}/members`);
    return ok({ count: rows.length, members: rows.map((m) => ({ id: m.id, name: m.name, kind: m.kind, host: m.host, status: m.status })) });
  } catch (e) { return fail(e.message); }
});

server.registerTool('agora_status', {
  title: '連線狀態',
  description: '回報加入/連線狀態。Returns: { joined, connected, agentId, roomId, hubUrl, lastSeq }',
  inputSchema: {},
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async () => ok({ joined: !!session.token, connected: session.connected, agentId: session.agentId, roomId: session.roomId, hubUrl: session.restUrl, lastSeq: session.lastSeq }));

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[agora-mcp] stdio ready (hub 預設 ${session.restUrl}，可由 agora_join 的 hub_url 覆蓋)`);
