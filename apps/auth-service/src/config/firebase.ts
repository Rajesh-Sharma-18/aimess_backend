import admin from "firebase-admin";
import type { Auth } from "firebase-admin/auth";

import { env } from "./env.js";

let cachedAuth: Auth | null = null;

/**
 * Lazily initialize Firebase Admin and return the Auth instance.
 *
 * Initialization is deferred until the first social-login request (rather than
 * at boot) so the auth-service still starts when Firebase isn't configured yet
 * — password/refresh/session flows keep working; only Google/Apple login needs
 * these credentials. Throws a clear error if they're missing.
 */
export function getFirebaseAuth(): Auth {
  if (cachedAuth) {
    return cachedAuth;
  }

  const { FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY } =
    env;

  if (!FIREBASE_PROJECT_ID || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY) {
    throw new Error(
      "Firebase is not configured. Set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY to enable Google/Apple login."
    );
  }

  const app = admin.apps.length
    ? admin.app()
    : admin.initializeApp({
        credential: admin.credential.cert({
          projectId: FIREBASE_PROJECT_ID,
          clientEmail: FIREBASE_CLIENT_EMAIL,
          // .env stores the key with literal "\n"; restore real newlines.
          privateKey: FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
        }),
      });

  cachedAuth = admin.auth(app);
  return cachedAuth;
}
