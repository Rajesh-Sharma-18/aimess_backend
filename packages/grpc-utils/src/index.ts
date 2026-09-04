import { timingSafeEqual } from "node:crypto";
import * as grpc from "@grpc/grpc-js";
import CircuitBreaker from "opossum";
import { logger } from "@aimess/logger";
import {
  AUDIT_SOURCES,
  currentAuditContext,
  currentLocale,
  isAuditSource,
  resolveLocale,
  runWithAuditContext,
  runWithLocale,
  type AuditSource,
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

/**
 * Which client the in-flight action originated from, carried across the same
 * hop for the same reason as `x-lang`: a message deleted from the Android app
 * reaches chat-service over gRPC from the gateway, and the audit row it writes
 * must say ANDROID — not "the service that happened to call me". Same trust
 * boundary as the service token: only an authenticated service can set it.
 */
const AUDIT_SOURCE_METADATA_KEY = "x-audit-source";

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
  const audit = currentAuditContext();
  if (audit) {
    metadata.set(AUDIT_SOURCE_METADATA_KEY, audit.source);
    if (audit.ip) metadata.set("x-audit-ip", audit.ip);
    if (audit.userAgent) metadata.set("x-audit-user-agent", audit.userAgent);
  }
  return metadata;
}

function metadataValue(
  metadata: grpc.Metadata | undefined,
  key: string
): string | null {
  const raw = metadata?.get(key)[0];
  const value = typeof raw === "string" ? raw : raw?.toString();
  return value?.trim() ? value.trim() : null;
}

/**
 * Service-token values that have appeared in this repository's committed
 * templates. A production deployment using one of them is unauthenticated in
 * practice, because the value is readable by anyone with repo access.
 *
 * Keep every historical value here, not just the current one: the point is to
 * catch an environment that was provisioned from an older template and never
 * rotated.
 */
const PUBLISHED_PLACEHOLDER_SERVICE_TOKENS = new Set([
  "dev-grpc-service-token-change-me",
  "changeme",
  "change-me",
]);

/** True when the configured service token is one this repo has published. */
export function isPublishedPlaceholderToken(token: string): boolean {
  return PUBLISHED_PLACEHOLDER_SERVICE_TOKENS.has(token.trim().toLowerCase());
}

/** Read `x-audit-source` off an inbound call; SYSTEM when the caller sent none. */
export function auditSourceFromMetadata(
  metadata: grpc.Metadata | undefined
): AuditSource {
  const value = metadataValue(metadata, AUDIT_SOURCE_METADATA_KEY);
  return isAuditSource(value) ? value : AUDIT_SOURCES.SYSTEM;
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
 *  - set to a value published in this repository + `NODE_ENV=production` →
 *    **throws at startup**, same as unset. The old check only tested for
 *    emptiness, so a deployment that copied `.env.example` verbatim passed the
 *    fail-fast while authenticating its entire internal mesh with a token
 *    anyone can read out of git.
 */
export function withServiceAuth<T extends grpc.UntypedServiceImplementation>(
  serviceName: string,
  impl: T
): T {
  const expected = serviceToken();

  if (expected && isPublishedPlaceholderToken(expected)) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        `${serviceName}: GRPC_SERVICE_TOKEN is set to a placeholder published in this repository — refusing to start. Generate a real per-environment token.`
      );
    }
    logger.warn(
      `${serviceName}: GRPC_SERVICE_TOKEN is the published placeholder — internal gRPC auth is effectively public (development only).`
    );
  }

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
        runWithAuditContext(
          {
            source: auditSourceFromMetadata(call.metadata),
            ip: metadataValue(call.metadata, "x-audit-ip"),
            userAgent: metadataValue(call.metadata, "x-audit-user-agent"),
          },
          () => (handler as (c: unknown, cb?: unknown) => void)(call, callback)
        )
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
 *
 * `RESOURCE_EXHAUSTED` belongs here for the same reason the rest do: it is
 * what a HEALTHY callee returns when it refuses a request on purpose. Every
 * messaging send is charged against a per-user rate limit whose refusal maps
 * to exactly this status (`assertSendAllowed` -> `TooManyRequestsError` ->
 * RESOURCE_EXHAUSTED), so while it was excluded a throttled burst counted as
 * N infrastructure failures: past the 50% threshold the circuit OPENED and
 * every send through that caller failed for the next 10s, including sends
 * from users who had spent nothing. Worse, the fallback rewrote the status,
 * so the client was told "chat.sendCommunityMessage unavailable" for a plain
 * rate limit and had no `RATE_LIMITED` code and no retry-after to back off
 * on. Measured on a 100-message burst into a community: 28 RESOURCE_EXHAUSTED
 * rejections, all surfaced to the client as `unavailable`.
 */
const BUSINESS_GRPC_STATUS_CODES = new Set<number>([
  grpc.status.INVALID_ARGUMENT,
  grpc.status.NOT_FOUND,
  grpc.status.ALREADY_EXISTS,
  grpc.status.PERMISSION_DENIED,
  grpc.status.FAILED_PRECONDITION,
  grpc.status.OUT_OF_RANGE,
  grpc.status.UNAUTHENTICATED,
  grpc.status.RESOURCE_EXHAUSTED,
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
