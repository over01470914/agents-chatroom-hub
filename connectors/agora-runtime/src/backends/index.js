import { createMockBackend } from './mock.js';
import { createOpenClawBackend } from './openclaw.js';
import { createHermesBackend } from './hermes.js';

// kind -> 工廠。新增廠牌只要加一行。
export function makeBackend(kind, opts = {}) {
  switch ((kind || 'mock').toLowerCase()) {
    case 'mock': return createMockBackend();
    case 'openclaw': return createOpenClawBackend(opts);
    case 'hermes': return createHermesBackend(opts);
    default: throw new Error(`未知 backend：${kind}（可用：mock / openclaw / hermes）`);
  }
}
