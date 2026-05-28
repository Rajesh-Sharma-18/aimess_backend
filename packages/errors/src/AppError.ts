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

  constructor(message: string, statusCode = 500, messageKey?: string) {
    super(message);

    this.statusCode = statusCode;
    this.messageKey = messageKey;
    this.isOperational = true;

    Error.captureStackTrace(this, this.constructor);
  }
}
