import { UnauthorizedError } from "@aimess/errors";
import { createRemoteJWKSet, jwtVerify } from "jose";

import { env } from "../config/env.js";

/** Normalized profile extracted from a verified Apple ID token. */
export type AppleTokenProfile = {
  /** Apple's stable user identifier (`sub`). */
  sub: string;
  email: string | null;
  emailVerified: boolean;
  displayName: string | null;
};

const APPLE_ISSUER = "https://appleid.apple.com";
const APPLE_JWKS_URL = new URL("https://appleid.apple.com/auth/keys");

let cachedJwks: ReturnType<typeof createRemoteJWKSet> | null = null;

function getAppleJwks(): ReturnType<typeof createRemoteJWKSet> {
  cachedJwks ??= createRemoteJWKSet(APPLE_JWKS_URL);
  return cachedJwks;
}

function parseAudienceList(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Verify a Sign in with Apple identity token directly against Apple's JWKS.
 *
 * Validates signature (RS256), `iss=https://appleid.apple.com`, expiry, and
 * that `aud` matches one of the configured APPLE_CLIENT_IDS (Bundle ID for
 * native, Service ID for web). No Firebase dependency.
 *
 * Apple only sends `email` on the first authorization for a given user; the
 * iOS client passes it separately on subsequent sign-ins.
 */
export async function verifyAppleIdToken(
  identityToken: string
): Promise<AppleTokenProfile> {
  const { APPLE_CLIENT_IDS } = env;

  if (!APPLE_CLIENT_IDS) {
    throw new Error(
      "Apple sign-in is not configured. Set APPLE_CLIENT_IDS to enable Apple login."
    );
  }

  const audiences = parseAudienceList(APPLE_CLIENT_IDS);

  let payload;
  try {
    const result = await jwtVerify(identityToken, getAppleJwks(), {
      issuer: APPLE_ISSUER,
      audience: audiences,
      algorithms: ["RS256"],
    });
    payload = result.payload;
  } catch {
    throw new UnauthorizedError("AUTH_SOCIAL_TOKEN_INVALID");
  }

  if (typeof payload.sub !== "string" || payload.sub.length === 0) {
    throw new UnauthorizedError("AUTH_SOCIAL_TOKEN_INVALID");
  }

  const email =
    typeof payload.email === "string"
      ? payload.email.trim().toLowerCase()
      : null;

  // Apple historically encoded `email_verified` as a string ("true"/"false").
  // Accept both for safety.
  const rawVerified = (payload as Record<string, unknown>).email_verified;
  const emailVerified = rawVerified === true || rawVerified === "true";

  return {
    sub: payload.sub,
    email,
    emailVerified,
    // Apple NEVER puts the user's name in the identity token — not even on the
    // first authorization. The name arrives once, in the authorization
    // response body (`fullName` / ASAuthorizationAppleIDCredential.fullName),
    // and is handled by socialAuthService.loginWithApple.
    displayName: null,
  };
}
