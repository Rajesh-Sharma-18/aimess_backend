/**
 * assertEmailAvailable — an email may belong to exactly one identity across the
 * platform: another AuthUser, or an admin in backoffice-service's admin_db.
 */
jest.mock("../../src/repositories/auth.repository.js", () => ({
  authRepository: { findEmailTakenByOtherUser: jest.fn() },
}));
jest.mock("../../src/grpc/backoffice.client.js", () => ({
  isAdminEmailTaken: jest.fn(),
}));

import { isAdminEmailTaken } from "../../src/grpc/backoffice.client.js";
import { assertEmailAvailable } from "../../src/lib/email-availability.js";
import { authRepository } from "../../src/repositories/auth.repository.js";

const findTaken =
  authRepository.findEmailTakenByOtherUser as unknown as jest.Mock;
const adminTaken = isAdminEmailTaken as unknown as jest.Mock;

describe("assertEmailAvailable", () => {
  beforeEach(() => {
    findTaken.mockReset();
    adminTaken.mockReset();
  });

  it("passes when neither an AuthUser nor an admin owns the email", async () => {
    findTaken.mockResolvedValue(null);
    adminTaken.mockResolvedValue(false);

    await expect(
      assertEmailAvailable("free@example.com", "user-1")
    ).resolves.toBeUndefined();
  });

  it("409s when another AuthUser owns the email", async () => {
    findTaken.mockResolvedValue({ id: "user-2" });

    await expect(
      assertEmailAvailable("taken@example.com", "user-1")
    ).rejects.toMatchObject({ statusCode: 409, message: "AUTH_EMAIL_EXISTS" });
    expect(adminTaken).not.toHaveBeenCalled();
  });

  it("409s when an admin account owns the email", async () => {
    findTaken.mockResolvedValue(null);
    adminTaken.mockResolvedValue(true);

    await expect(
      assertEmailAvailable("admin@example.com", "user-1")
    ).rejects.toMatchObject({ statusCode: 409, message: "AUTH_EMAIL_EXISTS" });
  });

  it("fails closed with 503 when backoffice-service is unreachable", async () => {
    findTaken.mockResolvedValue(null);
    adminTaken.mockRejectedValue(new Error("breaker open"));

    await expect(
      assertEmailAvailable("admin@example.com", "user-1")
    ).rejects.toMatchObject({ statusCode: 503 });
  });
});
