declare global {
  interface ErrorConstructor {
    /** V8 optional constructor excludes that frame from the trace; value is a function in practice. */
    captureStackTrace(target: object, constructorOpt?: unknown): void;
  }
}

export class AppError extends Error {
  public statusCode: number;

  public isOperational: boolean;

  /** When set, API layer resolves text via `@aimess/constants` `t(key, locale)`. */
  public readonly messageKey?: string;

  /**
   * Seconds the client should wait before retrying. Only meaningful on
   * retryable statuses (429, 503) — the API layer turns it into both the
   * `Retry-After` response header and `error.retryAfter` in the body. Left
   * undefined everywhere else, which is why it is optional rather than 0.
   */
  public readonly retryAfterSec?: number;

  constructor(
    message: string,
    statusCode = 500,
    messageKey?: string,
    retryAfterSec?: number
  ) {
    super(message);

    this.statusCode = statusCode;
    this.messageKey = messageKey;
    this.retryAfterSec = retryAfterSec;
    this.isOperational = true;

    Error.captureStackTrace(this, this.constructor);
  }
}
