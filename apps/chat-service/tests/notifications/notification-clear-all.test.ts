/** AIMESS-45: "Clear all" soft-deletes every notification and fans out once. */
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
  it("clears every notification, System included, and tells the other devices", async () => {
    const { service, repo, redis } = build();

    const result = await service.clearAll("u1");

    expect(result.cleared).toBe(3);
    expect(repo.deleteAll).toHaveBeenCalledWith("u1", undefined);
    expect(redis.publish).toHaveBeenCalled();
  });

  it("publishes nothing when there was nothing to clear", async () => {
    const { service, redis } = build(0);

    await service.clearAll("u1");

    expect(redis.publish).not.toHaveBeenCalled();
  });
});
