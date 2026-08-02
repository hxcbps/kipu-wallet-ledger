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
