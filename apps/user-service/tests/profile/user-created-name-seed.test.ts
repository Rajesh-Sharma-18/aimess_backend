/**
 * `user.created` → profile seeding. The event now carries the verified social
 * provider name; this pins the mapping AND the fallback, so a provider that
 * sends nothing can never write a blank name over the placeholder pair.
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

const repo = userProfileRepository as unknown as Record<string, jest.Mock>;

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

  it("falls back to the account placeholder when the event carries no name", async () => {
    await userProfileService.createFromUserCreatedEvent(BASE);

    expect(repo.createFromRegistration).toHaveBeenCalledWith(
      expect.objectContaining({ firstName: "rajesh", lastName: "User" })
    );
  });

  it("treats blank provider values as absent, never writing an empty name", async () => {
    await userProfileService.createFromUserCreatedEvent({
      ...BASE,
      firstName: "   ",
      lastName: "",
    });

    expect(repo.createFromRegistration).toHaveBeenCalledWith(
      expect.objectContaining({ firstName: "rajesh", lastName: "User" })
    );
  });

  it("keeps a given name without a surname (surname stays the placeholder)", async () => {
    await userProfileService.createFromUserCreatedEvent({
      ...BASE,
      firstName: "Rajesh",
    });

    expect(repo.createFromRegistration).toHaveBeenCalledWith(
      expect.objectContaining({ firstName: "Rajesh", lastName: "User" })
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
