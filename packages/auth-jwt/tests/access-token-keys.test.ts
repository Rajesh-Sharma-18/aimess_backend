/**
 * AIM-54 / AIM-65 — asymmetric signing, issuer/audience, and the migration
 * path between them.
 *
 * AIM-54: one HS256 secret was copied into eight `.env` files, so every service
 * that VERIFIES a token could also MINT one. A leak from the gateway, chat,
 * media or any other service was equivalent to a leak from auth-service: forge
 * a token for any user id and the whole platform accepts it. With a keypair,
 * only auth-service holds the private half.
 *
 * AIM-65: tokens carried no `iss`/`aud`, so nothing distinguished a token this
 * platform issued from one signed by anything else holding that secret, and
 * nothing scoped a token to an audience.
 *
 * The migration has to be doable without logging everyone out, so these cases
 * pin both directions of the transition, not just the destination.
 */
import { generateKeyPairSync } from "node:crypto";

import jwt from "jsonwebtoken";

import {
  ACCESS_TOKEN_AUDIENCE,
  ACCESS_TOKEN_ISSUER,
  signAccessToken,
  verifyAccessToken,
} from "../src/access-token.js";

const SECRET = "test-access-secret-do-not-use-in-prod";
const USER = "11111111-1111-4111-8111-111111111111";
const SESSION = "22222222-2222-4222-8222-222222222222";

const { publicKey, privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

/** A second, unrelated keypair — stands in for an attacker's own key. */
const foreign = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

function sign(overrides: Record<string, unknown> = {}) {
  return signAccessToken({
    userId: USER,
    sessionId: SESSION,
    expiresInSeconds: 3600,
    ...overrides,
  } as Parameters<typeof signAccessToken>[0]);
}

describe("HS256 (the shape that existed before)", () => {
  it("signs and verifies with the shared secret", () => {
    const token = sign({ secret: SECRET });
    expect(verifyAccessToken(token, SECRET)).toMatchObject({
      userId: USER,
      sessionId: SESSION,
    });
  });

  it("now stamps issuer and audience on every token", () => {
    const decoded = jwt.decode(sign({ secret: SECRET })) as Record<
      string,
      unknown
    >;
    expect(decoded.iss).toBe(ACCESS_TOKEN_ISSUER);
    expect(decoded.aud).toBe(ACCESS_TOKEN_AUDIENCE);
  });
});

describe("RS256 (the destination)", () => {
  it("verifies a token signed with the private key using only the public key", () => {
    const token = sign({ signingKey: { alg: "RS256", privateKey } });

    expect(verifyAccessToken(token, { publicKey })).toMatchObject({
      userId: USER,
      sessionId: SESSION,
    });
  });

  it("cannot be forged by a holder of the public key", () => {
    // This is the property AIM-54 is about: a service that can VERIFY must not
    // be able to MINT. Signing with the public key is not possible, and a token
    // signed by any other key is refused.
    const forged = jwt.sign(
      { sub: USER, sid: SESSION, type: "access" },
      foreign.privateKey,
      {
        algorithm: "RS256",
        issuer: ACCESS_TOKEN_ISSUER,
        audience: ACCESS_TOKEN_AUDIENCE,
        expiresIn: 3600,
      }
    );

    expect(() => verifyAccessToken(forged, { publicKey })).toThrow();
  });

  it("refuses an HS256 token when only a public key is configured", () => {
    // A verifier that has moved to the keypair holds no secret, so a token
    // minted with the old shared secret has nothing to verify against.
    const token = sign({ secret: SECRET });
    expect(() => verifyAccessToken(token, { publicKey })).toThrow();
  });

  it("refuses the algorithm-confusion attack (HS256 signed with the public key)", () => {
    // The classic JWT attack: sign with HS256 using the PEM of the public key
    // as the HMAC secret, hoping the verifier picks the algorithm from the
    // header. Pinning `algorithms` per key is what stops it.
    const confused = jwt.sign(
      { sub: USER, sid: SESSION, type: "access" },
      publicKey,
      {
        algorithm: "HS256",
        issuer: ACCESS_TOKEN_ISSUER,
        audience: ACCESS_TOKEN_AUDIENCE,
        expiresIn: 3600,
      }
    );

    expect(() => verifyAccessToken(confused, { publicKey })).toThrow();
  });
});

describe("migration window", () => {
  it("accepts BOTH key kinds while both are configured", () => {
    // This is what makes the switch safe: tokens minted before the cutover keep
    // verifying under the secret while new ones verify under the key.
    const both = { secret: SECRET, publicKey };

    expect(verifyAccessToken(sign({ secret: SECRET }), both)).toMatchObject({
      userId: USER,
    });
    expect(
      verifyAccessToken(
        sign({ signingKey: { alg: "RS256", privateKey } }),
        both
      )
    ).toMatchObject({ userId: USER });
  });

  it("accepts a legacy token with no iss/aud until the claims are required", () => {
    // Every token minted before this change looks like this.
    const legacy = jwt.sign(
      { sub: USER, sid: SESSION, type: "access" },
      SECRET,
      { expiresIn: 3600 }
    );

    expect(verifyAccessToken(legacy, { secret: SECRET })).toMatchObject({
      userId: USER,
    });

    expect(() =>
      verifyAccessToken(legacy, { secret: SECRET, requireIssuerAudience: true })
    ).toThrow();
  });

  it("reports an expired token as expired, not as invalid", () => {
    // The client's refresh flow branches on AUTH_TOKEN_EXPIRED. Trying the
    // second key after an expiry would downgrade it to AUTH_INVALID_TOKEN and
    // strand the client.
    const expired = jwt.sign(
      { sub: USER, sid: SESSION, type: "access" },
      SECRET,
      {
        expiresIn: -10,
        issuer: ACCESS_TOKEN_ISSUER,
        audience: ACCESS_TOKEN_AUDIENCE,
      }
    );

    expect(() =>
      verifyAccessToken(expired, { secret: SECRET, publicKey })
    ).toThrow(expect.objectContaining({ messageKey: "AUTH_TOKEN_EXPIRED" }));
  });
});

describe("issuer / audience enforcement", () => {
  it("refuses a token issued by someone else, even with a valid signature", () => {
    const wrongIssuer = jwt.sign(
      { sub: USER, sid: SESSION, type: "access" },
      SECRET,
      {
        expiresIn: 3600,
        issuer: "someone-else",
        audience: ACCESS_TOKEN_AUDIENCE,
      }
    );

    expect(() => verifyAccessToken(wrongIssuer, { secret: SECRET })).toThrow();
  });

  it("refuses a token minted for a different audience", () => {
    const wrongAudience = jwt.sign(
      { sub: USER, sid: SESSION, type: "access" },
      SECRET,
      {
        expiresIn: 3600,
        issuer: ACCESS_TOKEN_ISSUER,
        audience: "some-other-service",
      }
    );

    expect(() =>
      verifyAccessToken(wrongAudience, { secret: SECRET })
    ).toThrow();
  });

  it("requires a verification key to be configured at all", () => {
    expect(() => verifyAccessToken(sign({ secret: SECRET }), {})).toThrow(
      /requires a `secret` or a `publicKey`/
    );
  });
});
