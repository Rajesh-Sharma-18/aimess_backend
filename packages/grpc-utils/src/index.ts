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

export function makeBreaker<T, R>(
  name: string,
  fn: (p: T) => Promise<R>,
  breakerOpts?: Partial<CircuitBreaker.Options>
): Breaker<T, R> {
  const breaker = new CircuitBreaker(fn, {
    ...BREAKER_OPTS,
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
