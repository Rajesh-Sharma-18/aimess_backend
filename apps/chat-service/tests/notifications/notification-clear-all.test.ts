/** AIMESS-45: "Clear all" soft-deletes every non-system notification and fans out once. */
import { NotificationService } from "../../src/services/notification.service.js";

function build(count = 3) {
  const repo = {
    deleteAll: jest.fn().mockResolvedValue({ count }),
    getUnreadFanout: jest
      .fn()
      .mockResolvedValue({ unreadCount: 0, selfHiddenSessions: [] }),
  };
  const redis = { publish: jest.fn().mockResolvedValue(1) };
  const service = new NotificationService(repo as never, redis as never);
  return { service, repo, redis };
}

describe("NotificationService.clearAll", () => {
  it("clears everything except system rows and tells the other devices", async () => {
    const { service, repo, redis } = build();

    const result = await service.clearAll("u1", "ALL");

    expect(result.cleared).toBe(3);
    const where = repo.deleteAll.mock.calls[0]![1] as { AND: unknown[] };
    expect(where.AND).toHaveLength(1);
    expect(where.AND[0]).toHaveProperty("NOT");
    expect(redis.publish).toHaveBeenCalled();
  });

  it("never clears the System tab", async () => {
    const { service, repo, redis } = build();

    const result = await service.clearAll("u1", "SYSTEM");

    expect(result.cleared).toBe(0);
    expect(repo.deleteAll).not.toHaveBeenCalled();
    expect(redis.publish).not.toHaveBeenCalled();
  });

  it("scopes to one category when asked", async () => {
    const { service, repo } = build();

    await service.clearAll("u1", "CALLS");

    const where = repo.deleteAll.mock.calls[0]![1] as { AND: unknown[] };
    expect(where.AND).toHaveLength(2);
  });
});
