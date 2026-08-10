import { timingSafeEqual } from "node:crypto";
import * as grpc from "@grpc/grpc-js";
import CircuitBreaker from "opossum";
import { logger } from "@aimess/logger";
import {
  currentLocale,
  resolveLocale,
  runWithLocale,
  type SupportedLocale,
} from "@aimess/constants";

// ─── Service-to-service auth ────────────────────────────────────────────────
// Internal gRPC previously trusted whatever `userId`/`requesterId` the caller
// put in the request body, so anything that could reach a gRPC port could act
// as any user (post comments, force-end streams, read private data). This is a
// shared bearer token every service attaches on egress and validates on
// ingress.
//
// ponytail: shared static token, not mTLS. mTLS means cert generation,
// distribution, rotation and renewal across 8 services — a large standing cost
// for a control that today only guards an internal network. Upgrade path: swap
// `verifyServiceToken` for a cert check and issue per-service certs, if the
// gRPC ports are ever exposed beyond the trusted network or per-caller
// identity (not just "is an AIMess service") becomes required.
//
// Read straight from `process.env` rather than a zod-validated env module: this
// is a shared package imported by every service, so it cannot depend on any one
// service's env schema. Each service calls `dotenv.config()` in its own
// `config/env.ts`, which is imported before any gRPC wiring runs.
const SERVICE_TOKEN_METADATA_KEY = "x-aimess-service-token";

/**
 * The `x-lang` request header, carried across the internal gRPC hop. A callee
 * that renders user-facing copy (chat-service system lines, community previews)
 * needs the ORIGINAL caller's language, and gRPC metadata is the direct
 * analogue of the HTTP header it came from — so no request message has to grow
 * a `locale` field and no proto has to change.
 */
const LOCALE_METADATA_KEY = "x-lang";

const serviceToken = (): string => process.env.GRPC_SERVICE_TOKEN ?? "";

/** Constant-time compare of two possibly-different-length strings. */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Still run a comparison so the branch takes comparable time either way.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/**
 * Outgoing call metadata carrying the service token. Omits the header entirely
 * when no token is configured, so a token-less dev environment keeps working
 * against a token-less callee (see {@link withServiceAuth} for the matching
 * ingress rule).
 */
function serviceCallMetadata(locale?: SupportedLocale): grpc.Metadata {
  const metadata = new grpc.Metadata();
  const token = serviceToken();
  if (token) metadata.set(SERVICE_TOKEN_METADATA_KEY, token);
  metadata.set(LOCALE_METADATA_KEY, locale ?? currentLocale());
  return metadata;
}

/**
 * Wrap a gRPC service implementation so every handler rejects callers that
 * don't present the shared service token.
 *
 * Enforcement rules:
 *  - `GRPC_SERVICE_TOKEN` set → every call must carry a matching token.
 *  - unset + `NODE_ENV=production` → **throws at startup**. Booting a
 *    production gRPC server that silently accepts anonymous calls is the exact
 *    failure this closes, so it fails fast and loud instead of pretending to
 *    be protected.
 *  - unset + any other NODE_ENV → logs a warning and passes calls through, so
 *    local dev doesn't need the var set across all 8 services to run.
 */
export function withServiceAuth<T extends grpc.UntypedServiceImplementation>(
  serviceName: string,
  impl: T
): T {
  const expected = serviceToken();

  if (!expected) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        `${serviceName}: GRPC_SERVICE_TOKEN is required in production — refusing to start an unauthenticated gRPC server.`
      );
    }
    logger.warn(
      `${serviceName}: GRPC_SERVICE_TOKEN not set — internal gRPC auth is DISABLED (development only).`
    );
  }

  const wrapped: grpc.UntypedServiceImplementation = {};
  for (const [methodName, handler] of Object.entries(impl)) {
    wrapped[methodName] = (
      call: {
        metadata?: grpc.Metadata;
        emit?: (e: string, a: unknown) => void;
      },
      callback?: grpc.sendUnaryData<unknown>
    ) => {
      if (expected) {
        const raw = call.metadata?.get(SERVICE_TOKEN_METADATA_KEY)[0];
        const provided =
          typeof raw === "string" ? raw : (raw?.toString() ?? "");

        if (!provided || !safeEqual(provided, expected)) {
          logger.warn(
            `${serviceName}.${methodName}: rejected gRPC call with missing/invalid service token`
          );
          const err = {
            code: grpc.status.UNAUTHENTICATED,
            details: "Invalid or missing service token",
          };
          // Unary / client-streaming handlers report via the callback; server-
          // streaming and bidi handlers have no callback and must error on the
          // call stream instead.
          if (typeof callback === "function")
            callback(err as grpc.ServiceError);
          else call.emit?.("error", err);
          return;
        }
      }

      // Publish the caller's language for the whole handler (and everything it
      // awaits) so downstream serializers can localize without every signature
      // between here and them growing a `locale` parameter.
      runWithLocale(localeFromMetadata(call.metadata), () =>
        (handler as (c: unknown, cb?: unknown) => void)(call, callback)
      );
    };
  }
  return wrapped as T;
}

/** Read `x-lang` off an inbound call's metadata; falls back to the default locale. */
export function localeFromMetadata(
  metadata: grpc.Metadata | undefined
): SupportedLocale {
  const raw = metadata?.get(LOCALE_METADATA_KEY)[0];
  const value = typeof raw === "string" ? raw : raw?.toString();
  return resolveLocale(null, value ?? null);
}

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
        (
          r: TReq,
          metadata: grpc.Metadata,
          cb: (e: grpc.ServiceError | null, res: TRes) => void
        ) => void
      >
    )[method](req, serviceCallMetadata(), (err, res) => {
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
          metadata: grpc.Metadata,
          options: grpc.CallOptions,
          cb: (e: grpc.ServiceError | null, res: TRes) => void
        ) => void
      >
    )[method](req, serviceCallMetadata(), { deadline }, (err, res) => {
      if (err) reject(err);
      else resolve(res);
    });
  });
}
