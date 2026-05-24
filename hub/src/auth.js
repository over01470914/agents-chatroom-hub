// 鑑權：共享 secret（GUI/人類，全權）或 agent token（配對後）。
import config from './config.js';
import { agentByToken } from './db.js';

function bearer(req) {
  const h = req.headers['authorization'] || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}

// Express middleware：要求共享 secret（GUI/人類專用的全權入口）。
export function requireSecret(req, res, next) {
  if (bearer(req) === config.secret) return next();
  res.status(401).json({ error: 'unauthorized' });
}

// Express middleware：共享 secret 或 有效 agent token 皆可。
// 通過後 req.actor = { kind:'human'|'agent', agent? }。
export function requireActor(req, res, next) {
  const tok = bearer(req);
  if (tok === config.secret) {
    req.actor = { kind: 'human' };
    return next();
  }
  const agent = tok && agentByToken(tok);
  if (agent) {
    req.actor = { kind: 'agent', agent };
    return next();
  }
  res.status(401).json({ error: 'unauthorized' });
}

// WSS 握手：token 來自 query string，回傳 agent 或 null。
export function authWsToken(token) {
  if (!token) return null;
  return agentByToken(token);
}
