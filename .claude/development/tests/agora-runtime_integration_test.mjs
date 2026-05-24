#!/usr/bin/env node
// agora-runtime 整合測試（TC-01~TC-08）。需 hub 已在 --rest 啟動，且 connectors/agora-runtime 已 npm install。
// 用法：node agora-runtime_integration_test.mjs --rest http://127.0.0.1:8787 [--secret dev-secret-change-me]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RT = path.resolve(__dirname, '../../../connectors/agora-runtime/index.js');
const RT_CWD = path.dirname(RT);

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > -1 ? process.argv[i + 1] : d; };
const H = (arg('rest', 'http://127.0.0.1:8787')).replace(/\/$/, '');
const SECRET = arg('secret', 'dev-secret-change-me');
const STATE = path.join(os.tmpdir(), `agora-rt-test-${Date.now()}.json`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const assert = (name, cond, extra = '') => { (cond ? pass++ : fail++); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`); };

async function api(p, m = 'GET', b, tok = SECRET) {
  const r = await fetch(H + p, { method: m, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok }, body: b ? JSON.stringify(b) : undefined });
  const t = await r.text(); let d; try { d = t ? JSON.parse(t) : {}; } catch { d = { raw: t }; }
  if (!r.ok) throw new Error(`${p} ${r.status} ${JSON.stringify(d)}`);
  return d;
}
const human = (room, body, mentions, replyTo) => api(`/rooms/${room}/messages`, 'POST', { body, mentions, replyTo, authorName: '翰' });
function startRuntime(extra) {
  const args = ['--rest', H, '--name', 'OpenClaw-RT', '--kind', 'agent', '--backend', 'mock', '--state', STATE, '--pollMs', '1200', ...extra];
  const p = spawn('node', [RT, ...args], { cwd: RT_CWD, stdio: ['ignore', 'ignore', 'pipe'] });
  p.stderr.on('data', (d) => process.stdout.write('  [RT] ' + d.toString()));
  return p;
}
const transcript = async (room) => (await api(`/rooms/${room}/messages?since=0`))
  .map((m) => `#${m.seq} ${m.author_name}[${m.author_kind}] to=${JSON.stringify(m.mentions)} reply_to=${m.reply_to ? m.reply_to.slice(0, 8) : '-'} relates=${m.relates ? m.relates.length : 0}: ${String(m.body).replace(/\n/g, ' / ').slice(0, 80)}`)
  .join('\n');

(async () => {
  for (let i = 0; i < 30; i++) { try { if ((await api('/health')).ok) break; } catch {} await sleep(300); }
  try { fs.unlinkSync(STATE); } catch {}
  const room = (await api('/rooms', 'POST', { name: 'rt-integration' })).id;
  const inv = await api('/invite', 'POST', { roomId: room, kind: 'agent', purpose: 'integration test' });

  const bg = await human(room, '背景：2F A棟樓高 340，外牆 TOL 200，這次只估外牆模板。', [], null);
  let rt = startRuntime(['--code', inv.pairingCode]);
  await sleep(3000);
  const ag = (await api(`/rooms/${room}/members`)).find((m) => m.kind === 'agent');
  const q1 = await human(room, '@OpenClaw-RT 依上面的背景，外牆模板扣除原則幫我確認一下。', [ag.id], bg.id);
  await sleep(4000);

  let all = await api(`/rooms/${room}/messages?since=0`);
  const reply1 = all.find((m) => m.author_id === ag.id);
  assert('TC-01 被 @ 後喚醒並回覆', !!reply1);
  assert('TC-02 組裝撈到 reply_to 上文', !!reply1 && /可見脈絡（2/.test(reply1.body));
  assert('TC-03a reply_to == 觸發訊息', !!reply1 && reply1.reply_to === q1.id);
  assert('TC-03b relates 含背景訊息(出處)', !!reply1 && (reply1.relates || []).includes(bg.id), `relates=${JSON.stringify((reply1 && reply1.relates) || [])}`);
  assert('TC-04 人類觸發→回 @room', !!reply1 && reply1.mentions.includes('room'));

  // TC-05 降噪：發一則 @別人(不存在的 id) + 一則自己無關，確認 agent 不回應它們
  const other = await human(room, '@somebody-else 這則不是給 RT 的。', ['00000000-0000-0000-0000-000000000000'], null);
  await sleep(2500);
  all = await api(`/rooms/${room}/messages?since=0`);
  const repliedToOther = all.some((m) => m.author_id === ag.id && m.reply_to === other.id);
  assert('TC-05 收件匣降噪(不理 @別人)', !repliedToOther);

  // 重啟測試
  rt.kill('SIGKILL'); await sleep(800);
  const st = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  assert('TC-06 憑證持久(state 含同一 agentId)', st.agentId === ag.id);
  const q2 = await human(room, '@OpenClaw-RT 停機期間補一題：柱牆接頭要不要扣？', [ag.id], null);
  rt = startRuntime([]); await sleep(4500);
  all = await api(`/rooms/${room}/messages?since=0`);
  const agentReplies = all.filter((m) => m.author_id === ag.id);
  assert('TC-06 重連同一 agentId(無新成員)', agentReplies.every((m) => m.author_id === ag.id));
  assert('TC-07 不斷層補齊停機期間提問', agentReplies.some((m) => m.reply_to === q2.id));
  assert('TC-08 恰好一次(不重複處理 q1)', agentReplies.filter((m) => m.reply_to === q1.id).length === 1);

  console.log('\n--- final transcript ---\n' + await transcript(room));
  rt.kill('SIGKILL');
  console.log(`\n結果：PASS ${pass} / FAIL ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('TEST ERROR', e); process.exit(1); });
