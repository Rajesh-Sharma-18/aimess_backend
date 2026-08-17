/**
 * Push/inbox leg of the group moderation mute — the counterpart of community's
 * MEMBER_MUTED / MEMBER_UNMUTED notification.
 *
 * The `group:member:muted` socket fan-out only reaches devices that are ONLINE
 * when the mute lands. A member whose devices were all offline would otherwise
 * first learn about the mute from a send being rejected, which is exactly what
 * community avoids by pushing the target. This pins the queue contract that
 * notifications-service consumes (queue name, event type, payload fields).
 *
 * `amqplib` is mocked, so no broker is needed — same pattern as
 * publish-message-sent.test.ts.
 */
const sentToQueue = jest.fn();
const assertQueue = jest.fn(async () => undefined);

jest.mock("amqplib", () => ({
  __esModule: true,
  connect: jest.fn(async () => ({
    on: jest.fn(),
    createChannel: jest.fn(async () => ({
      assertQueue,
      sendToQueue: sentToQueue,
    })),
  })),
}));

// The GroupRoom row the publisher reads for the push header. `avatar` is a RAW
// object key — resolveMediaUrl (real, driven by the global storage mock) turns
// it into the URL the tray image is fetched from.
const findGroupRoom = jest.fn(async () => ({
  name: "Testing Invites",
  avatar: "group-avatars/grp_1/current.jpg",
}));
jest.mock("../../src/config/prisma.js", () => ({
  prisma: {
    groupRoom: { findUnique: (...a: unknown[]) => findGroupRoom(...a) },
  },
}));

import { ChatEvents } from "@aimess/shared-types";

import { publishGroupMemberMuteSafe } from "../../src/events/publish-group-member-added.js";

/** Let the fire-and-forget IIFE inside the publisher settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
}

function lastQueued(): { queue: string; body: Record<string, unknown> } {
  expect(sentToQueue).toHaveBeenCalled();
  const [queue, buf] = sentToQueue.mock.calls.at(-1) as [string, Buffer];
  return {
    queue,
    body: JSON.parse(buf.toString("utf8")) as Record<string, unknown>,
  };
}

beforeEach(() => {
  sentToQueue.mockClear();
});

describe("publishGroupMemberMuteSafe", () => {
  it("enqueues a MUTED event for the target on the shared chat.group queue", async () => {
    const until = new Date("2026-08-06T12:00:00.000Z");
    publishGroupMemberMuteSafe(ChatEvents.GROUP_MEMBER_MUTED, {
      roomId: "grp_1",
      groupName: "Testing Invites",
      targetUserId: "target-1",
      actorId: "admin-1",
      mutedUntil: until.toISOString(),
      eventAt: new Date(0).toISOString(),
    });
    await flush();

    const { queue, body } = lastQueued();
    // Queue name is part of the cross-service contract — notifications-service
    // asserts the same durable queue.
    expect(queue).toBe("chat.group.queue");
    expect(body.type).toBe("chat.group_member_muted");
    expect(body.data).toMatchObject({
      roomId: "grp_1",
      groupName: "Testing Invites",
      targetUserId: "target-1",
      actorId: "admin-1",
      mutedUntil: until.toISOString(),
    });
  });

  it("enqueues an UNMUTED event with a null expiry", async () => {
    publishGroupMemberMuteSafe(ChatEvents.GROUP_MEMBER_UNMUTED, {
      roomId: "grp_1",
      groupName: "Testing Invites",
      targetUserId: "target-1",
      actorId: "admin-1",
      mutedUntil: null,
      eventAt: new Date(0).toISOString(),
    });
    await flush();

    const { body } = lastQueued();
    expect(body.type).toBe("chat.group_member_unmuted");
    expect(body.data).toMatchObject({
      targetUserId: "target-1",
      mutedUntil: null,
    });
  });
});

/**
 * A group notification must represent the GROUP: the tray image is the group's
 * own avatar, resolved from the authoritative GroupRoom row at publish time —
 * never the acting admin's avatar, and never a stale copy captured by the
 * producer.
 */
describe("publishGroupMemberMuteSafe — group avatar for the push", () => {
  const mute = (groupName: string) =>
    publishGroupMemberMuteSafe(ChatEvents.GROUP_MEMBER_MUTED, {
      roomId: "grp_1",
      groupName,
      targetUserId: "target-1",
      actorId: "admin-1",
      mutedUntil: null,
      eventAt: new Date(0).toISOString(),
    });

  it("carries the group avatar as a resolved URL, not a raw object key", async () => {
    mute("Testing Invites");
    await flush();

    const { body } = lastQueued();
    const data = body.data as Record<string, unknown>;
    expect(data.groupAvatarUrl).toBe(
      "https://media.test/aimess-avatars/group-avatars/grp_1/current.jpg"
    );
  });

  it("takes name AND image from the SAME row, so a rename can't desync them", async () => {
    findGroupRoom.mockResolvedValueOnce({
      name: "Dubai Ice Rink",
      avatar: "group-avatars/grp_1/new.jpg",
    });
    // Producer still carries the pre-rename name — the row must win.
    mute("Old Group");
    await flush();

    const data = lastQueued().body.data as Record<string, unknown>;
    expect(data.groupName).toBe("Dubai Ice Rink");
    expect(data.groupAvatarUrl).toBe(
      "https://media.test/aimess-avatars/group-avatars/grp_1/new.jpg"
    );
  });

  it("omits the image entirely when the group has no avatar", async () => {
    findGroupRoom.mockResolvedValueOnce({ name: "No Picture", avatar: "" });
    mute("No Picture");
    await flush();

    const data = lastQueued().body.data as Record<string, unknown>;
    // Absent, NOT "" — the client applies its own placeholder rather than
    // trying to render an empty attachment.
    expect(data).not.toHaveProperty("groupAvatarUrl");
  });
});
