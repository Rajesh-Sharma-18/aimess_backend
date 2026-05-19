import { UnauthorizedError } from "@aimess/errors";
import jwt from "jsonwebtoken";
import jwksClient from "jwks-rsa";

import { env } from "../config/env.js";

export type AppleIdentityTokenProfile = {
  sub: string;
  email: string | null;
  emailVerified: boolean;
};

const appleJwks = jwksClient({
  cache: true,
  rateLimit: true,
  jwksUri: "https://appleid.apple.com/auth/keys",
});

function getAppleSigningKey(kid: string): Promise<string> {
  return new Promise((resolve, reject) => {
    appleJwks.getSigningKey(kid, (error, key) => {
      if (error) {
        reject(error);
        return;
      }

      const publicKey = key?.getPublicKey();
      if (!publicKey) {
        reject(new Error("Apple signing key not found"));
        return;
      }

      resolve(publicKey);
    });
  });
}

export async function verifyAppleIdentityToken(
  identityToken: string
): Promise<AppleIdentityTokenProfile> {
  if (env.APPLE_CLIENT_IDS.length === 0) {
    throw new Error("APPLE_CLIENT_IDS is not configured");
  }

  try {
    const decoded = jwt.decode(identityToken, { complete: true });
    if (!decoded || typeof decoded === "string" || !decoded.header.kid) {
      throw new UnauthorizedError("AUTH_SOCIAL_TOKEN_INVALID");
    }

    const publicKey = await getAppleSigningKey(decoded.header.kid);
    const audience: jwt.VerifyOptions["audience"] =
      env.APPLE_CLIENT_IDS.length === 1
        ? env.APPLE_CLIENT_IDS[0]
        : (env.APPLE_CLIENT_IDS as [string, ...string[]]);

    const payload = jwt.verify(identityToken, publicKey, {
      algorithms: ["RS256"],
      issuer: "https://appleid.apple.com",
      audience,
    });

    if (typeof payload === "string" || !payload.sub) {
      throw new UnauthorizedError("AUTH_SOCIAL_TOKEN_INVALID");
    }

    const email =
      typeof payload.email === "string"
        ? payload.email.trim().toLowerCase()
        : null;

    const emailVerified =
      payload.email_verified === true || payload.email_verified === "true";

    return {
      sub: payload.sub,
      email,
      emailVerified,
    };
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      throw error;
    }

    throw new UnauthorizedError("AUTH_SOCIAL_TOKEN_INVALID");
  }
}
