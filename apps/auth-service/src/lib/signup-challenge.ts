import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { env } from "../config/env.js";

/**
 * A proof-of-work challenge the client must solve before it can create an
 * account or probe whether a handle is taken.
 *
 * Two findings share one cause: both endpoints were free to call.
 *
 *  - Registration (AIM-58) needed no verified contact detail and no bot
 *    resistance of any kind, and issued full tokens immediately. Creating ten
 *    thousand accounts cost ten thousand HTTP requests.
 *  - Account availability (AIM-31) answered 409 for a taken handle and 200 for
 *    a free one, which enumerates the whole handle namespace — and enumerated
 *    handles are the input to targeted credential stuffing against login.
 *
 * Rate limiting bounds one address; it does nothing about a botnet or a proxy
 * pool, where the per-source rate stays low. What changes the economics is
 * making each attempt cost the CALLER something. A hashcash-style proof of work
 * does that: a person waits a fraction of a second once, while an enumerator
 * pays that cost for every handle they want to test, on their own hardware,
 * with no way to amortise it.
 *
 * Chosen over a third-party captcha deliberately: no external dependency on the
 * signup path, no request to another company on every registration, nothing to
 * be down, and no user-facing puzzle.
 *
 * Stateless issuance. The challenge is an HMAC over its own contents, so the
 * server does not store anything to issue one and cannot be flooded into
 * keeping state. Single use IS stored — one small Redis key per SOLVED
 * challenge, which only a caller who has already paid the CPU cost can create.
 */

/**
 * Leading zero BITS required in the solution hash.
 *
 * The default 20 bits is around a million hashes: a few hundred milliseconds in
 * a browser, unnoticeable behind a signup form the user is still typing into.
 * For someone testing a million handles it is a million times that, which is
 * the asymmetry the control exists to create. Tunable so it can be raised
 * during a flood without a deploy.
 */
const DIFFICULTY_BITS = env.SIGNUP_CHALLENGE_DIFFICULTY_BITS;

/** How long a challenge remains solvable. Long enough for a slow device. */
const CHALLENGE_TTL_SECONDS = 600;

export type IssuedChallenge = {
  /** Opaque, self-authenticating: `<nonce>.<expiresAt>.<signature>`. */
  challenge: string;
  difficultyBits: number;
  expiresAt: string;
};

/**
 * Derived from the refresh secret rather than the access secret, which is
 * optional once a deployment has moved to the RS256 keypair — an absent secret
 * would silently become an empty HMAC key, and anyone could then mint their own
 * challenges. `JWT_REFRESH_SECRET` is required by the schema and never leaves
 * auth-service.
 *
 * Domain-separated so a challenge signature can never be mistaken for, or
 * substituted into, anything else derived from the same secret.
 */
const CHALLENGE_KEY = createHmac("sha256", env.JWT_REFRESH_SECRET)
  .update("aimess.signup-challenge.v1")
  .digest();

function sign(payload: string): string {
  return createHmac("sha256", CHALLENGE_KEY).update(payload).digest("hex");
}

/** Issue a fresh challenge. Cheap and stateless. */
export function issueSignupChallenge(): IssuedChallenge {
  const nonce = randomBytes(16).toString("hex");
  const expiresAt = Date.now() + CHALLENGE_TTL_SECONDS * 1000;
  const payload = `${nonce}.${String(expiresAt)}`;

  return {
    challenge: `${payload}.${sign(payload)}`,
    difficultyBits: DIFFICULTY_BITS,
    expiresAt: new Date(expiresAt).toISOString(),
  };
}

export type ChallengeVerdict =
  | { ok: true; challengeId: string }
  | { ok: false; reason: "MALFORMED" | "FORGED" | "EXPIRED" | "UNSOLVED" };

/** Count the leading zero bits of a digest. */
function leadingZeroBits(digest: Buffer): number {
  let bits = 0;
  for (const byte of digest) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    bits += Math.clz32(byte) - 24;
    break;
  }
  return bits;
}

/**
 * Verify a challenge and its solution.
 *
 * Deliberately does NOT consult Redis: single-use enforcement is a separate
 * concern with a different failure policy (see `assertChallengeUnused`), and
 * keeping the cryptographic check pure makes it trivially testable and
 * impossible to fail open by accident.
 */
export function verifySignupChallenge(
  challenge: string,
  solution: string
): ChallengeVerdict {
  const parts = challenge.split(".");
  if (parts.length !== 3) return { ok: false, reason: "MALFORMED" };

  const [nonce, expiresAtRaw, signature] = parts as [string, string, string];
  const payload = `${nonce}.${expiresAtRaw}`;

  const expected = sign(payload);
  // Constant time: a fast reject on the first differing byte would let a caller
  // discover a valid signature byte by byte.
  if (
    signature.length !== expected.length ||
    !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  ) {
    return { ok: false, reason: "FORGED" };
  }

  const expiresAt = Number(expiresAtRaw);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    return { ok: false, reason: "EXPIRED" };
  }

  const digest = createHash("sha256").update(`${challenge}.${solution}`).digest();
  if (leadingZeroBits(digest) < DIFFICULTY_BITS) {
    return { ok: false, reason: "UNSOLVED" };
  }

  // The nonce identifies this challenge for single-use tracking. The signature
  // is not used as the id: it is derived from the nonce, so the nonce is the
  // smaller equivalent.
  return { ok: true, challengeId: nonce };
}

export { CHALLENGE_TTL_SECONDS, DIFFICULTY_BITS };
