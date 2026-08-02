import { z } from 'zod';
import { AppError } from '../lib/errors.js';

const cursorPayloadSchema = z.object({
  v: z.literal(1),
  createdAt: z.iso.datetime({ offset: true }),
  entryId: z.uuid(),
}).strict();

export type LedgerCursor = z.infer<typeof cursorPayloadSchema>;

export function encodeCursor(cursor: LedgerCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeCursor(value: string): LedgerCursor {
  try {
    const json: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    return cursorPayloadSchema.parse(json);
  } catch {
    throw new AppError(400, 'INVALID_CURSOR', 'cursor is malformed or unsupported');
  }
}
