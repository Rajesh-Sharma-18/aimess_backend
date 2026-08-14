/**
 * Settings → Chat → Read Receipt, enforced on the REST mark-read path.
 *
 * The switch is about what OTHERS learn, so only the outbound `message:read`
 * may be withheld: the read itself still lands (pointer advanced) and the
 * reader's own devices still get `read_sync`, or the reader's unread badge
 * would stop clearing on their other clients.
 *
 * The gRPC/socket mark-read handler is a second copy of this flow with the same
 * gate (grpc/service-impl.ts) — if this test moves, that copy needs the same
 * scrutiny.
 */
import request from "supertest";

import { buildApp, type BuiltMocks } from "../helpers/app-factory.js";
import { bearer, makeAccessToken, TEST_USER_ID } from "../helpers/auth.js";
import { invalidateAccountChatSettings } from "../../src/lib/account-chat-settings.js";
import { userGrpcClient } from "../../src/grpc/user-snapshot.client.js";

let app: import("express").Express;
let mocks: BuiltMocks;

const ROOM = "prv_read_privacy_1";

function setReadReceipts(readReceipts: boolean): void {
  (userGrpcClient.getChatSettings as jest.Mock).mockResolvedValue({
    autoDeleteTimer: "OFF",
    typingIndicators: true,
    readReceipts,
  });
}

const published = () =>
  mocks.redis.publish.mock.calls.map(([channel, raw]: [string, string]) => ({
    channel,
    ...(JSON.parse(raw) as { event: string }),
  }));

beforeEach(() => {
  ({ app, mocks } = buildApp());
  mocks.cacheRepo.getUserSnapshots.mockResolvedValue(new Map());
  // `roomId` is required on the read target: it is bound to the room before the
  // watermark advances, so a target that names no room is a no-op read.
  mocks.privateMessageRepo.findById.mockResolvedValue({
    id: "msg_hw_1",
    roomId: ROOM,
    sequenceNumber: 9,
  });
  mocks.privateRoomRepo.markReadUpTo.mockResolvedValue({
    roomId: ROOM,
    participants: [TEST_USER_ID, "peer-1"],
    unreadCountByUser: { [TEST_USER_ID]: 0 },
    lastMessageId: "msg_hw_1",
  });
  invalidateAccountChatSettings();
  setReadReceipts(true);
});

const markRead = () =>
  request(app)
    .post(`/api/chat/private/rooms/${ROOM}/read`)
    .set(bearer(makeAccessToken()))
    .send({ upToMessageId: "msg_hw_1" });

describe("read receipts disabled", () => {
  it("withholds message:read while still marking the room read", async () => {
    setReadReceipts(false);
    const res = await markRead();

    expect(res.status).toBe(200);
    // The read itself is unaffected — only its visibility to others is.
    expect(mocks.privateRoomRepo.markReadUpTo).toHaveBeenCalled();
    expect(published().some((p) => p.event === "message:read")).toBe(false);
    // The reader's own devices still clear their badge.
    expect(
      published().some(
        (p) => p.event === "read_sync" && p.channel === `user:${TEST_USER_ID}`
      )
    ).toBe(true);
  });

  it("broadcasts message:read normally when the switch is on", async () => {
    const res = await markRead();

    expect(res.status).toBe(200);
    expect(
      published().some(
        (p) => p.event === "message:read" && p.channel === `conv:${ROOM}`
      )
    ).toBe(true);
  });

  it("fails OPEN — a user-service outage must not silence receipts", async () => {
    (userGrpcClient.getChatSettings as jest.Mock).mockRejectedValue(
      new Error("user-service down")
    );
    // The client itself swallows the failure and returns the ON default; this
    // pins that the mark-read path inherits it rather than defaulting to off.
    const res = await markRead();

    expect(res.status).toBe(200);
    expect(published().some((p) => p.event === "message:read")).toBe(true);
  });
});
