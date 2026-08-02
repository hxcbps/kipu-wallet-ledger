import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { describe, expect, it } from 'vitest';
import {
  parseJsonBody,
  requiredHeader,
  requiredPathParameter,
} from '../../src/http/request.js';
import { AppError } from '../../src/lib/errors.js';

function event(
  overrides: Partial<APIGatewayProxyEventV2> = {},
): APIGatewayProxyEventV2 {
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
      requestId: 'request-123',
      routeKey: 'POST /test',
      stage: '$default',
      time: '01/Aug/2026:12:00:00 +0000',
      timeEpoch: 1_775_217_600_000,
    },
    isBase64Encoded: false,
    ...overrides,
  };
}

function expectAppError(
  operation: () => unknown,
  expectedCode: string,
): void {
  try {
    operation();
    throw new Error('expected operation to fail');
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(expectedCode);
  }
}

describe('HTTP request parsing', () => {
  it('parses a JSON request body', () => {
    expect(parseJsonBody(event({ body: '{"amount":"10.00"}' }))).toEqual({
      amount: '10.00',
    });
  });

  it('decodes a base64-encoded JSON body', () => {
    const body = Buffer.from('{"owner":"Dayan"}', 'utf8').toString('base64');
    expect(parseJsonBody(event({ body, isBase64Encoded: true }))).toEqual({
      owner: 'Dayan',
    });
  });

  it.each([undefined, ''])('rejects a missing body represented by %s', (body) => {
    expectAppError(
      () => parseJsonBody(event(body === undefined ? {} : { body })),
      'MISSING_BODY',
    );
  });

  it('leaves malformed JSON as a syntax error for centralized normalization', () => {
    expect(() => parseJsonBody(event({ body: '{invalid' }))).toThrow(SyntaxError);
  });

  it('finds headers case-insensitively and trims their value', () => {
    expect(requiredHeader(event({
      headers: { 'IDEMPOTENCY-KEY': '  retry-123  ' },
    }), 'Idempotency-Key')).toBe('retry-123');
  });

  it.each([
    {},
    { 'idempotency-key': '   ' },
  ])('rejects a missing or blank required header', (headers) => {
    expectAppError(
      () => requiredHeader(event({ headers }), 'Idempotency-Key'),
      'MISSING_HEADER',
    );
  });

  it('returns a required path parameter', () => {
    expect(requiredPathParameter(event({
      pathParameters: { accountId: 'account-123' },
    }), 'accountId')).toBe('account-123');
  });

  it.each([undefined, ''])('rejects a missing path parameter represented by %s', (value) => {
    expectAppError(
      () => requiredPathParameter(event({
        pathParameters: value === undefined ? {} : { accountId: value },
      }), 'accountId'),
      'MISSING_PATH_PARAMETER',
    );
  });
});
