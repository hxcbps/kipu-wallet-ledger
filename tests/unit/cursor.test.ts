import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor } from '../../src/domain/cursor.js';
import { AppError } from '../../src/lib/errors.js';

describe('ledger cursor', () => {
  it('round-trips a versioned keyset cursor', () => {
    const cursor = {
      v: 1 as const,
      createdAt: '2026-08-01T12:00:00.000Z',
      entryId: '6f03ed88-95b2-4d8e-83c1-84fc6b0ccf15',
    };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it.each([
    'not-base64-json',
    Buffer.from(JSON.stringify({ v: 2 })).toString('base64url'),
    Buffer.from(JSON.stringify({
      v: 1,
      createdAt: 'yesterday',
      entryId: 'not-a-uuid',
    })).toString('base64url'),
  ])('rejects malformed cursor %s', (cursor) => {
    expect(() => decodeCursor(cursor)).toThrow(AppError);
  });
});
