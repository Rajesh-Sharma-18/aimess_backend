import type { NextFunction, Request, Response } from "express";

import { BadRequestError } from "@aimess/errors";

import { claimSignupChallenge } from "../lib/signup-challenge-store.js";
import { verifySignupChallenge } from "../lib/signup-challenge.js";

/**
 * Gate for the two endpoints that were free to call at scale: account creation
 * and handle availability.
 *
 * Rate limiting already bounds one address. This bounds one CPU, which is what
 * a proxy pool or botnet cannot spread around: each attempt costs the caller a
 * fresh proof of work that nobody can solve in advance or reuse.
 *
 * Runs AFTER `validateBody`, which has already checked the SHAPE of `proof` if
 * one was sent. Presence is this middleware's own call, deliberately: the
 * schemas mark `proof` optional so that omitting it is answered here as
 * `AUTH_CHALLENGE_REQUIRED` — a code a client can act on by fetching a
 * challenge — rather than as a generic `VALIDATION_FAILED` carrying Zod's raw
 * "expected object, received undefined".
 */
export async function requireSignupChallenge(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  const proof = (req.body as { proof?: { challenge: string; solution: string } })
    .proof;

  if (!proof) {
    next(new BadRequestError("AUTH_CHALLENGE_REQUIRED"));
    return;
  }

  const verdict = verifySignupChallenge(proof.challenge, proof.solution);
  if (!verdict.ok) {
    // One message for every reason. Distinguishing "forged" from "expired" from
    // "unsolved" would tell someone probing the gate which half of their
    // attempt to fix.
    next(new BadRequestError("AUTH_CHALLENGE_INVALID"));
    return;
  }

  try {
    await claimSignupChallenge(verdict.challengeId);
    next();
  } catch (err) {
    next(err);
  }
}
