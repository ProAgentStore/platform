import { describe, it, expect } from 'vitest';
import { initPro } from './pro.js';

describe('@proagentstore/sdk', () => {
  it('initPro throws until Phase 3 implementation', () => {
    expect(() => initPro({ agentId: 'test' })).toThrow('not yet implemented');
  });
});
