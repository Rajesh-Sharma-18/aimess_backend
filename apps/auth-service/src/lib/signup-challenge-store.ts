import { BadRequestError } from "@aimess/errors";
import { logger } from "@aimess/logger";
import { consumeFallbackWindow } from "@aimess/utils";

import { redis } from "../config/redis.js";
import { CHALLENGE_TTL_SECONDS } from "./signup-challenge.js";

/**
 * Single-use enforcement for a solved signup challenge.
 *
 * Without it the proof of work is paid ONCE and then replayed forever, which
 * makes the whole control decorative: an enumerator would solve one challenge
 * and test the entire handle namespace with it.
 *
 * The key lives exactly as long as the challenge could still be valid — after
 * that the challenge is refused on expiry anyway, so remembering it is wasted
 * space.
 */
const KEY_PREFIX = "auth:signup-challenge:";

/**
 * Claim a solved challenge, or reject it as already used.
 *
 * `SET NX` is the claim: the first caller creates the key, everyone else finds
 * it there. Atomic, so two concurrent replays cannot both win.
 *
 * On a Redis failure this degrades to a per-process counter rather than failing
 * open. Failing open would restore unlimited replay of one solved challenge —
 * the exact hole this closes — and failing closed would make a cache blip block
 * every registration on the platform. The fallback bounds replay to a handful
 * per process while Redis is unavailable, which is neither.
 */
export async function claimSignupChallenge(challengeId: string): Promise<void> {
  const key = `${KEY_PREFIX}${challengeId}`;

  try {
    const claimed = await redis.set(key, "1", "EX", CHALLENGE_TTL_SECONDS, "NX");
    if (claimed !== "OK") {
      throw new BadRequestError("AUTH_CHALLENGE_ALREADY_USED");
    }
    return;
  } catch (err) {
    if (err instanceof BadRequestError) throw err;

    const fallback = consumeFallbackWindow({
      key,
      windowMs: CHALLENGE_TTL_SECONDS * 1000,
      limit: 1,
    });
    if (!fallback.allowed) {
      throw new BadRequestError("AUTH_CHALLENGE_ALREADY_USED");
    }

    logger.warn("signup challenge single-use check degraded to in-process", {
      service: "auth-service",
      detail: String(err),
    });
  }
}
