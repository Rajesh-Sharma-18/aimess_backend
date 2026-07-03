import * as grpc from "@grpc/grpc-js";
import CircuitBreaker from "opossum";
import { logger } from "@aimess/logger";

/** Circuit breaker over a single-arg call: `fire(arg)` → `Promise<R>`. */
export type Breaker<T, R> = CircuitBreaker<[T], R>;
/** Circuit breaker over a no-arg call: `fire()` → `Promise<R>`. */
export type NoArgBreaker<R> = CircuitBreaker<[], R>;

export const BREAKER_OPTS = {
  timeout: 2000,
  errorThresholdPercentage: 50,
  resetTimeout: 10000,
  volumeThreshold: 5,
};

/**
 * gRPC status codes that represent a legitimate, well-formed BUSINESS
 * rejection from a healthy callee (bad request, not found, permission
 * denied, conflict, etc.) — the service responded correctly, it just
 * declined this particular request. `INTERNAL`/`UNAVAILABLE`/
 * `DEADLINE_EXCEEDED`/`UNKNOWN`/`CANCELLED`/etc. are deliberately excluded —
 * those DO indicate the callee is unhealthy and must still count toward the
 * breaker and trigger the fallback below.
 */
const BUSINESS_GRPC_STATUS_CODES = new Set<number>([
  grpc.status.INVALID_ARGUMENT,
  grpc.status.NOT_FOUND,
  grpc.status.ALREADY_EXISTS,
  grpc.status.PERMISSION_DENIED,
  grpc.status.FAILED_PRECONDITION,
  grpc.status.OUT_OF_RANGE,
  grpc.status.UNAUTHENTICATED,
]);

/**
 * opossum's default `errorFilter` is `() => false` — i.e. NOTHING is
 * filtered, so every rejection (a genuine business error exactly as much as
 * a real network failure) counts as a circuit failure and unconditionally
 * triggers `.fallback()`, which replaces the original error with a generic
 * "<name> unavailable" `Error` that has no gRPC `code`/`details` at all.
 * That silently destroys a callee's carefully mapped AppError → gRPC status
 * before it ever reaches the caller, making it impossible to build a
 * meaningful client-facing response (e.g. "message not found" vs "message
 * already deleted") from ANY breaker-wrapped gRPC call.
 *
 * This filter tells opossum "a well-formed business rejection is not a
 * circuit failure" so it passes straight through `reject(error)` with the
 * ORIGINAL error intact (code + details), while true infra failures
 * (no gRPC code, or an infra-only status) still count toward the breaker and
 * still get replaced by the safe generic fallback message.
 */
function isBusinessGrpcError(error: unknown): boolean {
  const code = (error as { code?: number } | null | undefined)?.code;
  return typeof code === "number" && BUSINESS_GRPC_STATUS_CODES.has(code);
}

export function makeBreaker<T, R>(
  name: string,
  fn: (p: T) => Promise<R>,
  breakerOpts?: Partial<CircuitBreaker.Options>
): Breaker<T, R> {
  const breaker = new CircuitBreaker(fn, {
    ...BREAKER_OPTS,
    errorFilter: isBusinessGrpcError,
    ...breakerOpts,
    name,
  });
  breaker.fallback(() => {
    throw new Error(`${name} unavailable`);
  });
  breaker.on("open", () => logger.warn(`Circuit opened: ${name}`));
  breaker.on("halfOpen", () => logger.info(`Circuit half-open: ${name}`));
  return breaker;
}

export function makeBreakerNoArgs<R>(
  name: string,
  fn: () => Promise<R>,
  breakerOpts?: Partial<CircuitBreaker.Options>
): NoArgBreaker<R> {
  const breaker = new CircuitBreaker(fn, {
    ...BREAKER_OPTS,
    errorFilter: isBusinessGrpcError,
    ...breakerOpts,
    name,
  });
  breaker.fallback(() => {
    throw new Error(`${name} unavailable`);
  });
  breaker.on("open", () => logger.warn(`Circuit opened: ${name}`));
  breaker.on("halfOpen", () => logger.info(`Circuit half-open: ${name}`));
  return breaker;
}

export function makeGrpcCall<TReq, TRes>(
  client: grpc.Client,
  method: string,
  req: TReq
): Promise<TRes> {
  return new Promise((resolve, reject) => {
    (
      client as unknown as Record<
        string,
        (r: TReq, cb: (e: grpc.ServiceError | null, res: TRes) => void) => void
      >
    )[method](req, (err, res) => {
      if (err) reject(err);
      else resolve(res);
    });
  });
}

/**
 * Like {@link makeGrpcCall} but applies a per-call deadline (absolute `Date` or
 * relative ms timestamp). Use for clients that need an explicit timeout without
 * a circuit breaker — e.g. graceful-degradation reads that must bound latency
 * yet stay decoupled from the callee's availability.
 */
export function makeGrpcCallWithDeadline<TReq, TRes>(
  client: grpc.Client,
  method: string,
  req: TReq,
  deadline: grpc.Deadline
): Promise<TRes> {
  return new Promise((resolve, reject) => {
    (
      client as unknown as Record<
        string,
        (
          r: TReq,
          options: grpc.CallOptions,
          cb: (e: grpc.ServiceError | null, res: TRes) => void
        ) => void
      >
    )[method](req, { deadline }, (err, res) => {
      if (err) reject(err);
      else resolve(res);
    });
  });
}
