import { OAuth2Client } from "google-auth-library";

import { UnauthorizedError } from "@aimess/errors";

import { env } from "../config/env.js";

export type GoogleIdTokenProfile = {
  sub: string;
  email: string | null;
  emailVerified: boolean;
  displayName: string | null;
};

const client = new OAuth2Client();

export async function verifyGoogleIdToken(
  idToken: string
): Promise<GoogleIdTokenProfile> {
  if (env.GOOGLE_CLIENT_IDS.length === 0) {
    throw new Error("GOOGLE_CLIENT_IDS is not configured");
  }

  try {
    const ticket = await client.verifyIdToken({
      idToken,
      audience: env.GOOGLE_CLIENT_IDS,
    });

    const payload = ticket.getPayload();
    if (!payload?.sub) {
      throw new UnauthorizedError("AUTH_SOCIAL_TOKEN_INVALID");
    }

    return {
      sub: payload.sub,
      email: payload.email?.trim().toLowerCase() ?? null,
      emailVerified: payload.email_verified === true,
      displayName: payload.name?.trim() ?? null,
    };
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      throw error;
    }

    throw new UnauthorizedError("AUTH_SOCIAL_TOKEN_INVALID");
  }
}
