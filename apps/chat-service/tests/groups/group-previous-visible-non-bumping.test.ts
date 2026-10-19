// AIMESS-326: after a delete, the preview recalculation never lands on a non-bumping line
// (the leader's "deleted a message" is posted just before the recalculation runs).
import { GroupMessageRepository } from "../../src/repositories/group-message.repository.js";
import { PrivateMessageRepository } from "../../src/repositories/private-message.repository.js";
import { NON_BUMPING_SYSTEM_EVENTS } from "../../src/lib/system-message-policy.js";

function fakePrisma(model: string) {
  const calls: { findFirst?: any; pipeline?: any } = {};
  const delegate = {
    findFirst: jest.fn(async (args: unknown) => ((calls.findFirst = args), null)),
    aggregateRaw: jest.fn(async ({ pipeline }: { pipeline: unknown }) => ((calls.pipeline = pipeline), [])),
  };
  return { prisma: { [model]: delegate } as any, calls };
}

describe("previous-visible finders skip non-bumping system lines", () => {
  it("MESSAGE_DELETED is non-bumping", () => {
    expect(NON_BUMPING_SYSTEM_EVENTS).toContain("MESSAGE_DELETED");
  });

  it.each([
    ["groupMessage", (p: any) => new GroupMessageRepository(p)],
    ["privateMessage", (p: any) => new PrivateMessageRepository(p)],
  ])("%s", async (model, make) => {
    const { prisma, calls } = fakePrisma(model);
    const repo = make(prisma) as any;
    await repo.findPreviousVisible("room-1");
    expect(calls.findFirst.where.OR).toContainEqual({ systemEvent: { notIn: NON_BUMPING_SYSTEM_EVENTS } });
    await repo.findPreviousVisibleForUser("room-1", "user-1");
    expect(calls.pipeline[0].$match.systemEvent).toEqual({ $nin: NON_BUMPING_SYSTEM_EVENTS });
  });
});
