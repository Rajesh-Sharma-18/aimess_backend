import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Which client an auditable action originated from.
 *
 * Same problem, same solution as the locale context next door: the source is
 * known at ONE edge (the HTTP request / socket handshake) but the code that
 * finally publishes the audit row sits several layers down a service, often
 * behind a gRPC hop. Threading a `source` argument through ~40 publish sites
 * would be a permanently-growing diff for something that behaves exactly like a
 * request header — so it rides an AsyncLocalStorage set once at the edge and is
 * carried across the internal gRPC hop as `x-audit-source` metadata (see
 * `@aimess/grpc-utils`).
 *
 * SYSTEM is what a platform job / consumer / sweeper gets: there was no client.
 */
export const AUDIT_SOURCES = {
  ADMIN_PANEL: "ADMIN_PANEL",
  WEB: "WEB",
  ANDROID: "ANDROID",
  IOS: "IOS",
  SYSTEM: "SYSTEM",
} as const;

export type AuditSource = (typeof AUDIT_SOURCES)[keyof typeof AUDIT_SOURCES];

const AUDIT_SOURCE_VALUES = new Set<string>(Object.values(AUDIT_SOURCES));

/** Server-side allowlist for a client-declared source; anything else is rejected. */
export function isAuditSource(value: unknown): value is AuditSource {
  return typeof value === "string" && AUDIT_SOURCE_VALUES.has(value);
}

// Accepted `x-platform` values. Desktop builds are still the web client, so they
// fold into WEB rather than inventing a source the admin panel can't filter on.
const PLATFORM_TO_SOURCE: Record<string, AuditSource> = {
  android: AUDIT_SOURCES.ANDROID,
  ios: AUDIT_SOURCES.IOS,
  web: AUDIT_SOURCES.WEB,
  website: AUDIT_SOURCES.WEB,
  windows: AUDIT_SOURCES.WEB,
  macos: AUDIT_SOURCES.WEB,
  linux: AUDIT_SOURCES.WEB,
  admin: AUDIT_SOURCES.ADMIN_PANEL,
  admin_panel: AUDIT_SOURCES.ADMIN_PANEL,
  "admin-panel": AUDIT_SOURCES.ADMIN_PANEL,
};

// Last-resort user-agent sniff, used only when the client sent no `x-platform`.
// Deliberately narrow: it decides ANDROID/IOS vs WEB, nothing else.
function sourceFromUserAgent(userAgent: string): AuditSource {
  const ua = userAgent.toLowerCase();
  if (ua.includes("android")) return AUDIT_SOURCES.ANDROID;
  if (
    ua.includes("iphone") ||
    ua.includes("ipad") ||
    ua.includes("ios") ||
    ua.includes("cfnetwork") ||
    ua.includes("darwin")
  ) {
    return AUDIT_SOURCES.IOS;
  }
  return AUDIT_SOURCES.WEB;
}

/** Header bag shape shared by Express requests and Socket.IO handshakes. */
type HeaderBag = Record<string, string | string[] | undefined>;

function firstHeader(bag: HeaderBag | undefined, name: string): string | null {
  const raw = bag?.[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Derive the source at a request boundary. `x-platform` (already sent by web,
 * Android and iOS for session/device metadata) is authoritative; an unknown or
 * missing value falls back to a user-agent sniff, and finally to WEB — the
 * request DID come from some client, so SYSTEM would be a lie.
 *
 * Never trusts a client-supplied actor: only the transport it arrived on.
 */
export function resolveAuditSource(
  headers: HeaderBag | undefined,
  query?: Record<string, unknown>
): AuditSource {
  const declared =
    firstHeader(headers, "x-platform") ??
    (typeof query?.platform === "string" ? query.platform : null);
  if (declared) {
    const mapped = PLATFORM_TO_SOURCE[declared.trim().toLowerCase()];
    if (mapped) return mapped;
  }
  const userAgent = firstHeader(headers, "user-agent");
  return userAgent ? sourceFromUserAgent(userAgent) : AUDIT_SOURCES.WEB;
}

/** IP + user-agent + source captured once at the edge, for every audit row below it. */
export type AuditRequestContext = {
  source: AuditSource;
  ip: string | null;
  userAgent: string | null;
};

const auditStore = new AsyncLocalStorage<AuditRequestContext>();

/** Run `fn` with `context` visible to every async continuation inside it. */
export function runWithAuditContext<T>(
  context: AuditRequestContext,
  fn: () => T
): T {
  return auditStore.run(context, fn);
}

/** Context of the in-flight request, or undefined outside any request. */
export function currentAuditContext(): AuditRequestContext | undefined {
  return auditStore.getStore();
}

/** Source of the in-flight request; SYSTEM when there is no request at all. */
export function currentAuditSource(): AuditSource {
  return auditStore.getStore()?.source ?? AUDIT_SOURCES.SYSTEM;
}

// Leftmost X-Forwarded-For hop is the original client; X-Real-IP is the
// single-value nginx form. Both are only meaningful behind a trusted proxy —
// which every service is, since the gateway is the only edge.
function resolveClientIp(headers: HeaderBag | undefined): string | null {
  const forwarded = firstHeader(headers, "x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return firstHeader(headers, "x-real-ip");
}

type MinimalRequest = { headers?: HeaderBag; ip?: string; query?: unknown };

/**
 * Express middleware establishing the audit context for the whole request.
 * Structurally typed so `@aimess/constants` stays dependency-free — it is
 * `app.use()`-compatible in every service.
 *
 * `forcedSource` is for a service with exactly one client: backoffice-service is
 * only ever called by the admin panel, so it pins ADMIN_PANEL rather than
 * sniffing a browser it already knows. Everything downstream of it (a community
 * closed from the panel, over gRPC) then inherits ADMIN_PANEL too.
 */
export function createAuditContextMiddleware(
  forcedSource?: AuditSource
): (req: MinimalRequest, res: unknown, next: () => void) => void {
  return function auditContext(req, _res, next) {
    const headers = req.headers;
    runWithAuditContext(
      {
        source:
          forcedSource ??
          resolveAuditSource(
            headers,
            req.query as Record<string, unknown> | undefined
          ),
        ip: resolveClientIp(headers) ?? req.ip ?? null,
        userAgent: firstHeader(headers, "user-agent"),
      },
      next
    );
  };
}

/** Default middleware: derives the source from the request itself. */
export const auditContextMiddleware = createAuditContextMiddleware();
