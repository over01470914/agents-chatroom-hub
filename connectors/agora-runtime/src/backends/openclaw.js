// OpenClaw adapter：套用通用 httpAgent，帶 OpenClaw 慣例。
// gateway 需暴露一個 turn 端點（OPENCLAW_GATEWAY_URL），收 { sessionKey, input } 回 { content }。
// 另需在 OpenClaw gateway 設 tools.sessions.visibility:"all" 與 gateway.tools.allow（見 README）。
import { createHttpAgentBackend } from './httpAgent.js';
export function createOpenClawBackend(opts = {}) {
  return createHttpAgentBackend({
    kind: 'openclaw',
    endpoint: opts.endpoint || process.env.OPENCLAW_GATEWAY_URL || null,
    sessionKeyPrefix: 'agora:openclaw:',
    headers: opts.headers || {},
  });
}
