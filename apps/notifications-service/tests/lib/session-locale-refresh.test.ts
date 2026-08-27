/**
 * C3 — a device's PUSH language follows the session that owns it.
 *
 * `DeviceToken.locale` used to be written at registration and never again, so
 * changing language in the app flipped every socket surface at once and left
 * the push tray on the old language until the client happened to re-register.
 * The gateway now publishes the change; this is the write that applies it.
 */
import { deviceTokenRepository } from "../../src/repositories/device-token.repository.js";
import { prisma } from "../../src/config/prisma.js";

jest.mock("../../src/config/prisma.js", () => ({
  prisma: { deviceToken: { updateMany: jest.fn() } },
}));

const updateMany = prisma.deviceToken.updateMany as unknown as jest.Mock;

beforeEach(() => {
  updateMany.mockReset();
  updateMany.mockResolvedValue({ count: 1 });
});

describe("updateLocaleBySession", () => {
  it("moves only the tokens of the session that changed language", async () => {
    await deviceTokenRepository.updateLocaleBySession("u1", "sess-a", "th");

    expect(updateMany).toHaveBeenCalledWith({
      where: { userId: "u1", sessionId: "sess-a" },
      data: { locale: "th" },
    });
  });

  it("scopes by session, never by user alone — device 2 must not move", async () => {
    await deviceTokenRepository.updateLocaleBySession("u1", "sess-a", "vi");

    const where = updateMany.mock.calls[0][0].where as Record<string, unknown>;
    expect(where.sessionId).toBe("sess-a");
    expect(Object.keys(where).sort()).toEqual(["sessionId", "userId"]);
  });

  it("reports how many rows moved (0 = session with no push token)", async () => {
    updateMany.mockResolvedValue({ count: 0 });
    await expect(
      deviceTokenRepository.updateLocaleBySession("u1", "sess-none", "en")
    ).resolves.toBe(0);
  });
});
