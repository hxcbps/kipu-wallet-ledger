import type { Context } from 'aws-lambda';
import { z } from 'zod';
import { getPool } from '../db/pool.js';
import { parseJsonBody, requiredPathParameter } from '../http/request.js';
import { httpHandler, jsonResponse } from '../http/response.js';
import { createAccount, getAccountBalance } from '../services/accounts.js';

const createAccountSchema = z.object({
  owner: z.string().trim().min(1).max(120),
  initialBalance: z.string().default('0.00'),
}).strict();

const accountIdSchema = z.uuid();

function correlationId(requestId: string, context: Context): string {
  return requestId || context.awsRequestId;
}

export const create = httpHandler(async (event, context) => {
  const input = createAccountSchema.parse(parseJsonBody(event));
  const account = await createAccount(getPool(), input);
  return jsonResponse(
    201,
    { data: account },
    correlationId(event.requestContext.requestId, context),
  );
});

export const balance = httpHandler(async (event, context) => {
  const accountId = accountIdSchema.parse(requiredPathParameter(event, 'accountId'));
  const account = await getAccountBalance(getPool(), accountId);
  return jsonResponse(
    200,
    { data: account },
    correlationId(event.requestContext.requestId, context),
  );
});
