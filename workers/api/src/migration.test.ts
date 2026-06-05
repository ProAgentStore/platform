import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migration = readFileSync(join(__dirname, '../migrations/0001_init.sql'), 'utf-8');

describe('D1 migration 0001_init', () => {
  it('creates users table', () => {
    expect(migration).toContain('CREATE TABLE users');
    expect(migration).toContain('id TEXT PRIMARY KEY');
    expect(migration).toContain('github_login TEXT NOT NULL');
    expect(migration).toContain('roles TEXT NOT NULL');
    expect(migration).toContain('stripe_customer_id TEXT');
    expect(migration).toContain('subscription_status TEXT');
  });

  it('creates agents table', () => {
    expect(migration).toContain('CREATE TABLE agents');
    expect(migration).toContain('slug TEXT NOT NULL UNIQUE');
    expect(migration).toContain('owner_id TEXT NOT NULL REFERENCES users(id)');
    expect(migration).toContain('visibility TEXT NOT NULL');
    expect(migration).toContain('cron_schedule TEXT');
    expect(migration).toContain('config TEXT NOT NULL');
  });

  it('creates agent_executions table', () => {
    expect(migration).toContain('CREATE TABLE agent_executions');
    expect(migration).toContain('agent_id TEXT NOT NULL REFERENCES agents(id)');
    expect(migration).toContain('model TEXT NOT NULL');
    expect(migration).toContain('duration_ms INTEGER');
  });

  it('creates usage table', () => {
    expect(migration).toContain('CREATE TABLE usage');
    expect(migration).toContain("event TEXT NOT NULL");
    expect(migration).toContain('metadata TEXT NOT NULL');
  });

  it('creates all required indexes', () => {
    expect(migration).toContain('CREATE INDEX idx_agents_owner');
    expect(migration).toContain('CREATE INDEX idx_agents_category');
    expect(migration).toContain('CREATE INDEX idx_agents_visibility');
    expect(migration).toContain('CREATE INDEX idx_executions_agent');
    expect(migration).toContain('CREATE INDEX idx_executions_user');
    expect(migration).toContain('CREATE INDEX idx_usage_agent');
    expect(migration).toContain('CREATE INDEX idx_usage_payout');
  });

  it('has proper foreign key references', () => {
    const fks = migration.match(/REFERENCES \w+\(\w+\)/g) || [];
    expect(fks).toContain('REFERENCES users(id)');
    expect(fks).toContain('REFERENCES agents(id)');
    expect(fks.length).toBeGreaterThanOrEqual(4);
  });

  it('has no syntax that would break D1', () => {
    // D1 uses SQLite — no SERIAL, no ENUM, no VARCHAR with length
    expect(migration).not.toContain('SERIAL');
    expect(migration).not.toContain('ENUM');
    expect(migration).not.toMatch(/VARCHAR\(\d+\)/);
    expect(migration).not.toContain('BOOLEAN'); // SQLite has no BOOLEAN, use INTEGER
  });
});
