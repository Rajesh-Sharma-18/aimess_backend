// Guards the admin_db mirror's status-transition rule for "Re-Activate User".
//
// The mirror column is NOT the source of truth for deletion — auth-service is,
// and `reactivateUser` checks the status resolved from it (and auth-service
// re-checks authoritatively) before ever reaching this function. The mirror
// routinely disagrees for a deleted user: a lapsed SUSPENDED is never reset,
// and a BANNED written before the account was deleted just stays there. If the
// stale value were allowed to veto, the endpoint would 409 AFTER auth-service
// had already reactivated the account — the half-restored state the whole
// feature exists to prevent.
//
// So: `fromDeleted` permits ACTIVE from ANY current status and nothing else,
// while every ordinary moderation action still treats DELETED as a tombstone.
import { assertTransition } from "../../src/repositories/user-directory.repository.js";
import type { UserStatus } from "../../src/types/user-management.types.js";

const EVERY_STATUS: UserStatus[] = ["ACTIVE", "SUSPENDED", "BANNED", "DELETED"];

describe("assertTransition — reactivate (fromDeleted)", () => {
  it.each(EVERY_STATUS)(
    "allows %s -> ACTIVE, so a stale mirror can never veto a restore",
    (current) => {
      expect(() => assertTransition(current, "ACTIVE", true)).not.toThrow();
    }
  );

  it("still refuses to reactivate INTO a restricted status", () => {
    expect(() => assertTransition("DELETED", "BANNED", true)).toThrow(
      "USER_DELETED"
    );
    expect(() => assertTransition("DELETED", "SUSPENDED", true)).toThrow(
      "USER_DELETED"
    );
  });
});

describe("assertTransition — ordinary moderation is unchanged", () => {
  it.each(["ACTIVE", "SUSPENDED", "BANNED"] as UserStatus[])(
    "keeps DELETED a tombstone for a %s transition",
    (next) => {
      expect(() => assertTransition("DELETED", next)).toThrow("USER_DELETED");
    }
  );

  it("keeps the existing ban/suspend/unban rules intact", () => {
    expect(() => assertTransition("ACTIVE", "BANNED")).not.toThrow();
    expect(() => assertTransition("ACTIVE", "SUSPENDED")).not.toThrow();
    expect(() => assertTransition("BANNED", "ACTIVE")).not.toThrow();
    expect(() => assertTransition("SUSPENDED", "ACTIVE")).not.toThrow();
    expect(() => assertTransition("BANNED", "BANNED")).toThrow(
      "USER_ALREADY_BANNED"
    );
    expect(() => assertTransition("BANNED", "SUSPENDED")).toThrow(
      "USER_ALREADY_BANNED"
    );
    expect(() => assertTransition("ACTIVE", "ACTIVE")).toThrow(
      "USER_NOT_BANNED"
    );
  });
});
