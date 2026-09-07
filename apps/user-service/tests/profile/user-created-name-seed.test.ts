/**
 * `user.created` → profile seeding. Social-provider names auto-fill when
 * present; password registration leaves firstName/lastName empty so the user
 * fills them in on the profile-details step.
 */
jest.mock("../../src/repositories/user-profile.repository.js", () => ({
  userProfileRepository: {
    findByUserId: jest.fn(),
    createFromRegistration: jest.fn(),
    clearAccountValue: jest.fn(),
  },
}));
jest.mock("../../src/services/username.service.js", () => ({
  usernameService: {
    generateFromAccount: jest.fn(async () => ({ username: "rajesh_1" })),
  },
}));
jest.mock("../../src/messaging/publish-profile-updated.js", () => ({
  publishProfileUpdatedSafe: jest.fn(),
}));
jest.mock("../../src/lib/user-cache.js", () => ({
  userCache: {
    onUsernameClaimed: jest.fn(async () => undefined),
    get: jest.fn(async () => null),
    set: jest.fn(async () => undefined),
    invalidate: jest.fn(async () => undefined),
  },
  toCachedProfileRecord: jest.fn(),
  fromCachedProfileRecord: jest.fn(),
}));

import type { UserCreatedPayload } from "@aimess/shared-types";

import { userProfileService } from "../../src/services/user-profile.service.js";
import { userProfileRepository } from "../../src/repositories/user-profile.repository.js";
import { publishProfileUpdatedSafe } from "../../src/messaging/publish-profile-updated.js";

const repo = userProfileRepository as unknown as Record<string, jest.Mock>;
const publishProfileUpdated = publishProfileUpdatedSafe as unknown as jest.Mock;

const BASE: UserCreatedPayload = {
  userId: "11111111-1111-1111-1111-111111111111",
  account: "rajesh",
  email: "rajesh@example.com",
  createdAt: "2026-08-17T00:00:00.000Z",
};

beforeEach(() => {
  jest.clearAllMocks();
  repo.findByUserId.mockResolvedValue(null);
  repo.createFromRegistration.mockResolvedValue({ userId: BASE.userId });
});

describe("createFromUserCreatedEvent — name seeding", () => {
  it("uses the provider's given/family names when present", async () => {
    await userProfileService.createFromUserCreatedEvent({
      ...BASE,
      firstName: "Rajesh",
      lastName: "Sharma",
      isGoogleLogin: true,
    });

    expect(repo.createFromRegistration).toHaveBeenCalledWith(
      expect.objectContaining({
        firstName: "Rajesh",
        lastName: "Sharma",
        isGoogleLogin: true,
      })
    );
  });

  it("leaves fields empty when the event carries no name (password registration)", async () => {
    await userProfileService.createFromUserCreatedEvent(BASE);

    expect(repo.createFromRegistration).toHaveBeenCalledWith(
      expect.objectContaining({ firstName: "", lastName: "" })
    );
  });

  it("treats blank provider values as absent, leaving fields empty", async () => {
    await userProfileService.createFromUserCreatedEvent({
      ...BASE,
      firstName: "   ",
      lastName: "",
    });

    expect(repo.createFromRegistration).toHaveBeenCalledWith(
      expect.objectContaining({ firstName: "", lastName: "" })
    );
  });

  it("keeps a given name without a surname (surname stays empty)", async () => {
    await userProfileService.createFromUserCreatedEvent({
      ...BASE,
      firstName: "Rajesh",
    });

    expect(repo.createFromRegistration).toHaveBeenCalledWith(
      expect.objectContaining({ firstName: "Rajesh", lastName: "" })
    );
  });

  it("never derives name from email (regression: rajesh.sharma@gmail.com)", async () => {
    await userProfileService.createFromUserCreatedEvent({
      ...BASE,
      account: "rajesh_sharma",
      email: "rajesh.sharma@gmail.com",
      isGoogleLogin: false,
    });

    const call = repo.createFromRegistration.mock.calls[0][0];
    expect(call.firstName).toBe("");
    expect(call.lastName).toBe("");
  });

  it("Apple registration without name leaves fields empty", async () => {
    await userProfileService.createFromUserCreatedEvent({
      ...BASE,
      email: "apple-relay@privaterelay.appleid.com",
      firstName: undefined,
      lastName: undefined,
    });

    expect(repo.createFromRegistration).toHaveBeenCalledWith(
      expect.objectContaining({ firstName: "", lastName: "" })
    );
  });

  it("Apple registration with name auto-fills both fields", async () => {
    await userProfileService.createFromUserCreatedEvent({
      ...BASE,
      email: "user@icloud.com",
      firstName: "Rajesh",
      lastName: "Sharma",
    });

    expect(repo.createFromRegistration).toHaveBeenCalledWith(
      expect.objectContaining({ firstName: "Rajesh", lastName: "Sharma" })
    );
  });

  // The mirror auth-service answers `isProfileCompleted` from is written only by
  // this event, so a social sign-up that arrived with both names has to publish
  // `true` here — the avatar it does not have never enters the answer.
  it("publishes the completion mirror as true for a named social sign-up", async () => {
    await userProfileService.createFromUserCreatedEvent({
      ...BASE,
      firstName: "Rajesh",
      lastName: "Sharma",
    });

    expect(publishProfileUpdated).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: BASE.userId,
        username: "rajesh_1",
        avatarObjectKey: null,
        isProfileCompleted: true,
      })
    );
  });

  it("publishes the completion mirror as false when no name was supplied", async () => {
    await userProfileService.createFromUserCreatedEvent(BASE);

    expect(publishProfileUpdated).toHaveBeenCalledWith(
      expect.objectContaining({ isProfileCompleted: false })
    );
  });

  it("does not re-seed a profile that already exists", async () => {
    repo.findByUserId.mockResolvedValue({ userId: BASE.userId });

    await userProfileService.createFromUserCreatedEvent({
      ...BASE,
      firstName: "Someone",
      lastName: "Else",
    });

    expect(repo.createFromRegistration).not.toHaveBeenCalled();
  });
});
