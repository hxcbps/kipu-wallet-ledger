import type { Context } from 'aws-lambda';
import { z } from 'zod';
import { getPool } from '../db/pool.js';
import { parseJsonBody, requiredHeader } from '../http/request.js';
import { httpHandler, jsonResponse } from '../http/response.js';
import { createTransfer } from '../services/transfers.js';

const transferSchema = z.object({
  sourceAccountId: z.uuid(),
  destinationAccountId: z.uuid(),
  amount: z.string(),
}).strict();

const idempotencyKeySchema = z.string()
  .min(1)
  .max(128)
  .regex(/^[\x21-\x7E]+$/, 'must contain only visible ASCII characters without spaces');

function correlationId(requestId: string, context: Context): string {
  return requestId || context.awsRequestId;
}

export const create = httpHandler(async (event, context) => {
  const payload = transferSchema.parse(parseJsonBody(event));
  const idempotencyKey = idempotencyKeySchema.parse(
    requiredHeader(event, 'Idempotency-Key'),
  );
  const result = await createTransfer(getPool(), { ...payload, idempotencyKey });
  return jsonResponse(
    result.statusCode,
    result.body,
    correlationId(event.requestContext.requestId, context),
  );
});
