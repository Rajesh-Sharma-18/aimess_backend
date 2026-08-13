import { AppError } from "./AppError";

export class TooManyRequestsError extends AppError {
  /**
   * @param retryAfterSec seconds until the limiter window reopens. Surfaced as
   * the `Retry-After` header and `error.retryAfter`, so a client can wait the
   * real amount instead of guessing — omitting it is what forces clients into
   * blind exponential backoff.
   */
  constructor(messageKey: string, retryAfterSec?: number) {
    super(messageKey, 429, messageKey, retryAfterSec);
  }
}
