#!/usr/bin/env node
// TC-09（預算/摘要降級）+ TC-10（backend 未設 endpoint 的明確失敗）手動/進階驗證。
// 需 hub 已在 --rest 啟動，且 connectors/agora-runtime 已 npm install。
// 用法：node agora-runtime_manual_tc09_tc10.mjs --rest http://127.0.0.1:8787 [--secret dev-secret-change-me]
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

function startRuntime({ state, extra = [], env = {} }) {
  const args = ['--rest', H, '--name', 'OpenClaw-RT', '--kind', 'agent', '--state', state, '--pollMs', '1200', ...extra];
  const p = spawn('node', [RT, ...args], { cwd: RT_CWD, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, ...env } });
  p._log = '';
  p.stderr.on('data', (d) => { const s = d.toString(); p._log += s; process.stdout.write('  [RT] ' + s); });
  return p;
}

(async () => {
  for (let i = 0; i < 30; i++) { try { if ((await api('/health')).ok) break; } catch {} await sleep(300); }

  // ===================== TC-09 預算 / 摘要降級（長 thread）=====================
  console.log('\n=== TC-09 預算 / 摘要降級（長 reply_to 鏈）===');
  {
    const room = (await api('/rooms', 'POST', { name: 'rt-tc09' })).id;
    const inv = await api('/invite', 'POST', { roomId: room, kind: 'agent', purpose: 'tc09' });
    const STATE = path.join(os.tmpdir(), `agora-rt-tc09-${Date.now()}.json`);
    try { fs.unlinkSync(STATE); } catch {}

    // 建一條長 reply_to 鏈當「前文」（皆無 mentions，不進收件匣，只作上文祖先）。
    const CHAIN = 14;
    let prev = null;
    for (let i = 1; i <= CHAIN; i++) {
      const m = await human(room, `前文#${i}：估價背景片段 ${i}（外牆模板、TOL、扣除細項…）。`, [], prev);
      prev = m.id;
    }

    // 用很小的 maxMessages 觸發降級（keepRecent=max(6,floor(8/2))=6）。
    const rt = startRuntime({ state: STATE, extra: ['--backend', 'mock', '--maxMessages', '8', '--code', inv.pairingCode] });
    await sleep(3000);
    const ag = (await api(`/rooms/${room}/members`)).find((m) => m.kind === 'agent');
    // 觸發訊息 reply_to 鏈尾 → thread = 14 祖先 + 觸發 = 15 則 > maxMessages(8)
    const trig = await human(room, '@OpenClaw-RT 綜合上面所有前文，幫我做最後確認。', [ag.id], prev);
    await sleep(4500);

    const all = await api(`/rooms/${room}/messages?since=0`);
    const reply = all.find((m) => m.author_id === ag.id && m.reply_to === trig.id);
    const note = reply ? /前文\s*\d+\s*則已省略/.test(reply.body) : false;
    const ids = reply ? /ids:/.test(reply.body) : false;
    const bounded = reply ? /可見脈絡（(\d+)/.exec(reply.body) : null;
    const threadCount = bounded ? Number(bounded[1]) : null;

    assert('TC-09 有回覆（未丟錯）', !!reply);
    assert('TC-09 出現降級摘要提示「前文 N 則已省略」', note, reply ? reply.body.replace(/\n/g, ' / ').slice(0, 160) : '無回覆');
    assert('TC-09 摘要提示含省略 ids', ids);
    assert('TC-09 thread 被截到上限內（≤ keepRecent 6 + 觸發 ≈ 7）', threadCount !== null && threadCount <= 7, `thread=${threadCount}`);

    rt.kill('SIGKILL');
    try { fs.unlinkSync(STATE); } catch {}
  }

  // ============ TC-10 backend 未設 endpoint 的明確失敗（--backend openclaw）============
  console.log('\n=== TC-10 backend openclaw 未設 OPENCLAW_GATEWAY_URL ===');
  {
    const room = (await api('/rooms', 'POST', { name: 'rt-tc10' })).id;
    const inv = await api('/invite', 'POST', { roomId: room, kind: 'agent', purpose: 'tc10' });
    const STATE = path.join(os.tmpdir(), `agora-rt-tc10-${Date.now()}.json`);
    try { fs.unlinkSync(STATE); } catch {}

    // 明確移除 OPENCLAW_GATEWAY_URL，確保 endpoint 為 null。
    const env = { ...process.env };
    delete env.OPENCLAW_GATEWAY_URL;
    const rt = startRuntime({ state: STATE, env, extra: ['--backend', 'openclaw', '--code', inv.pairingCode] });
    // 子程序 env 已在 startRuntime 內 {...process.env, ...env} 合併，這裡再覆寫一次保險
    await sleep(3000);
    const ag = (await api(`/rooms/${room}/members`)).find((m) => m.kind === 'agent');
    const trig = await human(room, '@OpenClaw-RT 這則會觸發 backend，但沒有 gateway。', [ag.id], null);
    await sleep(4000);

    const all = await api(`/rooms/${room}/messages?since=0`);
    const agentReplied = all.some((m) => m.author_id === ag.id);
    const log = rt._log;
    const hasClearError = /尚未設定 endpoint|OPENCLAW_GATEWAY_URL/.test(log);
    const mentionsReadme = /README/.test(log);

    assert('TC-10 明確錯誤訊息（提示要設的環境變數）', hasClearError);
    assert('TC-10 錯誤訊息參考 README', mentionsReadme);
    assert('TC-10 不默默退回 echo / 不靜默成功（房內無 agent 回覆）', !agentReplied);

    rt.kill('SIGKILL');
    try { fs.unlinkSync(STATE); } catch {}
  }

  console.log(`\n結果：PASS ${pass} / FAIL ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('TEST ERROR', e); process.exit(1); });
