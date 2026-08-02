import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyHandlerV2,
  APIGatewayProxyStructuredResultV2,
  Context,
} from 'aws-lambda';
import { z } from 'zod';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseJsonBody } from '../../src/http/request.js';
import { httpHandler, jsonResponse } from '../../src/http/response.js';
import { AppError } from '../../src/lib/errors.js';

function event(requestId = 'request-123'): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: 'POST /test',
    rawPath: '/test',
    rawQueryString: '',
    headers: {},
    requestContext: {
      accountId: 'local',
      apiId: 'local',
      domainName: 'localhost',
      domainPrefix: 'localhost',
      http: {
        method: 'POST',
        path: '/test',
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 'vitest',
      },
      requestId,
      routeKey: 'POST /test',
      stage: '$default',
      time: '01/Aug/2026:12:00:00 +0000',
      timeEpoch: 1_775_217_600_000,
    },
    isBase64Encoded: false,
  };
}

const context = {
  awsRequestId: 'lambda-456',
} as Context;

async function invoke(
  handler: APIGatewayProxyHandlerV2,
  input = event(),
): Promise<APIGatewayProxyStructuredResultV2> {
  const result = await handler(input, context, () => undefined);
  if (result === undefined || typeof result === 'string') {
    throw new Error('expected a structured HTTP response');
  }
  return result;
}

function parsedBody(response: APIGatewayProxyStructuredResultV2): unknown {
  if (response.body === undefined) {
    throw new Error('expected response body');
  }
  return JSON.parse(response.body) as unknown;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('HTTP responses', () => {
  it('serializes JSON with its correlation header', () => {
    expect(jsonResponse(201, { data: { id: 'account-123' } }, 'request-123')).toEqual({
      statusCode: 201,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'x-correlation-id': 'request-123',
      },
      body: '{"data":{"id":"account-123"}}',
    });
  });

  it('preserves a successful operation response', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const handler = httpHandler(() => Promise.resolve(
      jsonResponse(200, { data: { ok: true } }, 'request-123'),
    ));

    const response = await invoke(handler);

    expect(response.statusCode).toBe(200);
    expect(response.headers).toMatchObject({ 'x-correlation-id': 'request-123' });
    expect(parsedBody(response)).toEqual({ data: { ok: true } });
  });

  it('normalizes an application error into the public error contract', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const handler = httpHandler(() => Promise.reject(
      new AppError(409, 'IDEMPOTENCY_KEY_REUSED', 'key belongs to another payload'),
    ));

    const response = await invoke(handler);

    expect(response.statusCode).toBe(409);
    expect(response.headers).toMatchObject({ 'x-correlation-id': 'request-123' });
    expect(parsedBody(response)).toEqual({
      error: {
        code: 'IDEMPOTENCY_KEY_REUSED',
        message: 'key belongs to another payload',
        correlationId: 'request-123',
      },
    });
  });

  it('maps strict validation failures with field details', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const schema = z.object({ amount: z.string() }).strict();
    const handler = httpHandler(() => {
      schema.parse({ amount: 10, unexpected: true });
      return Promise.resolve(jsonResponse(200, {}, 'request-123'));
    });

    const response = await invoke(handler);
    const body = parsedBody(response);

    expect(response.statusCode).toBe(400);
    expect(body).toMatchObject({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'request validation failed',
        correlationId: 'request-123',
      },
    });
    expect(body).toHaveProperty('error.details');
  });

  it('maps malformed JSON without leaking parser internals', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const input = { ...event(), body: '{invalid' };
    const handler = httpHandler((request) => {
      parseJsonBody(request);
      return Promise.resolve(jsonResponse(200, {}, 'request-123'));
    });

    const response = await invoke(handler, input);

    expect(response.statusCode).toBe(400);
    expect(parsedBody(response)).toEqual({
      error: {
        code: 'INVALID_JSON',
        message: 'request body must contain valid JSON',
        correlationId: 'request-123',
      },
    });
  });

  it('hides unexpected internal error details', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const handler = httpHandler(() => Promise.reject(
      new Error('database password must never be exposed'),
    ));

    const response = await invoke(handler);

    expect(response.statusCode).toBe(500);
    expect(parsedBody(response)).toEqual({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'an unexpected error occurred',
        correlationId: 'request-123',
      },
    });
    expect(response.body).not.toContain('database password');
  });

  it('falls back to the Lambda request id when the gateway id is absent', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const handler = httpHandler(() => Promise.reject(
      new AppError(400, 'INVALID_REQUEST', 'invalid request'),
    ));

    const response = await invoke(handler, event(''));

    expect(response.headers).toMatchObject({ 'x-correlation-id': 'lambda-456' });
    expect(parsedBody(response)).toHaveProperty(
      'error.correlationId',
      'lambda-456',
    );
  });
});
