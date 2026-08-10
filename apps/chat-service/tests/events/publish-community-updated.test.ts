/**
 * `community:updated` — the community list bump-to-top / unread fan-out.
 *
 * REGRESSION: a 60-second `community:fresh-join:*` Redis key used to suppress
 * this event for any member who had recently been synced as ACTIVE — which
 * includes the creator, from the instant the community was created. The result
 * was that a message sent by a regular member never reached the other members'
 * community list (no lastActivity move, no unread bump) until every one of
 * those windows had expired, which made the bug look like "the list only works
 * after the admin has sent something". The bump must now reach every active
 * member, regardless of role or how recently they joined.
 */
import { publishCommunityUpdated } from "../../src/events/publish-conv-updated.js";

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
    // `mget` deliberately absent: publishCommunityUpdated must not consult any
    // suppression key. If it ever does again, this test throws instead of
    // silently failing open.
    redis: { pipeline: () => pipeline } as never,
    publishCalls,
  };
}

const dataFor = (calls: PublishCall[], userId: string) =>
  JSON.parse(calls.find((c) => c.channel === `user:${userId}`)!.payload).data;

describe("publishCommunityUpdated — member-sent message reaches every member", () => {
  it("fans out to the admin and every other member when a non-admin sends", async () => {
    const { redis, publishCalls } = makeFakeRedis();

    await publishCommunityUpdated({
      redis,
      communityId: "c1",
      roomId: "c1",
      // A = admin (never sent a message), B = the sender, C = another member.
      memberIds: ["A", "B", "C"],
      senderId: "B",
      senderName: "Bob",
      lastMessageId: "m1",
      lastMessageAt: 1000,
      preview: { contentType: "TEXT", text: "Hello" },
    });

    expect(publishCalls.map((c) => c.channel).sort()).toEqual([
      "user:A",
      "user:B",
      "user:C",
    ]);

    for (const viewer of ["A", "C"]) {
      expect(dataFor(publishCalls, viewer)).toMatchObject({
        communityId: "c1",
        lastMessageId: "m1",
        lastMessageAt: 1000,
        lastMessage: { contentType: "TEXT", text: "Hello" },
        senderId: "B",
        senderName: "Bob",
        unread: true,
      });
    }
  });

  it("never marks the sender's own message unread", async () => {
    const { redis, publishCalls } = makeFakeRedis();

    await publishCommunityUpdated({
      redis,
      communityId: "c1",
      roomId: "c1",
      memberIds: ["A", "B"],
      senderId: "B",
      senderName: "Bob",
      lastMessageId: "m1",
      lastMessageAt: 1000,
      preview: { contentType: "TEXT", text: "Hello" },
    });

    expect(dataFor(publishCalls, "B").unread).toBe(false);
    expect(dataFor(publishCalls, "A").unread).toBe(true);
  });

  it("keeps SYSTEM lifecycle lines sender-less and unread for nobody", async () => {
    const { redis, publishCalls } = makeFakeRedis();

    await publishCommunityUpdated({
      redis,
      communityId: "c1",
      roomId: "c1",
      memberIds: ["A", "B"],
      senderId: "B",
      senderName: "Bob",
      lastMessageId: "m1",
      lastMessageAt: 1000,
      preview: { contentType: "SYSTEM", text: "Bob is now a moderator" },
    });

    for (const call of publishCalls) {
      expect(JSON.parse(call.payload).data).toMatchObject({
        senderId: "",
        senderName: "",
        unread: false,
      });
    }
  });
});
