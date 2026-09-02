/**
 * The shared error envelope contract.
 *
 * Everything a client branches on is asserted here rather than in nine separate
 * service suites: the stable code, the retryable flag, the retry hint, and the
 * guarantee that an unresolved message key never reaches a user as a literal
 * identifier.
 */
import {
  API_ERROR_CODES,
  AppError,
  BadRequestError,
  ConflictError,
  ForbiddenError,
  GoneError,
  NotFoundError,
  ServiceUnavailableError,
  TooManyRequestsError,
  UnauthorizedError,
  isRetryableStatus,
  resolveErrorCode,
} from "@aimess/errors";
import { buildApiError, describeError } from "@aimess/utils";

describe("resolveErrorCode", () => {
  it.each([
    [400, "BAD_REQUEST"],
    [401, "UNAUTHORIZED"],
    [403, "FORBIDDEN"],
    [404, "NOT_FOUND"],
    [408, "TIMEOUT"],
    [409, "CONFLICT"],
    [410, "GONE"],
    [413, "PAYLOAD_TOO_LARGE"],
    [415, "UNSUPPORTED_MEDIA_TYPE"],
    [422, "VALIDATION_FAILED"],
    [429, "RATE_LIMITED"],
    [503, "SERVICE_UNAVAILABLE"],
    [504, "TIMEOUT"],
  ])("maps %i to %s", (status, code) => {
    expect(resolveErrorCode(status)).toBe(code);
  });

  it("falls back by class for unmapped statuses", () => {
    expect(resolveErrorCode(418)).toBe("BAD_REQUEST");
    expect(resolveErrorCode(507)).toBe("SERVER_ERROR");
  });

  it("only ever emits a declared code", () => {
    const declared = new Set<string>(API_ERROR_CODES);
    for (let status = 400; status <= 599; status += 1) {
      expect(declared.has(resolveErrorCode(status))).toBe(true);
    }
  });
});

describe("isRetryableStatus", () => {
  it("treats throttles, timeouts and server faults as transient", () => {
    for (const status of [408, 429, 500, 502, 503, 504]) {
      expect(isRetryableStatus(status)).toBe(true);
    }
  });

  it("never marks a client error retryable — it will fail identically forever", () => {
    for (const status of [400, 401, 403, 404, 409, 410, 413, 415, 422]) {
      expect(isRetryableStatus(status)).toBe(false);
    }
  });
});

describe("AppError hierarchy", () => {
  it.each([
    [new BadRequestError("VALIDATION_FAILED"), 400],
    [new UnauthorizedError("VALIDATION_FAILED"), 401],
    [new ForbiddenError("VALIDATION_FAILED"), 403],
    [new NotFoundError("VALIDATION_FAILED"), 404],
    [new ConflictError("VALIDATION_FAILED"), 409],
    [new GoneError("VALIDATION_FAILED"), 410],
    [new TooManyRequestsError("RATE_LIMITED"), 429],
    [new ServiceUnavailableError("SERVICE_UNAVAILABLE"), 503],
  ])("carries the right status", (error, status) => {
    expect((error as AppError).statusCode).toBe(status);
    expect((error as AppError).isOperational).toBe(true);
  });

  it("carries an optional retryAfterSec on a throttle", () => {
    expect(new TooManyRequestsError("RATE_LIMITED", 7).retryAfterSec).toBe(7);
    // Absent rather than 0, so "unknown" is distinguishable from "retry now".
    expect(
      new TooManyRequestsError("RATE_LIMITED").retryAfterSec
    ).toBeUndefined();
  });
});

describe("buildApiError", () => {
  it("produces the documented 429 envelope", () => {
    const body = buildApiError({
      statusCode: 429,
      locale: "en",
      messageKey: "RATE_LIMITED",
      retryAfterSec: 3,
    });

    expect(body.success).toBe(false);
    expect(body.error.code).toBe("RATE_LIMITED");
    expect(body.error.retryAfter).toBe(3);
    expect(body.error.retryable).toBe(true);
    expect(body.error.message).toBe(
      "You're doing that a little too quickly. Please wait a moment and try again."
    );
  });

  it("keeps the top-level message in step with error.message", () => {
    // The additive migration depends on these never diverging: existing clients
    // read the former, new clients the latter.
    const body = buildApiError({
      statusCode: 503,
      locale: "en",
      messageKey: "SERVICE_UNAVAILABLE",
    });
    expect(body.message).toBe(body.error.message);
  });

  it("localizes per request locale", () => {
    const vi = buildApiError({
      statusCode: 429,
      locale: "vi",
      messageKey: "RATE_LIMITED",
    });
    const th = buildApiError({
      statusCode: 429,
      locale: "th",
      messageKey: "RATE_LIMITED",
    });
    expect(vi.error.message).not.toBe(th.error.message);
    expect(vi.error.message.length).toBeGreaterThan(0);
    expect(th.error.message.length).toBeGreaterThan(0);
  });

  it("never shows a user an unresolved message key", () => {
    // `t()` echoes an unknown key back verbatim. Two throw sites did exactly
    // this and rendered the literal string "RATE_LIMITED" to users.
    const body = buildApiError({
      statusCode: 429,
      locale: "en",
      messageKey: "THIS_KEY_DOES_NOT_EXIST",
      fallbackMessage: "Please slow down.",
    });
    expect(body.error.message).toBe("Please slow down.");
    expect(body.error.message).not.toBe("THIS_KEY_DOES_NOT_EXIST");
  });

  it("omits retryAfter when it is unknown", () => {
    const body = buildApiError({ statusCode: 500, locale: "en" });
    expect(body.error).not.toHaveProperty("retryAfter");
    expect(body.error.retryable).toBe(true);
  });

  it("includes the request id when one is available", () => {
    const body = buildApiError({
      statusCode: 500,
      locale: "en",
      requestId: "req-123",
    });
    expect(body.error.requestId).toBe("req-123");
  });
});

describe("describeError", () => {
  it("reads status, key and retry hint off an AppError", () => {
    expect(describeError(new TooManyRequestsError("RATE_LIMITED", 5))).toEqual({
      statusCode: 429,
      messageKey: "RATE_LIMITED",
      retryAfterSec: 5,
    });
  });

  it("treats anything unrecognized as a 500", () => {
    expect(describeError(new Error("boom"))).toEqual({ statusCode: 500 });
    expect(describeError("not an error")).toEqual({ statusCode: 500 });
  });
});
