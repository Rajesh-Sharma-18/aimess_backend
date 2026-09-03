import { createHash } from "node:crypto";

import {
  DIFFICULTY_BITS,
  issueSignupChallenge,
} from "../../src/lib/signup-challenge.js";

/**
 * Solve a signup proof-of-work the way a real client does.
 *
 * Deliberately brute force, exactly like the browser: if this ever needed a
 * shortcut the server's check would be broken.
 */
export function solveChallenge(challenge: string): string {
  for (let nonce = 0; ; nonce += 1) {
    const solution = String(nonce);
    const digest = createHash("sha256")
      .update(`${challenge}.${solution}`)
      .digest();

    let bits = 0;
    for (const byte of digest) {
      if (byte === 0) {
        bits += 8;
        continue;
      }
      bits += Math.clz32(byte) - 24;
      break;
    }
    if (bits >= DIFFICULTY_BITS) return solution;
  }
}

/** A fresh, solved `proof` body field for register / accounts-validate. */
export function signupProof(): { challenge: string; solution: string } {
  const { challenge } = issueSignupChallenge();
  return { challenge, solution: solveChallenge(challenge) };
}
