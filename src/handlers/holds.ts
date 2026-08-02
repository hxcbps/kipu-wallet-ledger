import type { Context } from 'aws-lambda';
import { z } from 'zod';
import { getPool } from '../db/pool.js';
import { parseJsonBody, requiredPathParameter } from '../http/request.js';
import { httpHandler, jsonResponse } from '../http/response.js';
import { captureHold, createHold, releaseHold } from '../services/holds.js';

const createHoldSchema = z.object({
  amount: z.string(),
  expiresAt: z.iso.datetime({ offset: true }),
}).strict();

const uuidSchema = z.uuid();

function correlationId(requestId: string, context: Context): string {
  return requestId || context.awsRequestId;
}

export const create = httpHandler(async (event, context) => {
  const accountId = uuidSchema.parse(requiredPathParameter(event, 'accountId'));
  const payload = createHoldSchema.parse(parseJsonBody(event));
  const hold = await createHold(getPool(), { accountId, ...payload });
  return jsonResponse(
    201,
    { data: hold },
    correlationId(event.requestContext.requestId, context),
  );
});

export const capture = httpHandler(async (event, context) => {
  const holdId = uuidSchema.parse(requiredPathParameter(event, 'holdId'));
  const hold = await captureHold(getPool(), holdId);
  return jsonResponse(
    200,
    { data: hold },
    correlationId(event.requestContext.requestId, context),
  );
});

export const release = httpHandler(async (event, context) => {
  const holdId = uuidSchema.parse(requiredPathParameter(event, 'holdId'));
  const hold = await releaseHold(getPool(), holdId);
  return jsonResponse(
    200,
    { data: hold },
    correlationId(event.requestContext.requestId, context),
  );
});
