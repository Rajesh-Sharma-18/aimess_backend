/**
 * sessionRepository.isSessionActive — regression for "logged-out phone still
 * rings". A client that signs out locally (refresh expired/rejected) never
 * revokes its Session row, so the push path (gRPC isSessionActive) kept
 * reporting it active and delivered call pushes. Same rule as
 * listActiveByUserId: require an unrevoked, unexpired refresh token.
 */
const mockFindFirst = jest.fn(async () => null);

jest.mock("../../src/config/prisma.js", () => ({
  prisma: {
    session: { findFirst: mockFindFirst },
  },
}));

import { sessionRepository } from "../../src/repositories/session.repository.js";

describe("sessionRepository.isSessionActive — requires a live refresh token", () => {
  it("filters on revokedAt: null AND an unrevoked, unexpired refresh token", async () => {
    await sessionRepository.isSessionActive("session-1");

    expect(mockFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "session-1",
          revokedAt: null,
          refreshTokens: {
            some: {
              revokedAt: null,
              expiresAt: { gt: expect.any(Date) },
            },
          },
        },
      })
    );
  });
});
