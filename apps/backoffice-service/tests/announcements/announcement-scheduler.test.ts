/**
 * Announcement scheduler tick (announcement-scheduler.ts) — the poller that
 * turns a due SCHEDULED row into an enqueued delivery, plus the recovery sweep
 * for rows a dying process left claimed but undelivered.
 */
jest.mock("../../src/repositories/index.js", () => ({
  announcementRepository: {
    findDueScheduled: jest.fn(async () => []),
    claimScheduled: jest.fn(async () => true),
    findStalledProcessing: jest.fn(async () => []),
    findHalfDeliveredProcessing: jest.fn(async () => []),
    markFailed: jest.fn(async () => undefined),
  },
}));
jest.mock("../../src/messaging/publish-announcement-delivery.js", () => ({
  enqueueAnnouncementDeliverySafe: jest.fn(),
}));

import { announcementRepository } from "../../src/repositories/index.js";
import { enqueueAnnouncementDeliverySafe } from "../../src/messaging/publish-announcement-delivery.js";
import { runSchedulerTick } from "../../src/lib/announcement-scheduler.js";

const repo = announcementRepository as unknown as Record<string, jest.Mock>;
const enqueue = enqueueAnnouncementDeliverySafe as jest.Mock;

const AID = "3f2b6c1e-4a5d-4e6f-8a9b-0c1d2e3f4a5b";

function dueRow(overrides: Record<string, unknown> = {}) {
  return {
    id: AID,
    title: "Maintenance",
    description: "Down at 2am",
    target: "ALL",
    kind: "ANNOUNCEMENT",
    deviceType: "ANDROID",
    communityId: null,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  repo.findDueScheduled.mockResolvedValue([]);
  repo.claimScheduled.mockResolvedValue(true);
  repo.findStalledProcessing.mockResolvedValue([]);
  repo.findHalfDeliveredProcessing.mockResolvedValue([]);
});

describe("runSchedulerTick", () => {
  it("claims a due announcement and enqueues delivery with its deviceType", async () => {
    repo.findDueScheduled.mockResolvedValue([dueRow()]);

    await runSchedulerTick(new Date("2026-08-20T10:00:00.000Z"));

    expect(repo.claimScheduled).toHaveBeenCalledWith(AID);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0][0]).toMatchObject({
      announcementId: AID,
      deviceType: "ANDROID",
      cursor: 0,
      batchId: `ann:${AID}:cursor:0`,
    });
  });

  it("skips a row another instance already claimed (CAS lost)", async () => {
    repo.findDueScheduled.mockResolvedValue([dueRow()]);
    repo.claimScheduled.mockResolvedValue(false);

    await runSchedulerTick();

    expect(enqueue).not.toHaveBeenCalled();
  });

  it("re-enqueues a PROCESSING row stalled with no recipients, under a fresh batchId", async () => {
    repo.findStalledProcessing.mockResolvedValue([
      dueRow({ deviceType: "ALL" }),
    ]);

    await runSchedulerTick();

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0][0].batchId).toBe(
      `ann:${AID}:cursor:0:requeue`
    );
  });

  it("marks a half-delivered PROCESSING row FAILED instead of replaying it", async () => {
    repo.findHalfDeliveredProcessing.mockResolvedValue([
      { id: AID, recipientCount: 200 },
    ]);

    await runSchedulerTick();

    // Never re-enqueued: the 200 already notified must not be notified twice.
    expect(enqueue).not.toHaveBeenCalled();
    expect(repo.markFailed).toHaveBeenCalledWith(
      AID,
      expect.stringContaining("200")
    );
  });

  it("survives a DB outage without throwing (the row stays SCHEDULED for the next tick)", async () => {
    repo.findDueScheduled.mockRejectedValue(new Error("connection terminated"));

    await expect(runSchedulerTick()).resolves.toBeUndefined();
    expect(enqueue).not.toHaveBeenCalled();
  });
});
