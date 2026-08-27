/**
 * assertAdminEmailAvailable — an email may belong to exactly one identity
 * platform-wide: another admin here, or an end user in auth-service's DB.
 */
jest.mock("../../src/repositories/index.js", () => ({
  adminUserRepository: { findByEmail: jest.fn() },
}));

import { assertAdminEmailAvailable } from "../../src/lib/admin-email-availability.js";
import { authClient } from "../../src/grpc/auth.client.js";
import { adminUserRepository } from "../../src/repositories/index.js";

const findByEmail = adminUserRepository.findByEmail as unknown as jest.Mock;
const userEmailTaken = authClient.isUserEmailTaken as unknown as jest.Mock;

beforeEach(() => {
  findByEmail.mockReset();
  userEmailTaken.mockReset();
  userEmailTaken.mockResolvedValue(false);
});

describe("assertAdminEmailAvailable", () => {
  it("passes when neither an admin nor an end user owns the email", async () => {
    findByEmail.mockResolvedValue(null);

    await expect(
      assertAdminEmailAvailable("free@example.com")
    ).resolves.toBeUndefined();
  });

  it("409s when another admin owns the email", async () => {
    findByEmail.mockResolvedValue({ id: "admin-2" });

    await expect(
      assertAdminEmailAvailable("taken@example.com")
    ).rejects.toMatchObject({ statusCode: 409, message: "ADMIN_EMAIL_TAKEN" });
    expect(userEmailTaken).not.toHaveBeenCalled();
  });

  it("allows the admin that already owns the email to keep it", async () => {
    findByEmail.mockResolvedValue({ id: "admin-1" });

    await expect(
      assertAdminEmailAvailable("mine@example.com", "admin-1")
    ).resolves.toBeUndefined();
  });

  it("409s when an end-user account owns the email", async () => {
    findByEmail.mockResolvedValue(null);
    userEmailTaken.mockResolvedValue(true);

    await expect(
      assertAdminEmailAvailable("user@example.com")
    ).rejects.toMatchObject({
      statusCode: 409,
      message: "ADMIN_EMAIL_TAKEN_BY_USER",
    });
  });

  it("fails closed with 503 when auth-service is unreachable", async () => {
    findByEmail.mockResolvedValue(null);
    userEmailTaken.mockRejectedValue(new Error("breaker open"));

    await expect(
      assertAdminEmailAvailable("user@example.com")
    ).rejects.toMatchObject({ statusCode: 503 });
  });
});
