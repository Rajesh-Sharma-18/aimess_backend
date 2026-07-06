/**
 * Unit tests for {@link runSchedulerTick} — the announcement scheduler must
 * survive a transient PostgreSQL disconnect ("Connection terminated
 * unexpectedly") without crashing and must keep working on the next tick,
 * with no process restart. Style mirrors
 * `messaging/__tests__/consume-admin-report-ingest.test.ts`: monkey-patch the
 * `announcementRepository` functions at runtime, no live Postgres. The
 * RabbitMQ publish module is mocked via `node:test`'s `mock.module` — claiming
 * a row fires a real (fire-and-forget) broker connect in production code, and
 * these tests only care about the DB-resilience behavior.
 *
 * Run via `tsx --experimental-test-module-mocks --test "src/lib/__tests__/announcement-scheduler.test.ts"`
 * (module mocking is still experimental in Node 24 — hence the flag).
 */
import assert from "node:assert/strict";
import { describe, it, beforeEach, mock } from "node:test";

import { announcementRepository } from "../../repositories/index.js";

mock.module("../../messaging/publish-announcement-delivery.js", {
  namedExports: {
    enqueueAnnouncementDeliverySafe: () => {
      // no-op: no live RabbitMQ broker in this unit test
    },
  },
});

const { runSchedulerTick } = await import("../announcement-scheduler.js");

type DueRow = {
  id: string;
  title: string;
  description: string;
  target: "ALL" | "COMMUNITY";
  communityId: string | null;
};

let findDueScheduledImpl: () => Promise<DueRow[]>;
let claimScheduledImpl: (id: string) => Promise<boolean>;
let claimedIds: string[];

const repo = announcementRepository as unknown as {
  findDueScheduled: (now: Date) => Promise<DueRow[]>;
  claimScheduled: (id: string) => Promise<boolean>;
};

function connectionTerminatedError(): Error {
  return new Error("Connection terminated unexpectedly");
}

beforeEach(() => {
  claimedIds = [];
  findDueScheduledImpl = () => Promise.resolve([]);
  claimScheduledImpl = (id) => {
    claimedIds.push(id);
    return Promise.resolve(true);
  };
  repo.findDueScheduled = () => findDueScheduledImpl();
  repo.claimScheduled = (id) => claimScheduledImpl(id);
});

describe("runSchedulerTick", () => {
  it("skips the tick cleanly when findDueScheduled hits a transient disconnect", async () => {
    findDueScheduledImpl = () => Promise.reject(connectionTerminatedError());

    await assert.doesNotReject(() => runSchedulerTick());
    assert.deepEqual(claimedIds, []);
  });

  it("recovers on the next tick after a transient disconnect — no restart needed", async () => {
    findDueScheduledImpl = () => Promise.reject(connectionTerminatedError());
    await runSchedulerTick();

    findDueScheduledImpl = () =>
      Promise.resolve([
        {
          id: "ann-1",
          title: "t",
          description: "d",
          target: "ALL",
          communityId: null,
        },
      ]);
    await runSchedulerTick();

    assert.deepEqual(claimedIds, ["ann-1"]);
  });

  it("isolates a per-row claim failure so remaining due rows still get claimed", async () => {
    findDueScheduledImpl = () =>
      Promise.resolve([
        {
          id: "ann-bad",
          title: "t",
          description: "d",
          target: "ALL",
          communityId: null,
        },
        {
          id: "ann-good",
          title: "t",
          description: "d",
          target: "ALL",
          communityId: null,
        },
      ]);
    claimScheduledImpl = (id) => {
      if (id === "ann-bad") return Promise.reject(connectionTerminatedError());
      claimedIds.push(id);
      return Promise.resolve(true);
    };

    await assert.doesNotReject(() => runSchedulerTick());
    assert.deepEqual(claimedIds, ["ann-good"]);
  });
});
