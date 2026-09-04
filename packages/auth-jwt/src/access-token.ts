import jwt from "jsonwebtoken";

import { UnauthorizedError } from "@aimess/errors";

/** Must match the `type` claim set when auth-service signs access tokens. */
export const ACCESS_TOKEN_TYPE = "access" as const;

/** Platform-wide role carried on the access token (auth-service `GlobalRole`). */
export type PlatformRole = "USER" | "ADMIN";

export type AccessTokenPayload = {
  /** Auth user id (UUID). */
  sub: string;
  /** Session id (UUID). */
  sid: string;
  type: typeof ACCESS_TOKEN_TYPE;
  /** Platform role. Optional so older tokens without it still parse. */
  role?: PlatformRole;
  /** Issuer. Optional so tokens minted before this claim existed still parse. */
  iss?: string;
  /** Audience. Optional for the same reason. */
  aud?: string | string[];
};

/**
 * Who mints access tokens, and who they are for.
 *
 * Tokens carried neither claim, and the same symmetric secret was distributed
 * to eight services — so a token minted by ANY holder of that secret was
 * indistinguishable from one auth-service issued. Stamping and checking these
 * makes "auth-service issued this, for this platform" a verifiable statement
 * rather than an assumption.
 */
export const ACCESS_TOKEN_ISSUER = "aimess-auth" as const;
export const ACCESS_TOKEN_AUDIENCE = "aimess-api" as const;

/**
 * How an access token is signed.
 *
 * `HS256` is the historical shape: one shared secret, held by every service
 * that verifies. Any one of those services being compromised — or any leak of a
 * single `.env` — yields the power to MINT tokens for any user, not merely to
 * read them.
 *
 * `RS256` closes that: auth-service holds the private key and is the only
 * process that can sign, while every other service holds only the public key,
 * which is not a secret at all. A leak from chat-service or the gateway then
 * discloses nothing that can forge a token.
 */
export type AccessTokenSigningKey =
  | { alg: "HS256"; secret: string }
  | { alg: "RS256"; privateKey: string };

/**
 * How an access token is verified.
 *
 * Both key kinds may be supplied at once, which is what makes the migration
 * safe: while auth-service still signs HS256, every verifier accepts both; once
 * it signs RS256, tokens already in flight keep verifying under the secret
 * until they expire. The secret is dropped afterwards.
 */
export type AccessTokenVerifyConfig = {
  /** Shared HS256 secret. Accepted while any live token was signed with it. */
  secret?: string;
  /** RS256 public key. Not a secret — safe to ship to every service. */
  publicKey?: string;
  /**
   * Require `iss`/`aud` to be present and correct.
   *
   * `false` (the default) accepts a token carrying neither, which is what every
   * token minted before this change looks like. Turn it on once the longest
   * access-token lifetime has elapsed since deploying; a token without the
   * claims is then rejected outright.
   */
  requireIssuerAudience?: boolean;
};

export type VerifiedAccessToken = {
  userId: string;
  sessionId: string;
  role: PlatformRole;
};

export function signAccessToken(params: {
  userId: string;
  sessionId: string;
  /** Shared secret (HS256). Shorthand for `signingKey`. */
  secret?: string;
  /** Explicit key + algorithm. Preferred. */
  signingKey?: AccessTokenSigningKey;
  expiresInSeconds: number;
  role?: PlatformRole;
}): string {
  const key = resolveSigningKey(params.signingKey, params.secret);

  const payload: AccessTokenPayload = {
    sub: params.userId,
    sid: params.sessionId,
    type: ACCESS_TOKEN_TYPE,
    // Include `role` only when provided so callers that don't pass it keep the
    // old token shape (and older tokens remain valid).
    ...(params.role ? { role: params.role } : {}),
  };

  return jwt.sign(payload, key.alg === "HS256" ? key.secret : key.privateKey, {
    algorithm: key.alg,
    expiresIn: params.expiresInSeconds,
    // Always stamped, even while verification still tolerates their absence:
    // the claims must exist on live tokens before verification can require
    // them.
    issuer: ACCESS_TOKEN_ISSUER,
    audience: ACCESS_TOKEN_AUDIENCE,
  });
}

function resolveSigningKey(
  signingKey: AccessTokenSigningKey | undefined,
  secret: string | undefined
): AccessTokenSigningKey {
  if (signingKey) return signingKey;
  if (secret !== undefined) return { alg: "HS256", secret };
  throw new Error("signAccessToken requires `secret` or `signingKey`");
}

/**
 * Verify against whichever keys are configured.
 *
 * RS256 is tried first when a public key is present, because that is the
 * destination state; the shared secret is the compatibility path for tokens
 * minted before the switch. An expiry failure is conclusive and rethrown
 * immediately — retrying it under the other key would turn a clear
 * AUTH_TOKEN_EXPIRED into a generic AUTH_INVALID_TOKEN and break the client's
 * refresh flow.
 */
function verifyWithConfiguredKeys(
  token: string,
  config: AccessTokenVerifyConfig
): AccessTokenPayload {
  let lastError: unknown;

  if (config.publicKey) {
    try {
      return jwt.verify(token, config.publicKey, {
        algorithms: ["RS256"],
      }) as AccessTokenPayload;
    } catch (error) {
      if (error instanceof jwt.TokenExpiredError) throw toUnauthorized(error);
      lastError = error;
    }
  }

  if (config.secret) {
    try {
      return jwt.verify(token, config.secret, {
        algorithms: ["HS256"],
      }) as AccessTokenPayload;
    } catch (error) {
      if (error instanceof jwt.TokenExpiredError) throw toUnauthorized(error);
      lastError = error;
    }
  }

  throw toUnauthorized(lastError);
}

/** Maps jsonwebtoken verify failures to stable @aimess/errors codes. */
function toUnauthorized(error: unknown): UnauthorizedError {
  if (error instanceof UnauthorizedError) return error;
  if (error instanceof jwt.TokenExpiredError) {
    return new UnauthorizedError("AUTH_TOKEN_EXPIRED");
  }
  return new UnauthorizedError("AUTH_INVALID_TOKEN");
}

export function verifyAccessToken(
  token: string,
  secretOrConfig: string | AccessTokenVerifyConfig
): VerifiedAccessToken {
  const config: AccessTokenVerifyConfig =
    typeof secretOrConfig === "string"
      ? { secret: secretOrConfig }
      : secretOrConfig;

  if (!config.secret && !config.publicKey) {
    throw new Error(
      "verifyAccessToken requires a `secret` or a `publicKey` to verify against"
    );
  }

  const payload = verifyWithConfiguredKeys(token, config);

  // Issuer/audience.
  //
  // Enforced whenever the token CARRIES them, so a token stamped by this
  // platform cannot be replayed as one issued elsewhere or for another
  // audience. A token carrying neither is the pre-change shape: accepted while
  // `requireIssuerAudience` is false, rejected once it is turned on.
  const hasClaims = payload.iss !== undefined || payload.aud !== undefined;
  if (hasClaims || config.requireIssuerAudience === true) {
    const audiences = Array.isArray(payload.aud)
      ? payload.aud
      : payload.aud !== undefined
        ? [payload.aud]
        : [];
    if (
      payload.iss !== ACCESS_TOKEN_ISSUER ||
      !audiences.includes(ACCESS_TOKEN_AUDIENCE)
    ) {
      throw new UnauthorizedError("AUTH_INVALID_TOKEN");
    }
  }

  if (payload.type !== ACCESS_TOKEN_TYPE || !payload.sub || !payload.sid) {
    throw new UnauthorizedError("AUTH_INVALID_TOKEN");
  }

  // Resolve role defensively: anything that is not exactly "ADMIN"
  // (missing/unknown) is treated as the non-privileged "USER".
  const role: PlatformRole = payload.role === "ADMIN" ? "ADMIN" : "USER";

  return {
    userId: payload.sub,
    sessionId: payload.sid,
    role,
  };
}

/** Must match the `type` claim set when backoffice-service signs admin access tokens. */
export const ADMIN_ACCESS_TOKEN_TYPE = "admin_access" as const;

export type AdminAccessTokenPayload = {
  /** Admin user id (UUID). */
  sub: string;
  /** Admin session id (UUID). */
  sid: string;
  type: typeof ADMIN_ACCESS_TOKEN_TYPE;
};

export type VerifiedAdminAccessToken = {
  adminId: string;
  sessionId: string;
};

/**
 * Verifies a backoffice admin access token (separate secret + `type` claim
 * from the user access token). Shared here so services that need to accept
 * both token kinds — e.g. media-service's upload-url endpoint, used by the
 * Backoffice avatar upload flow — don't reimplement JWT verification.
 */
export function verifyAdminAccessToken(
  token: string,
  secret: string
): VerifiedAdminAccessToken {
  let payload: AdminAccessTokenPayload;

  try {
    payload = jwt.verify(token, secret, {
      algorithms: ["HS256"],
    }) as AdminAccessTokenPayload;
  } catch (error) {
    throw toUnauthorized(error);
  }

  if (
    payload.type !== ADMIN_ACCESS_TOKEN_TYPE ||
    !payload.sub ||
    !payload.sid
  ) {
    throw new UnauthorizedError("AUTH_INVALID_TOKEN");
  }

  return { adminId: payload.sub, sessionId: payload.sid };
}

export function extractBearerToken(
  authorizationHeader: string | undefined
): string {
  if (!authorizationHeader?.startsWith("Bearer ")) {
    throw new UnauthorizedError("AUTH_UNAUTHORIZED");
  }

  const token = authorizationHeader.slice("Bearer ".length).trim();
  if (!token) {
    throw new UnauthorizedError("AUTH_UNAUTHORIZED");
  }

  return token;
}
