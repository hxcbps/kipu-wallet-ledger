import type { Context } from 'aws-lambda';
import { z } from 'zod';
import { getPool } from '../db/pool.js';
import { requiredPathParameter } from '../http/request.js';
import { httpHandler, jsonResponse } from '../http/response.js';
import { listLedgerEntries } from '../services/ledger.js';

const uuidSchema = z.uuid();
const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).optional(),
}).strict();

function correlationId(requestId: string, context: Context): string {
  return requestId || context.awsRequestId;
}

export const list = httpHandler(async (event, context) => {
  const accountId = uuidSchema.parse(requiredPathParameter(event, 'accountId'));
  const query = querySchema.parse({
    limit: event.queryStringParameters?.limit,
    cursor: event.queryStringParameters?.cursor,
  });
  const page = await listLedgerEntries(getPool(), {
    accountId,
    limit: query.limit,
    ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
  });
  return jsonResponse(
    200,
    page,
    correlationId(event.requestContext.requestId, context),
  );
});
