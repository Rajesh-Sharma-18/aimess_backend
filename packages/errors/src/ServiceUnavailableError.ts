import { AppError } from "./AppError";

/**
 * 503 — a dependency the request cannot proceed without is down.
 *
 * Distinct from a 500: it tells the client the request was well-formed and is
 * worth retrying. Used where failing open would be a security regression (e.g.
 * the media registry, whose row is what authorizes the download later), so the
 * request must fail rather than continue with a degraded guarantee.
 */
export class ServiceUnavailableError extends AppError {
  constructor(messageKey: string) {
    super(messageKey, 503, messageKey);
  }
}
