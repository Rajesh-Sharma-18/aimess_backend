import { UnauthorizedError } from "@aimess/errors";
import { OAuth2Client } from "google-auth-library";

import { env } from "../config/env.js";

/** Normalized profile extracted from a verified Google ID token. */
export type GoogleTokenProfile = {
  /** Google account id (the token `sub` claim) — stable per-user identifier. */
  sub: string;
  email: string | null;
  emailVerified: boolean;
  displayName: string | null;
};

let cachedClient: OAuth2Client | null = null;

function getGoogleClient(): OAuth2Client {
  cachedClient ??= new OAuth2Client();
  return cachedClient;
}

/**
 * Verify a Google ID token issued by the client's Google Sign-In flow and
 * return the normalized profile used by the social login / link flows.
 *
 * `google-auth-library` fetches and caches Google's public signing keys, checks
 * the signature, expiry, issuer, and that the token's `aud` matches our
 * configured OAuth client id — so no service-account private key is needed.
 */
export async function verifyGoogleIdToken(
  idToken: string
): Promise<GoogleTokenProfile> {
  const { GOOGLE_OAUTH_APPLE_CLIENT_ID, GOOGLE_OAUTH_ANDROID_CLIENT_ID } = env;

  // Accept either platform's client ID — google-auth-library matches the token's
  // `aud` claim against any entry in the array. No client-side platform flag is
  // needed: the `aud` itself is the cryptographic proof of which app issued it.
  const audiences = [
    GOOGLE_OAUTH_APPLE_CLIENT_ID,
    GOOGLE_OAUTH_ANDROID_CLIENT_ID,
  ].filter((value): value is string => Boolean(value));

  // Resolve config outside the try so a missing-config error surfaces as a real
  // server error, not a misleading "invalid token" 401.
  if (audiences.length === 0) {
    throw new Error(
      "Google OAuth is not configured. Set GOOGLE_OAUTH_APPLE_CLIENT_ID and/or GOOGLE_OAUTH_ANDROID_CLIENT_ID to enable Google login."
    );
  }

  let payload;
  try {
    const ticket = await getGoogleClient().verifyIdToken({
      idToken,
      audience: audiences,
    });
    payload = ticket.getPayload();
  } catch {
    throw new UnauthorizedError("AUTH_SOCIAL_TOKEN_INVALID");
  }

  if (!payload?.sub) {
    throw new UnauthorizedError("AUTH_SOCIAL_TOKEN_INVALID");
  }

  const email =
    typeof payload.email === "string"
      ? payload.email.trim().toLowerCase()
      : null;

  const displayName =
    typeof payload.name === "string" && payload.name.trim().length > 0
      ? payload.name.trim()
      : null;

  return {
    sub: payload.sub,
    email,
    emailVerified: payload.email_verified === true,
    displayName,
  };
}
