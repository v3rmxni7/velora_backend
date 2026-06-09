export interface AppErrorOptions {
  statusCode?: number;
  code?: string;
}

/** Typed application error with an HTTP status + machine-readable code. */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(message: string, options: AppErrorOptions = {}) {
    super(message);
    this.name = 'AppError';
    this.statusCode = options.statusCode ?? 500;
    this.code = options.code ?? 'internal_error';
  }
}
