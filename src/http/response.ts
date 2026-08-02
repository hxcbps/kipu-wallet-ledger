import type {
  APIGatewayProxyHandlerV2,
  APIGatewayProxyStructuredResultV2,
  Context,
  APIGatewayProxyEventV2,
} from 'aws-lambda';
import { normalizeError } from '../lib/errors.js';
import { log } from '../lib/logger.js';

export function jsonResponse(
  statusCode: number,
  body: unknown,
  correlationId: string,
): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'x-correlation-id': correlationId,
    },
    body: JSON.stringify(body),
  };
}

type HttpOperation = (
  event: APIGatewayProxyEventV2,
  context: Context,
) => Promise<APIGatewayProxyStructuredResultV2>;

export function httpHandler(operation: HttpOperation): APIGatewayProxyHandlerV2 {
  return async (event, context) => {
    const correlationId = event.requestContext.requestId || context.awsRequestId;
    const startedAt = Date.now();
    try {
      const response = await operation(event, context);
      log('info', 'request.completed', {
        correlationId,
        routeKey: event.routeKey,
        statusCode: response.statusCode,
        durationMs: Date.now() - startedAt,
      });
      return response;
    } catch (error: unknown) {
      const normalized = normalizeError(error);
      log(normalized.statusCode >= 500 ? 'error' : 'warn', 'request.failed', {
        correlationId,
        routeKey: event.routeKey,
        statusCode: normalized.statusCode,
        errorCode: normalized.code,
        durationMs: Date.now() - startedAt,
      });
      return jsonResponse(
        normalized.statusCode,
        {
          error: {
            code: normalized.code,
            message: normalized.message,
            ...(normalized.details === undefined ? {} : { details: normalized.details }),
            correlationId,
          },
        },
        correlationId,
      );
    }
  };
}
