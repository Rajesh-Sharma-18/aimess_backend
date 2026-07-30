/**
 * sessionRepository.listActiveByUserId — regression for the "expired session
 * still shows in Active Devices" bug.
 *
 * Session has no expiresAt of its own; a row only stops being "active" when
 * explicitly revoked. Once its last refresh token passes its 7-day
 * expiresAt, nothing ever set revokedAt, so the row kept appearing forever.
 * Fix: the list query also requires an unrevoked, unexpired refresh token.
 */
const mockFindMany = jest.fn(async () => []);

jest.mock("../../src/config/prisma.js", () => ({
  prisma: {
    session: { findMany: mockFindMany },
  },
}));

import { sessionRepository } from "../../src/repositories/session.repository.js";

describe("sessionRepository.listActiveByUserId — excludes sessions with no valid refresh token", () => {
  beforeEach(() => {
    mockFindMany.mockClear();
  });

  it("filters on revokedAt: null AND an unrevoked, unexpired refresh token", async () => {
    await sessionRepository.listActiveByUserId("user-1");

    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: "user-1",
          revokedAt: null,
          refreshTokens: {
            some: {
              revokedAt: null,
              expiresAt: { gt: expect.any(Date) },
            },
          },
        }),
      })
    );
  });
});
