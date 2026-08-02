import { ZodError } from 'zod';

export type ErrorDetail = {
  path: string;
  message: string;
};

export class AppError extends Error {
  public constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: readonly ErrorDetail[],
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function fromZodError(error: ZodError): AppError {
  return new AppError(
    400,
    'VALIDATION_ERROR',
    'request validation failed',
    error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    })),
  );
}

type PostgresError = Error & { code?: string };

export function normalizeError(error: unknown): AppError {
  if (error instanceof AppError) {
    return error;
  }
  if (error instanceof ZodError) {
    return fromZodError(error);
  }
  if (error instanceof SyntaxError) {
    return new AppError(400, 'INVALID_JSON', 'request body must contain valid JSON');
  }
  if (error instanceof Error && (error as PostgresError).code === '23505') {
    return new AppError(409, 'CONFLICT', 'resource already exists');
  }
  return new AppError(500, 'INTERNAL_ERROR', 'an unexpected error occurred');
}
