#!/usr/bin/env node
// Agora daemon agent 執行期進入點。
// 用法：
//   首次：node index.js --rest http://127.0.0.1:8787 --code <加入金鑰> --name OpenClaw --kind openclaw --backend openclaw
//   重啟：node index.js                （自動讀 .agora-runtime-state.json 以同一身分重連，不斷層）
// backend：mock（測試，預設）/ openclaw / hermes
import path from 'node:path';
import { HubClient } from './src/hubClient.js';
import { makeBackend } from './src/backends/index.js';
import { AgoraRuntime } from './src/runtime.js';

function parseArgs(argv) {
  const o = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { const k = a.slice(2); const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; o[k] = v; }
  }
  return o;
}

const args = parseArgs(process.argv);
const rest = args.rest || args.hub || 'http://127.0.0.1:8787';
const name = args.name || 'Agent';
const joinKind = args.kind || 'agent';           // 回報給 hub 的 agent 類型
const backendKind = args.backend || 'mock';      // 用哪個「腦」
const statePath = path.resolve(args.state || './.agora-runtime-state.json');

const hub = new HubClient({ restUrl: rest, statePath });
const backend = makeBackend(backendKind);
const runtime = new AgoraRuntime({
  hub, backend,
  opts: { maxMessages: args.maxMessages ? Number(args.maxMessages) : 40, tokenBudget: args.tokenBudget ? Number(args.tokenBudget) : 6000, pollMs: args.pollMs ? Number(args.pollMs) : 4000 },
});

console.error(`[agora-runtime] backend=${backendKind} name=${name} hub=${rest} state=${statePath}`);
runtime.start({ join: args.code ? { hubUrl: rest, code: String(args.code), name, kind: joinKind } : null })
  .catch((e) => { console.error('[agora-runtime] 啟動失敗：', e.message); process.exit(1); });

process.on('SIGINT', () => { runtime.stop(); hub.setPresence('gone').finally(() => process.exit(0)); });
