/**
 * conv:updated PROJECTION VERSIONING.
 *
 * A delete legitimately moves `lastMessageAt` BACKWARD — to the previous
 * surviving message, or to nothing at all. A client ordering list rows by
 * timestamp cannot tell that from a stale bump, which is exactly why the
 * `deleteRecalc` marker had to be invented: it tells the client "ignore your
 * monotonic guard this once". An override is not an ordering, though — two
 * delete recalcs, or a delete racing a send, still have no defined order.
 *
 * `projectionRevision` is that ordering: one monotonic per-room number, sourced
 * from the room's revision at the mutation that produced the payload. The
 * client keeps ONE rule for every payload — apply if greater than what I hold —
 * whichever way the timestamp moved.
 *
 * `hasLastMessage` is the other half: `lastMessageId: ""` plus an empty preview
 * ALSO describes a thin payload that simply didn't carry message details, so
 * without this flag a client cannot tell "this room is empty, clear the row"
 * from "I wasn't sent the details".
 */
import { publishConvUpdated } from "../../src/events/publish-conv-updated.js";

interface PublishCall {
  channel: string;
  payload: string;
}

function makeFakeRedis() {
  const publishCalls: PublishCall[] = [];
  const pipeline = {
    publish(channel: string, payload: string) {
      publishCalls.push({ channel, payload });
      return pipeline;
    },
    async exec() {
      return [];
    },
  };
  return {
    // The helper only ever touches `.pipeline().publish/exec`.
    redis: { pipeline: () => pipeline } as never,
    publishCalls,
  };
}

/** The single payload published to the one recipient. */
function onlyPayload(calls: PublishCall[]): Record<string, unknown> {
  return JSON.parse(calls[0]!.payload).data as Record<string, unknown>;
}

const BASE = {
  type: "PRIVATE" as const,
  roomId: "prv_projection_1",
  recipientIds: ["viewer"],
  senderId: "sender",
  lastMessageAt: 1717000000123,
};

describe("conv:updated — projectionRevision", () => {
  it("defaults to the previewed message's own revision on an ordinary bump", async () => {
    // For a NEW message the mutation IS the previewed message, so its revision
    // already is the room's newest — every existing call site gets the field
    // without being touched.
    const { redis, publishCalls } = makeFakeRedis();

    await publishConvUpdated({
      ...BASE,
      redis,
      lastMessageId: "msg-9",
      preview: { contentType: "TEXT", text: "hi", revision: 41 },
    });

    const data = onlyPayload(publishCalls);
    expect(data.projectionRevision).toBe(41);
    expect(data.hasLastMessage).toBe(true);
  });

  it("prefers an explicit revision over the preview's, for a delete recalc", async () => {
    const { redis, publishCalls } = makeFakeRedis();

    await publishConvUpdated({
      ...BASE,
      redis,
      // Points BACKWARD at an older surviving message…
      lastMessageId: "msg-prev",
      lastMessageAt: 1717000000000,
      preview: { contentType: "TEXT", text: "older", revision: 12 },
      deleteRecalc: true,
      // …while the DELETE that caused it is the newest mutation in the room.
      projectionRevision: 55,
    });

    const data = onlyPayload(publishCalls);
    expect(data.projectionRevision).toBe(55);
    // The previewed message keeps its own (older) revision — publishing that as
    // the projection version is the specific mistake this field exists to stop.
    expect((data.lastMessage as { revision: number }).revision).toBe(12);
  });

  it("keeps projectionRevision monotonic while lastMessageAt moves backwards", async () => {
    const { redis, publishCalls } = makeFakeRedis();

    // A send, then the delete of that message rolling the room back.
    await publishConvUpdated({
      ...BASE,
      redis,
      lastMessageId: "msg-new",
      lastMessageAt: 2000,
      preview: { contentType: "TEXT", text: "newest", revision: 70 },
    });
    await publishConvUpdated({
      ...BASE,
      redis,
      lastMessageId: "msg-old",
      lastMessageAt: 1000,
      preview: { contentType: "TEXT", text: "older", revision: 12 },
      deleteRecalc: true,
      projectionRevision: 71,
    });

    const [first, second] = publishCalls.map(
      (c) => JSON.parse(c.payload).data as Record<string, number>
    );
    expect(second!.lastMessageAt).toBeLessThan(first!.lastMessageAt as number);
    expect(second!.projectionRevision).toBeGreaterThan(
      first!.projectionRevision as number
    );
  });

  it("marks an EMPTY projection explicitly instead of with '' and 0", async () => {
    const { redis, publishCalls } = makeFakeRedis();

    await publishConvUpdated({
      ...BASE,
      redis,
      senderId: "",
      lastMessageId: "",
      lastMessageAt: 0,
      preview: { contentType: "", text: "" },
      deleteRecalc: true,
      projectionRevision: 56,
    });

    const data = onlyPayload(publishCalls);
    expect(data.hasLastMessage).toBe(false);
    expect(data.projectionRevision).toBe(56);
    // The pre-existing empty-string fields are untouched — this is additive, so
    // current clients keep parsing exactly what they parsed before.
    expect(data.lastMessageId).toBe("");
  });

  it("omits the field entirely when no revision is known", async () => {
    const { redis, publishCalls } = makeFakeRedis();

    await publishConvUpdated({
      ...BASE,
      type: "GROUP",
      redis,
      lastMessageId: "m-1",
      preview: { contentType: "TEXT", text: "hi" },
    });

    const data = onlyPayload(publishCalls);
    // Sending 0 would make a client ordering strictly by this number discard a
    // real update. Absence is the honest answer.
    expect("projectionRevision" in data).toBe(false);
    expect(data.hasLastMessage).toBe(true);
  });

  it("publishes the SAME projectionRevision to every recipient", async () => {
    // Previews are personalized per recipient (delete-for-me overrides); the
    // projection MUTATION is one event and must carry one version.
    const { redis, publishCalls } = makeFakeRedis();

    await publishConvUpdated({
      ...BASE,
      redis,
      recipientIds: ["a", "b", "c"],
      lastMessageId: "msg-9",
      preview: { contentType: "TEXT", text: "hi", revision: 41 },
    });

    const revisions = publishCalls.map(
      (c) => JSON.parse(c.payload).data.projectionRevision as number
    );
    expect(revisions).toEqual([41, 41, 41]);
  });
});
