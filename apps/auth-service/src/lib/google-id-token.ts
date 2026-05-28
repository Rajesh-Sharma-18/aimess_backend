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
 *
 * Replaces the Firebase-based Google verification; Apple sign-in still goes
 * through Firebase (see lib/firebase-id-token.ts).
 */
export async function verifyGoogleIdToken(
  idToken: string
): Promise<GoogleTokenProfile> {
  const { GOOGLE_OAUTH_CLIENT_ID } = env;

  // Resolve config outside the try so a missing-config error surfaces as a real
  // server error, not a misleading "invalid token" 401.
  if (!GOOGLE_OAUTH_CLIENT_ID) {
    throw new Error(
      "Google OAuth is not configured. Set GOOGLE_OAUTH_CLIENT_ID to enable Google login."
    );
  }

  let payload;
  try {
    const ticket = await getGoogleClient().verifyIdToken({
      idToken,
      audience: GOOGLE_OAUTH_CLIENT_ID,
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
