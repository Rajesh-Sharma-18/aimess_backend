/**
 * AIM-55 — the internal gRPC service token must not be a value published in
 * this repository.
 *
 * The production fail-fast in `withServiceAuth` only tested for emptiness, so a
 * deployment that copied `.env.example` verbatim passed the check while
 * authenticating its entire internal mesh with a token anyone can read out of
 * git. `isPublishedPlaceholderToken` is what that check now consults.
 *
 * (`grpc-utils/tests/service-auth.test.ts` is a standalone tsx script and is
 * excluded from this Jest project; this file is a normal Jest spec.)
 */
import { isPublishedPlaceholderToken } from "@aimess/grpc-utils";

describe("isPublishedPlaceholderToken", () => {
  it("recognises the placeholder that shipped in every .env.example", () => {
    expect(
      isPublishedPlaceholderToken("dev-grpc-service-token-change-me")
    ).toBe(true);
  });

  it("recognises it regardless of casing or surrounding whitespace", () => {
    // Values arrive from a dotfile, where a stray space or a capitalised paste
    // is exactly how a placeholder slips past an equality check.
    expect(
      isPublishedPlaceholderToken("  dev-grpc-service-token-change-me  ")
    ).toBe(true);
    expect(
      isPublishedPlaceholderToken("DEV-GRPC-SERVICE-TOKEN-CHANGE-ME")
    ).toBe(true);
    expect(isPublishedPlaceholderToken("ChangeMe")).toBe(true);
  });

  it("accepts a real generated token", () => {
    // 32 bytes of base64, the value the templates now tell operators to mint.
    expect(
      isPublishedPlaceholderToken(
        "Zk9s3Qk1r7Yb2mVx8Tn4Lp6Wc0Jd5Hg2Aq7Ue1Ri3Bo="
      )
    ).toBe(false);
  });

  it("does not treat a token that merely contains the placeholder as one", () => {
    // Substring matching would reject legitimate tokens; the check is exact.
    expect(
      isPublishedPlaceholderToken("prod-dev-grpc-service-token-change-me-2")
    ).toBe(false);
  });
});
