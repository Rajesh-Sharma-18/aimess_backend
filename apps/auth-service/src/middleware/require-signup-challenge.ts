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
 * Runs AFTER `validateBody`, so `proof` is known to be present and
 * well-shaped by the time this sees it.
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
