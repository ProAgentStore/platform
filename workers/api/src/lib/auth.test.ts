import { describe, it, expect } from 'vitest';
import { HttpError } from './auth.js';

describe('HttpError', () => {
  it('has status and message', () => {
    const err = new HttpError(401, 'Unauthorized');
    expect(err.status).toBe(401);
    expect(err.message).toBe('Unauthorized');
    expect(err instanceof Error).toBe(true);
  });

  it('works with different status codes', () => {
    expect(new HttpError(400, 'Bad Request').status).toBe(400);
    expect(new HttpError(403, 'Forbidden').status).toBe(403);
    expect(new HttpError(404, 'Not Found').status).toBe(404);
    expect(new HttpError(500, 'Server Error').status).toBe(500);
  });
});
