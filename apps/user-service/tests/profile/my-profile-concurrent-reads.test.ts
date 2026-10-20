// GET /users/profiles/me reads the profile and the auth-service account summary
// concurrently: one round trip of the request, not two chained ones.
let releaseProfile!: (record: unknown) => void;

jest.mock("../../src/lib/user-cache.js", () => ({
  userCache: {
    getProfileRecord: jest.fn(
      () => new Promise((resolve) => (releaseProfile = resolve))
    ),
  },
  toCachedProfileRecord: (record: unknown) => record,
  fromCachedProfileRecord: (record: unknown) => record,
}));
jest.mock("../../src/lib/resolve-auth-account.js", () => ({
  resolveAuthAccountSummary: jest.fn(async () => ({
    account: null,
    accountStatus: "unavailable",
  })),
}));

import { resolveAuthAccountSummary } from "../../src/lib/resolve-auth-account.js";
import { userProfileService } from "../../src/services/user-profile.service.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";

it("asks auth-service for the account summary without waiting for the profile read", async () => {
  const pending = userProfileService.getMyProfile(USER_ID);
  await new Promise((resolve) => setImmediate(resolve));

  expect(resolveAuthAccountSummary).toHaveBeenCalledWith(USER_ID);

  releaseProfile({
    userId: USER_ID,
    username: "janecooper02",
    firstName: "Jane",
    lastName: "Cooper",
    bio: "",
    dateOfBirth: new Date("1995-01-01T00:00:00.000Z"),
    gender: "FEMALE",
    avatarUrl: null,
    status: "ACTIVE",
    deletedAt: null,
    account: "janecooper",
    isGoogleLogin: false,
    updatedAt: new Date("2026-08-13T10:00:00.000Z"),
  });
  await expect(pending).resolves.toMatchObject({
    userId: USER_ID,
    username: "janecooper02",
    account: "janecooper",
  });
});
