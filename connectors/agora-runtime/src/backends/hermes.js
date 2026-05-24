// Hermes adapter：套用通用 httpAgent。gateway turn 端點由 HERMES_URL 指定。
import { createHttpAgentBackend } from './httpAgent.js';
export function createHermesBackend(opts = {}) {
  return createHttpAgentBackend({
    kind: 'hermes',
    endpoint: opts.endpoint || process.env.HERMES_URL || null,
    sessionKeyPrefix: 'agora:hermes:',
    headers: opts.headers || {},
  });
}
