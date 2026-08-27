/**
 * `user.restored` → the profile un-delete + the platform-wide re-identification
 * fan-out. The exact inverse of account-deletion-anonymization.test.ts.
 *
 * The whole reactivate feature rests on one property of the delete: it removed
 * no row and overwrote no stored value. `softDelete` writes only `deletedAt` +
 * `status`, and the "Deleted Account" identity every other service shows is a
 * read-time projection of those flags (or a denormalized copy of that
 * projection). So restoring is: clear the two flags, then re-publish the REAL
 * identity on the same `user.profile_updated` fanout the deletion used, which
 * is what repaints chat-service's snapshot cache and community-service's member
 * snapshots back to the original values.
 *
 * What must hold, and what these tests pin:
 *  - the published identity is the REAL one, read back off the intact row —
 *    publishing the anonymized triple here would permanently burn "Deleted
 *    Account" into every community member document;
 *  - `isDeleted` is NOT true, so consumers take the ordinary rename branch
 *    (refresh the roster) rather than the "this account is gone" branch;
 *  - the username is re-CLAIMED, mirroring the release the delete performed;
 *  - it is idempotent, because the event can be redelivered from the DLQ.
 */
jest.mock("../../src/repositories/user-profile.repository.js", () => ({
  userProfileRepository: {
    findByUserId: jest.fn(),
    restore: jest.fn(),
  },
}));
jest.mock("../../src/lib/user-cache.js", () => ({
  userCache: {
    invalidateProfile: jest.fn(async () => undefined),
    onUsernameClaimed: jest.fn(async () => undefined),
  },
  toCachedProfileRecord: (record: unknown) => record,
  fromCachedProfileRecord: (record: unknown) => record,
}));
jest.mock("../../src/messaging/publish-profile-updated.js", () => ({
  publishProfileUpdatedSafe: jest.fn(),
}));
jest.mock("../../src/lib/profile-socket.js", () => ({
  emitProfileUpdatedSafe: jest.fn(),
}));

import { DELETED_ACCOUNT_DISPLAY_NAME } from "@aimess/constants";

import { userCache } from "../../src/lib/user-cache.js";
import { publishProfileUpdatedSafe } from "../../src/messaging/publish-profile-updated.js";
import { userProfileRepository } from "../../src/repositories/user-profile.repository.js";
import { userProfileService } from "../../src/services/user-profile.service.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const DELETED_AT = "2026-08-13T10:00:00.000Z";
const RESTORED_AT = "2026-08-27T09:30:00.000Z";

const repo = userProfileRepository as unknown as {
  findByUserId: jest.Mock;
  restore: jest.Mock;
};
const cache = userCache as unknown as {
  invalidateProfile: jest.Mock;
  onUsernameClaimed: jest.Mock;
};
const publish = publishProfileUpdatedSafe as unknown as jest.Mock;

/** Every identity column survived the delete untouched — only the two flags moved. */
const deletedProfile = {
  userId: USER_ID,
  username: "janecooper02",
  firstName: "Jane",
  lastName: "Cooper",
  bio: "Driver",
  dateOfBirth: new Date("1995-01-01T00:00:00.000Z"),
  gender: "FEMALE",
  avatarUrl: "avatars/jane/abc.webp",
  status: "DELETED",
  deletedAt: new Date(DELETED_AT),
  account: "janecooper",
  isGoogleLogin: false,
  updatedAt: new Date("2026-08-13T10:00:00.000Z"),
};

const restoredProfile = {
  ...deletedProfile,
  status: "ACTIVE",
  deletedAt: null,
};

describe("restoreFromUserRestoredEvent", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    repo.findByUserId.mockResolvedValue({ ...deletedProfile });
    repo.restore.mockResolvedValue({ ...restoredProfile });
  });

  it("clears the soft-delete flags and re-claims the username", async () => {
    await userProfileService.restoreFromUserRestoredEvent({
      userId: USER_ID,
      restoredAt: RESTORED_AT,
    });

    expect(repo.restore).toHaveBeenCalledWith(USER_ID);
    expect(cache.invalidateProfile).toHaveBeenCalledWith(USER_ID);
    expect(cache.onUsernameClaimed).toHaveBeenCalledWith("janecooper02");
  });

  it("publishes the REAL identity on the profile-updated fanout", async () => {
    await userProfileService.restoreFromUserRestoredEvent({
      userId: USER_ID,
      restoredAt: RESTORED_AT,
    });

    expect(publish).toHaveBeenCalledTimes(1);
    const payload = publish.mock.calls[0][0] as Record<string, unknown>;

    expect(payload.userId).toBe(USER_ID);
    expect(payload.username).toBe("janecooper02");
    expect(payload.displayName).toBe("Jane Cooper");
    expect(payload.avatarObjectKey).toBe("avatars/jane/abc.webp");
    expect(payload.updatedAt).toBe(RESTORED_AT);

    // The placeholder must not survive anywhere in the payload — this exact
    // object is written verbatim into every community member document.
    expect(JSON.stringify(payload)).not.toContain(DELETED_ACCOUNT_DISPLAY_NAME);
  });

  it("does not set isDeleted, so consumers take the rename branch", async () => {
    await userProfileService.restoreFromUserRestoredEvent({
      userId: USER_ID,
      restoredAt: RESTORED_AT,
    });

    const payload = publish.mock.calls[0][0] as { isDeleted?: boolean };
    // chat-service branches on `=== true`; anything else is an ordinary
    // profile change, which is what a restore is to every consumer.
    expect(payload.isDeleted).not.toBe(true);
  });

  it("is idempotent — an already-active profile neither restores nor republishes", async () => {
    repo.findByUserId.mockResolvedValue({
      ...deletedProfile,
      status: "ACTIVE",
      deletedAt: null,
    });

    await userProfileService.restoreFromUserRestoredEvent({
      userId: USER_ID,
      restoredAt: RESTORED_AT,
    });

    expect(repo.restore).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it("does nothing when the profile row is missing", async () => {
    repo.findByUserId.mockResolvedValue(null);

    await userProfileService.restoreFromUserRestoredEvent({
      userId: USER_ID,
      restoredAt: RESTORED_AT,
    });

    expect(repo.restore).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });
});
