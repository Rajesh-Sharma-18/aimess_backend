/**
 * `user.deleted` → the profile soft-delete + the platform-wide anonymization
 * fan-out.
 *
 * user-service owns identity, so it is the ONE place that decides what a
 * deleted account looks like. Deletion rides the existing
 * `user.profile_updated` fanout instead of a parallel event, because every
 * consumer of that exchange already does exactly what deletion needs:
 * chat-service drops the cached user snapshot, community-service overwrites
 * every denormalized member snapshot and re-broadcasts the roster row.
 *
 * What must hold, and what these tests pin:
 *  - the published identity is ANONYMIZED (that payload is written verbatim
 *    into community member documents — publishing the real name there would
 *    re-seed the old identity into the very surfaces being cleaned);
 *  - `isDeleted: true` is set, so consumers can tell a deletion from a rename
 *    and emit the realtime "this account is gone" signal a rename must not;
 *  - `isProfileCompleted` is carried through unchanged rather than forced
 *    false — it describes whether the profile's required fields were filled
 *    in, which deletion does not answer, and it is mirrored by auth-service for
 *    post-login routing during the 30-day restore window.
 */
jest.mock("../../src/repositories/user-profile.repository.js", () => ({
  userProfileRepository: {
    findByUserId: jest.fn(),
    softDelete: jest.fn(async () => undefined),
  },
}));
jest.mock("../../src/lib/user-cache.js", () => ({
  userCache: {
    invalidateProfile: jest.fn(async () => undefined),
    onUsernameReleased: jest.fn(async () => undefined),
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

const repo = userProfileRepository as unknown as {
  findByUserId: jest.Mock;
  softDelete: jest.Mock;
};
const cache = userCache as unknown as {
  invalidateProfile: jest.Mock;
  onUsernameReleased: jest.Mock;
};
const publish = publishProfileUpdatedSafe as unknown as jest.Mock;

const liveProfile = {
  userId: USER_ID,
  username: "janecooper02",
  firstName: "Jane",
  lastName: "Cooper",
  bio: "Driver",
  dateOfBirth: new Date("1995-01-01T00:00:00.000Z"),
  gender: "FEMALE",
  avatarUrl: "avatars/jane/abc.webp",
  status: "ACTIVE",
  deletedAt: null,
  account: "janecooper",
  isGoogleLogin: false,
  updatedAt: new Date("2026-08-01T00:00:00.000Z"),
};

describe("softDeleteFromUserDeletedEvent", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    repo.findByUserId.mockResolvedValue({ ...liveProfile });
  });

  it("soft-deletes the profile and releases the username", async () => {
    await userProfileService.softDeleteFromUserDeletedEvent({
      userId: USER_ID,
      deletedAt: DELETED_AT,
    });

    expect(repo.softDelete).toHaveBeenCalledWith(USER_ID, new Date(DELETED_AT));
    expect(cache.invalidateProfile).toHaveBeenCalledWith(USER_ID);
    expect(cache.onUsernameReleased).toHaveBeenCalledWith("janecooper02");
  });

  it("publishes an ANONYMIZED identity on the profile-updated fanout", async () => {
    await userProfileService.softDeleteFromUserDeletedEvent({
      userId: USER_ID,
      deletedAt: DELETED_AT,
    });

    expect(publish).toHaveBeenCalledTimes(1);
    const payload = publish.mock.calls[0][0] as Record<string, unknown>;

    expect(payload.userId).toBe(USER_ID);
    expect(payload.displayName).toBe(DELETED_ACCOUNT_DISPLAY_NAME);
    expect(payload.username).toBe("");
    expect(payload.avatarObjectKey).toBeNull();
    expect(payload.isDeleted).toBe(true);
    expect(payload.updatedAt).toBe(DELETED_AT);

    // Nothing identifying may ride along — community-service writes this
    // payload straight into every member document.
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain("Jane");
    expect(serialized).not.toContain("Cooper");
    expect(serialized).not.toContain("janecooper02");
    expect(serialized).not.toContain("avatars/jane");
  });

  it("carries isProfileCompleted through instead of forcing it false", async () => {
    await userProfileService.softDeleteFromUserDeletedEvent({
      userId: USER_ID,
      deletedAt: DELETED_AT,
    });

    const payload = publish.mock.calls[0][0] as { isProfileCompleted: boolean };
    expect(payload.isProfileCompleted).toBe(true);
  });

  it("is idempotent — an already-deleted profile neither re-deletes nor re-publishes", async () => {
    repo.findByUserId.mockResolvedValue({
      ...liveProfile,
      deletedAt: new Date(DELETED_AT),
      status: "DELETED",
    });

    await userProfileService.softDeleteFromUserDeletedEvent({
      userId: USER_ID,
      deletedAt: DELETED_AT,
    });

    expect(repo.softDelete).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it("does nothing when the profile does not exist", async () => {
    repo.findByUserId.mockResolvedValue(null);

    await userProfileService.softDeleteFromUserDeletedEvent({
      userId: USER_ID,
      deletedAt: DELETED_AT,
    });

    expect(repo.softDelete).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });
});
