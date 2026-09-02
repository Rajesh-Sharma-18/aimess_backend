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
 * SYSTEM exists only for rows no client produced — a sweeper, a queue consumer,
 * a tripwire the platform pulled on its own. A row with a user on it can never
 * be SYSTEM: a person acted, so a client was involved by definition. See
 * {@link isClientAuditSource} and the guard in `publishAdminActivitySafe`.
 *
 * These UPPERCASE values are the ONE canonical representation. Clients send
 * lowercase `x-platform` (`web` / `android` / `ios`); it is mapped here, once,
 * and nothing downstream ever sees a variant spelling.
 */
export const AUDIT_SOURCES = {
  ADMIN_PANEL: "ADMIN_PANEL",
  WEB: "WEB",
  ANDROID: "ANDROID",
  IOS: "IOS",
  SYSTEM: "SYSTEM",
} as const;

export type AuditSource = (typeof AUDIT_SOURCES)[keyof typeof AUDIT_SOURCES];

/** The platforms a human can actually act from. Excludes SYSTEM by construction. */
export const CLIENT_AUDIT_SOURCES = [
  AUDIT_SOURCES.ADMIN_PANEL,
  AUDIT_SOURCES.WEB,
  AUDIT_SOURCES.ANDROID,
  AUDIT_SOURCES.IOS,
] as const;

export type ClientAuditSource = (typeof CLIENT_AUDIT_SOURCES)[number];

const AUDIT_SOURCE_VALUES = new Set<string>(Object.values(AUDIT_SOURCES));
const CLIENT_AUDIT_SOURCE_VALUES = new Set<string>(CLIENT_AUDIT_SOURCES);

/** Server-side allowlist for a client-declared source; anything else is rejected. */
export function isAuditSource(value: unknown): value is AuditSource {
  return typeof value === "string" && AUDIT_SOURCE_VALUES.has(value);
}

/** True when the value names a real client. SYSTEM is not one. */
export function isClientAuditSource(
  value: unknown
): value is ClientAuditSource {
  return typeof value === "string" && CLIENT_AUDIT_SOURCE_VALUES.has(value);
}

// Accepted `x-platform` values. Desktop builds are still the web client, so they
// fold into WEB rather than inventing a source the admin panel can't filter on.
//
// ADMIN_PANEL is deliberately NOT reachable from here. `x-platform` is a public,
// client-supplied header, and this table used to map `admin` / `admin_panel` /
// `admin-panel` straight onto it — so any ordinary user could make their own
// actions appear in the platform's audit trail as if they had come from the
// admin panel. The only legitimate producer of ADMIN_PANEL is
// backoffice-service, which pins it via `createAuditContextMiddleware`'s
// `forcedSource` argument and never sniffs the request at all.
const PLATFORM_TO_SOURCE: Record<string, AuditSource> = {
  android: AUDIT_SOURCES.ANDROID,
  ios: AUDIT_SOURCES.IOS,
  web: AUDIT_SOURCES.WEB,
  website: AUDIT_SOURCES.WEB,
  windows: AUDIT_SOURCES.WEB,
  macos: AUDIT_SOURCES.WEB,
  linux: AUDIT_SOURCES.WEB,
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
 * Android and iOS for session/device metadata) is a hint; an unknown or missing
 * value falls back to a user-agent sniff, and finally to WEB — the request DID
 * come from some client, so SYSTEM would be a lie.
 *
 * Never trusts a client-supplied actor: only the transport it arrived on. Two
 * things it deliberately will not do:
 *
 *  - It cannot produce ADMIN_PANEL. That value means "this action came from the
 *    backoffice", which only backoffice-service can assert, via `forcedSource`.
 *  - It no longer accepts `?platform=` from the query string. A source that can
 *    be set by a link the victim clicks is not evidence of anything, and the
 *    header already covers every real client.
 */
export function resolveAuditSource(headers: HeaderBag | undefined): AuditSource {
  const declared = firstHeader(headers, "x-platform");
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
        source: forcedSource ?? resolveAuditSource(headers),
        // `req.ip`, not a hand-parsed X-Forwarded-For. This used to take the
        // leftmost forwarded entry — the one the caller controls — so the IP
        // stamped on every audit row across every service was attacker-chosen.
        // Express resolves `req.ip` against the configured trust-proxy hop
        // count, which each service now applies unconditionally.
        ip: req.ip ?? null,
        userAgent: firstHeader(headers, "user-agent"),
      },
      next
    );
  };
}

/** Default middleware: derives the source from the request itself. */
export const auditContextMiddleware = createAuditContextMiddleware();
