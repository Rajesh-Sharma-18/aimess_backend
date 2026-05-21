import { UnauthorizedError } from "@aimess/errors";

import { getFirebaseAuth } from "../config/firebase.js";

/** Firebase `sign_in_provider` values we support. */
export type FirebaseSignInProvider = "google.com" | "apple.com";

export type FirebaseTokenProfile = {
  /** Stable per-provider account id (Google/Apple sub), falling back to the Firebase uid. */
  sub: string;
  email: string | null;
  emailVerified: boolean;
  displayName: string | null;
};

/**
 * Verify a Firebase ID token issued by the mobile client's Firebase Auth SDK
 * and assert it was minted via the expected provider. Returns the normalized
 * profile used by the social login / link flows.
 *
 * The client (Android/iOS) signs in with Google or Apple through Firebase,
 * then sends the resulting Firebase ID token here — never a raw provider token.
 */
export async function verifyFirebaseIdToken(
  idToken: string,
  expectedProvider: FirebaseSignInProvider
): Promise<FirebaseTokenProfile> {
  // Resolve outside the try so a missing-config error surfaces as a real
  // server error, not a misleading "invalid token" 401.
  const auth = getFirebaseAuth();

  let decoded;
  try {
    decoded = await auth.verifyIdToken(idToken);
  } catch {
    throw new UnauthorizedError("AUTH_SOCIAL_TOKEN_INVALID");
  }

  const signInProvider = decoded.firebase?.sign_in_provider;
  if (signInProvider !== expectedProvider) {
    // Token is valid but came from a different provider than this endpoint.
    throw new UnauthorizedError("AUTH_SOCIAL_TOKEN_INVALID");
  }

  const identities = (decoded.firebase?.identities ?? {}) as Record<
    string,
    unknown
  >;
  const providerIdentity = identities[expectedProvider];
  const providerSub =
    Array.isArray(providerIdentity) && providerIdentity.length > 0
      ? String(providerIdentity[0])
      : undefined;

  const email =
    typeof decoded.email === "string"
      ? decoded.email.trim().toLowerCase()
      : null;

  const displayName =
    typeof decoded.name === "string" && decoded.name.trim().length > 0
      ? decoded.name.trim()
      : null;

  return {
    sub: providerSub ?? decoded.uid,
    email,
    emailVerified: decoded.email_verified === true,
    displayName,
  };
}
