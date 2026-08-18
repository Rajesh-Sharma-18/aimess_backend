// Guards the wire contract of the Super Admin permanent ban, which Android,
// iOS and Web all code against.
//
// Two things are load-bearing and easy to break by accident:
//   1. banType defaults to SYSTEM, so every pre-existing caller (the admin
//      panel posts /ban with no banType) keeps its current meaning; and
//   2. a COMMUNITY ban is permanent and community-scoped by construction — it
//      must carry a communityId and must never accept a duration.
import {
  banUserSchema,
  bulkBanSchema,
  unbanUserSchema,
} from "../../src/api/validators/users.validator.js";

describe("ban scope validation", () => {
  it("defaults an unscoped ban to SYSTEM so legacy callers are unchanged", () => {
    const parsed = banUserSchema.parse({ reason: "Policy violation" });
    expect(parsed.banType).toBe("SYSTEM");
    expect(parsed.durationDays).toBeNull();
  });

  it("accepts a community ban that names its community", () => {
    const parsed = banUserSchema.parse({
      banType: "COMMUNITY",
      communityId: "6a43649ee5f92decfc4bc0af",
      reason: "Policy violation",
    });
    expect(parsed.communityId).toBe("6a43649ee5f92decfc4bc0af");
  });

  it("rejects a community ban with no communityId", () => {
    const result = banUserSchema.safeParse({
      banType: "COMMUNITY",
      reason: "Policy violation",
    });
    expect(result.success).toBe(false);
  });

  // There is no temporary ban. Accepting a duration here would silently
  // downgrade the action into the legacy time-boxed suspend path.
  it("rejects a duration on a community ban", () => {
    const result = banUserSchema.safeParse({
      banType: "COMMUNITY",
      communityId: "6a43649ee5f92decfc4bc0af",
      reason: "Policy violation",
      durationDays: 7,
    });
    expect(result.success).toBe(false);
  });

  it("applies the same scope rules to the bulk schema", () => {
    expect(
      bulkBanSchema.safeParse({
        banType: "COMMUNITY",
        reason: "Policy violation",
        userIds: ["u1"],
      }).success
    ).toBe(false);

    expect(
      bulkBanSchema.safeParse({
        reason: "Policy violation",
        userIds: ["u1"],
      }).success
    ).toBe(true);
  });
});

describe("unban scope validation", () => {
  // The panel's existing "activate" button POSTs with no body at all.
  it("treats a body-less unban as a system unban", () => {
    const parsed = unbanUserSchema.parse({});
    expect(parsed.banType).toBe("SYSTEM");
  });

  it("rejects a community unban with no communityId", () => {
    expect(unbanUserSchema.safeParse({ banType: "COMMUNITY" }).success).toBe(
      false
    );
  });

  it("accepts a community unban that names its community", () => {
    const parsed = unbanUserSchema.parse({
      banType: "COMMUNITY",
      communityId: "6a43649ee5f92decfc4bc0af",
    });
    expect(parsed.communityId).toBe("6a43649ee5f92decfc4bc0af");
  });
});
