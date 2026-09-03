import { createHash } from "node:crypto";

import {
  DIFFICULTY_BITS,
  issueSignupChallenge,
  verifySignupChallenge,
} from "../../src/lib/signup-challenge.js";
import { solveChallenge } from "../helpers/solve-signup-challenge.js";

/**
 * AIM-58.
 *
 * `POST /auth/register` was free to call: creating an account cost one HTTP
 * request. Per-IP rate limiting bounds one address and does nothing about a
 * proxy pool, so the gate had to cost the CALLER something no address rotation
 * can spread around.
 *
 * `POST /auth/accounts/validate` (AIM-31) carried the same gate and no longer
 * does — a signup form cannot fetch and solve a challenge per keystroke. That
 * route is back to per-IP throttling alone; see `api/routes/auth.routes.ts`.
 *
 * These tests pin the properties that make the proof of work worth having. If
 * any one of them regresses the control is decorative.
 */
describe("signup proof-of-work challenge", () => {
  it("accepts a correctly solved challenge", () => {
    const { challenge } = issueSignupChallenge();
    const verdict = verifySignupChallenge(challenge, solveChallenge(challenge));

    expect(verdict.ok).toBe(true);
  });

  it("rejects a challenge presented with no work done", () => {
    // The whole point: a caller who skips the hashing gets nothing.
    const { challenge } = issueSignupChallenge();

    // Find a solution that is definitely NOT good enough, so the test does not
    // depend on "0" happening to be a lucky nonce.
    let bad = "0";
    for (let i = 0; ; i += 1) {
      const digest = createHash("sha256").update(`${challenge}.${i}`).digest();
      if (digest[0] !== 0) {
        bad = String(i);
        break;
      }
    }

    const verdict = verifySignupChallenge(challenge, bad);
    expect(verdict).toEqual({ ok: false, reason: "UNSOLVED" });
  });

  it("rejects a challenge the server never issued", () => {
    // Without the signature check a caller mints their own challenges at
    // whatever difficulty they like, and the cost disappears.
    const forged = `${"a".repeat(32)}.${String(Date.now() + 60_000)}.${"b".repeat(64)}`;

    expect(verifySignupChallenge(forged, "0")).toEqual({
      ok: false,
      reason: "FORGED",
    });
  });

  it("rejects a challenge whose stated expiry has passed", () => {
    const { challenge } = issueSignupChallenge();
    const solution = solveChallenge(challenge);

    // Rewinding the clock past the stamped expiry, rather than editing the
    // token — editing it would trip the signature check instead and prove
    // nothing about expiry.
    const realNow = Date.now;
    Date.now = () => realNow() + 11 * 60 * 1000;
    try {
      expect(verifySignupChallenge(challenge, solution)).toEqual({
        ok: false,
        reason: "EXPIRED",
      });
    } finally {
      Date.now = realNow;
    }
  });

  it("rejects an expiry extended by hand", () => {
    const { challenge } = issueSignupChallenge();
    const [nonce, , signature] = challenge.split(".");
    const extended = `${nonce}.${String(Date.now() + 86_400_000)}.${signature}`;

    expect(verifySignupChallenge(extended, "0")).toEqual({
      ok: false,
      reason: "FORGED",
    });
  });

  it("rejects anything that is not a challenge", () => {
    for (const junk of ["", "abc", "a.b", "a.b.c.d"]) {
      const verdict = verifySignupChallenge(junk, "0");
      expect(verdict.ok).toBe(false);
    }
  });

  it("issues a distinct challenge every time", () => {
    // A constant challenge would be solvable once and replayed forever, even
    // before single-use enforcement gets a look at it.
    const seen = new Set(
      Array.from({ length: 25 }, () => issueSignupChallenge().challenge)
    );

    expect(seen.size).toBe(25);
  });

  it("reports the difficulty the client must actually meet", () => {
    // The client cannot solve a puzzle whose difficulty it is told wrongly.
    const issued = issueSignupChallenge();

    expect(issued.difficultyBits).toBe(DIFFICULTY_BITS);
    expect(new Date(issued.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("binds the solution to its own challenge", () => {
    // Solutions must not be portable between challenges, or one solve would
    // cover every subsequent attempt.
    const a = issueSignupChallenge().challenge;
    const b = issueSignupChallenge().challenge;

    expect(verifySignupChallenge(b, solveChallenge(a)).ok).toBe(false);
  });
});
