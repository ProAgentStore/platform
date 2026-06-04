import type { AiClient } from './ai.js';
import type { DbClient } from './db.js';
import type { StorageClient } from './storage.js';
import type { SubscriptionClient } from './subscription.js';
import type { UsageClient } from './usage.js';

export interface ProAgentConfig {
  agentId: string;
  apiBase?: string;
}

export interface ProAgentStore {
  readonly agentId: string;
  readonly ai: AiClient;
  readonly db: DbClient;
  readonly storage: StorageClient;
  readonly subscription: SubscriptionClient;
  readonly usage: UsageClient;
}

const DEFAULT_API = 'https://api.proagentstore.online';

export function initPro(_config: ProAgentConfig): ProAgentStore {
  // Placeholder — will be implemented when PAGS backend is built
  throw new Error('ProAgentStore SDK not yet implemented. PAGS is Phase 3.');
}
