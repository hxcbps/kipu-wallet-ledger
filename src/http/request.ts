import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { AppError } from '../lib/errors.js';

export function parseJsonBody(event: APIGatewayProxyEventV2): unknown {
  if (event.body === undefined || event.body === '') {
    throw new AppError(400, 'MISSING_BODY', 'request body is required');
  }
  const body = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : event.body;
  return JSON.parse(body) as unknown;
}

export function requiredPathParameter(
  event: APIGatewayProxyEventV2,
  parameterName: string,
): string {
  const value = event.pathParameters?.[parameterName];
  if (value === undefined || value === '') {
    throw new AppError(400, 'MISSING_PATH_PARAMETER', `${parameterName} is required`);
  }
  return value;
}
