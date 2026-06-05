import { describe, it, expect } from 'vitest';

describe('agent slug validation', () => {
  const SLUG_RE = /^[a-z0-9-]+$/;

  it('accepts valid slugs', () => {
    expect(SLUG_RE.test('my-agent')).toBe(true);
    expect(SLUG_RE.test('summarizer')).toBe(true);
    expect(SLUG_RE.test('code-explainer-v2')).toBe(true);
    expect(SLUG_RE.test('a')).toBe(true);
    expect(SLUG_RE.test('123')).toBe(true);
  });

  it('rejects invalid slugs', () => {
    expect(SLUG_RE.test('My-Agent')).toBe(false);    // uppercase
    expect(SLUG_RE.test('my agent')).toBe(false);     // space
    expect(SLUG_RE.test('my_agent')).toBe(false);     // underscore
    expect(SLUG_RE.test('my.agent')).toBe(false);     // dot
    expect(SLUG_RE.test('')).toBe(false);             // empty
    expect(SLUG_RE.test('café')).toBe(false);         // accented
  });
});

describe('agent update allowed fields', () => {
  const allowed = ['name', 'description', 'category', 'icon', 'icon_bg', 'model', 'visibility', 'cron_schedule'];

  it('includes expected fields', () => {
    expect(allowed).toContain('name');
    expect(allowed).toContain('description');
    expect(allowed).toContain('model');
    expect(allowed).toContain('visibility');
    expect(allowed).toContain('cron_schedule');
  });

  it('excludes dangerous fields', () => {
    expect(allowed).not.toContain('id');
    expect(allowed).not.toContain('owner_id');
    expect(allowed).not.toContain('slug');          // slug is immutable after creation
    expect(allowed).not.toContain('created_at');
    expect(allowed).not.toContain('worker_name');   // infra-managed
  });
});

describe('agent update SQL builder', () => {
  it('builds correct parameter numbering', () => {
    // Simulate the route's SQL builder logic
    const body: Record<string, unknown> = { name: 'New Name', description: 'Updated desc' };
    const allowed = ['name', 'description', 'category', 'icon', 'icon_bg', 'model', 'visibility', 'cron_schedule'];
    const sets: string[] = ["updated_at = datetime('now')"];
    const params: unknown[] = [];

    for (const key of allowed) {
      if (body[key] !== undefined) {
        params.push(body[key]);
        sets.push(`${key} = ?${params.length + 1}`);
      }
    }

    params.unshift('agent-id'); // ?1 = id

    expect(params).toEqual(['agent-id', 'New Name', 'Updated desc']);
    expect(sets).toEqual([
      "updated_at = datetime('now')",
      'name = ?2',
      'description = ?3',
    ]);

    const sql = `UPDATE agents SET ${sets.join(', ')} WHERE id = ?1`;
    expect(sql).toBe("UPDATE agents SET updated_at = datetime('now'), name = ?2, description = ?3 WHERE id = ?1");
  });

  it('handles single field update', () => {
    const body: Record<string, unknown> = { visibility: 'published' };
    const allowed = ['name', 'description', 'category', 'icon', 'icon_bg', 'model', 'visibility', 'cron_schedule'];
    const sets: string[] = ["updated_at = datetime('now')"];
    const params: unknown[] = [];

    for (const key of allowed) {
      if (body[key] !== undefined) {
        params.push(body[key]);
        sets.push(`${key} = ?${params.length + 1}`);
      }
    }
    params.unshift('agent-id');

    expect(params).toEqual(['agent-id', 'published']);
    expect(sets[1]).toBe('visibility = ?2');
  });
});
