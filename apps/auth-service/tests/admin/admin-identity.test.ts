jest.mock("../../src/repositories/auth.repository.js", () => ({
  authRepository: {
    findByIdForAccountOps: jest.fn(),
    findEmailTakenByOtherUser: jest.fn(),
    setUnverifiedEmail: jest.fn(),
  },
}));
jest.mock("../../src/repositories/linked-account.repository.js", () => ({
  linkedAccountRepository: {
    findByUserIdAndProvider: jest.fn(),
    countByUserId: jest.fn(),
    deleteByUserIdAndProvider: jest.fn(async () => undefined),
  },
}));
jest.mock("../../src/grpc/backoffice.client.js", () => ({
  isAdminEmailTaken: jest.fn(async () => false),
}));
jest.mock("../../src/lib/profile-socket.js", () => ({
  emitProfileUpdatedSafe: jest.fn(),
}));

import { authRepository } from "../../src/repositories/auth.repository.js";
import { linkedAccountRepository } from "../../src/repositories/linked-account.repository.js";
import { adminIdentityService } from "../../src/services/admin-identity.service.js";
import { socialLinkService } from "../../src/services/social-link.service.js";

const repo = authRepository as unknown as Record<string, jest.Mock>;
const linkRepo = linkedAccountRepository as unknown as Record<
  string,
  jest.Mock
>;

const USER_ID = "user-1";

function activeUser(overrides: Record<string, unknown> = {}) {
  return {
    id: USER_ID,
    email: null,
    emailVerified: false,
    passwordHash: null,
    status: "ACTIVE",
    deletedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  repo.findByIdForAccountOps.mockResolvedValue(activeUser());
  repo.findEmailTakenByOtherUser.mockResolvedValue(null);
  repo.setUnverifiedEmail.mockResolvedValue({ id: USER_ID });
  linkRepo.findByUserIdAndProvider.mockResolvedValue({ id: "link-1" });
  linkRepo.countByUserId.mockResolvedValue(1);
});

describe("adminIdentityService.setEmail", () => {
  it("stores the address unverified so the OTP flow still proves ownership", async () => {
    const result = await adminIdentityService.setEmail(
      USER_ID,
      " John@Example.com "
    );
    expect(repo.setUnverifiedEmail).toHaveBeenCalledWith(
      USER_ID,
      "john@example.com"
    );
    expect(result).toEqual({
      changed: true,
      previousEmail: null,
      email: "john@example.com",
    });
  });

  it("is a no-op for the address the account already holds", async () => {
    repo.findByIdForAccountOps.mockResolvedValue(
      activeUser({ email: "john@example.com" })
    );
    const result = await adminIdentityService.setEmail(
      USER_ID,
      "john@example.com"
    );
    expect(result.changed).toBe(false);
    expect(repo.setUnverifiedEmail).not.toHaveBeenCalled();
  });

  it("refuses an address another account owns", async () => {
    repo.findEmailTakenByOtherUser.mockResolvedValue({ id: "other" });
    await expect(
      adminIdentityService.setEmail(USER_ID, "taken@example.com")
    ).rejects.toMatchObject({ messageKey: "AUTH_EMAIL_EXISTS" });
    expect(repo.setUnverifiedEmail).not.toHaveBeenCalled();
  });

  it("refuses a banned account", async () => {
    repo.findByIdForAccountOps.mockResolvedValue(
      activeUser({ status: "BANNED" })
    );
    await expect(
      adminIdentityService.setEmail(USER_ID, "john@example.com")
    ).rejects.toMatchObject({ messageKey: "ACCOUNT_BANNED" });
  });
});

describe("socialLinkService.adminUnlink", () => {
  it("never removes the only sign-in method", async () => {
    await expect(
      socialLinkService.adminUnlink(USER_ID, "GOOGLE")
    ).rejects.toMatchObject({ messageKey: "AUTH_LAST_SIGN_IN_METHOD" });
    expect(linkRepo.deleteByUserIdAndProvider).not.toHaveBeenCalled();
  });

  it("unlinks once the account also has a password", async () => {
    repo.findByIdForAccountOps.mockResolvedValue(
      activeUser({ passwordHash: "hash" })
    );
    await expect(
      socialLinkService.adminUnlink(USER_ID, "GOOGLE")
    ).resolves.toEqual({ provider: "GOOGLE" });
    expect(linkRepo.deleteByUserIdAndProvider).toHaveBeenCalledTimes(1);
  });
});
