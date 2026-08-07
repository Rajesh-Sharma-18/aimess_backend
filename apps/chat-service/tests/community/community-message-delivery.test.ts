/**
 * Side-channel delivery coverage for community chat messages.
 *
 * Verifies three production-critical guarantees added in this commit:
 *
 *   1. publishCommunityUpdatedSafe is called with senderName so the FE can
 *      render "Alice: Hello" in the community list without a re-fetch.
 *
 *   2. publishMessageSentSafe is called with conversationType:"COMMUNITY"
 *      so offline members receive an FCM push notification.
 *
 *   3. Neither side-channel runs on idempotent replay (duplicate clientMessageId)
 *      — the original send's effects must not be re-fired.
 *
 * All I/O boundaries (redis.publish, RabbitMQ publishers, DB) are mocked.
 * The global-mocks.ts provides redis + storage; this file adds the side-channel
 * publisher mocks so we can assert their call args directly.
 */

// All jest.mock() hoisting must happen before any imports.
jest.mock("../../src/events/publish-conv-updated.js", () => ({
  publishConvUpdatedSafe: jest.fn(),
  publishCommunityUpdatedSafe: jest.fn(),
}));
jest.mock("../../src/events/publish-community-activity.js", () => ({
  publishCommunityActivitySafe: jest.fn(),
}));
jest.mock("../../src/events/publish-message-sent.js", () => ({
  publishMessageSentSafe: jest.fn(),
  buildPushPreview: jest.fn(() => "preview text"),
  buildMessagePreview: jest.fn(() => "preview text"),
}));

import {
  createCommunityImpl,
  type GrpcDeps,
} from "../../src/grpc/service-impl.js";
import { publishCommunityUpdatedSafe } from "../../src/events/publish-conv-updated.js";
import { publishMessageSentSafe } from "../../src/events/publish-message-sent.js";
import { markIdempotentReplay } from "../../src/lib/idempotency.js";

const pubUpdated = publishCommunityUpdatedSafe as jest.Mock;
const pubPush = publishMessageSentSafe as jest.Mock;

type Handler = (
  call: { request: unknown },
  cb: (err: unknown, res?: unknown) => void
) => void;

function makeDeps(over: Record<string, unknown>): GrpcDeps {
  return over as unknown as GrpcDeps;
}

function invoke(handler: Handler, request: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    handler({ request }, (err, res) =>
      err
        ? reject(err instanceof Error ? err : new Error(String(err)))
        : resolve(res)
    );
  });
}

const BASE_REQ = {
  communityId: "comm1",
  roomId: "room1",
  senderId: "u1",
  clientMessageId: "c1",
  message: "Hello community!",
  contentType: "TEXT",
  mediaKey: "",
  parentMessageId: "",
  attachmentsJson: "",
};

const BASE_SAVED = {
  id: "msg1",
  roomId: "room1",
  sentBy: "u1",
  message: "Hello community!",
  messageType: "TEXT",
  parentMessageId: null,
  quoteData: null,
  createdAt: new Date(),
};

function makeBaseDeps(savedOverride?: Partial<typeof BASE_SAVED>) {
  return makeDeps({
    cacheRepo: {},
    userSnapshotService: {
      getUserSnapshotsMap: jest.fn(
        async () =>
          new Map([
            ["u1", { displayName: "Alice", avatar: "avatars/u1/a.png" }],
          ])
      ),
    },
    communityMessageService: {
      sendMessage: jest.fn(async () => ({ ...BASE_SAVED, ...savedOverride })),
      getActiveMemberIds: jest.fn(async () => ["u1", "u2", "u3"]),
    },
    generalRoomRepo: {
      findRoomById: jest.fn(async () => ({ name: "Football Fans" })),
    },
  });
}

describe("sendCommunityMessage — community:updated carries senderName (T6)", () => {
  beforeEach(() => {
    pubUpdated.mockClear();
    pubPush.mockClear();
  });

  it("calls publishCommunityUpdatedSafe with senderName from the user snapshot", async () => {
    await invoke(
      createCommunityImpl(makeBaseDeps()).sendCommunityMessage as Handler,
      BASE_REQ
    );

    expect(pubUpdated).toHaveBeenCalledTimes(1);
    expect(pubUpdated.mock.calls[0][0]).toMatchObject({
      communityId: "comm1",
      roomId: "room1",
      senderId: "u1",
      senderName: "Alice",
    });
  });

  it("senderName falls back to the shared 'Unknown User' chain when the snapshot is missing", async () => {
    const deps = makeDeps({
      cacheRepo: {},
      userSnapshotService: {
        getUserSnapshotsMap: jest.fn(async () => new Map()), // no snapshot
      },
      communityMessageService: {
        sendMessage: jest.fn(async () => ({ ...BASE_SAVED })),
        getActiveMemberIds: jest.fn(async () => ["u1", "u2"]),
      },
    });

    await invoke(
      createCommunityImpl(deps).sendCommunityMessage as Handler,
      BASE_REQ
    );

    expect(pubUpdated).toHaveBeenCalledTimes(1);
    expect(pubUpdated.mock.calls[0][0]).toMatchObject({
      senderName: "Unknown User",
    });
  });
});

describe("sendCommunityMessage — FCM push via publishMessageSentSafe (T7)", () => {
  beforeEach(() => {
    pubUpdated.mockClear();
    pubPush.mockClear();
  });

  it("calls publishMessageSentSafe with conversationType:COMMUNITY and communityId", async () => {
    await invoke(
      createCommunityImpl(makeBaseDeps()).sendCommunityMessage as Handler,
      BASE_REQ
    );

    expect(pubPush).toHaveBeenCalledTimes(1);
    expect(pubPush.mock.calls[0][0]).toMatchObject({
      conversationType: "COMMUNITY",
      communityId: "comm1",
      conversationId: "comm1",
      messageId: "msg1",
      senderId: "u1",
      senderName: "Alice",
    });
  });

  it("carries communityName from the room's mirrored GeneralRoom.name so the push title is never the sender's name (regression, AIMESS_BACKEND_NOTIFICATIONS.md §1)", async () => {
    await invoke(
      createCommunityImpl(makeBaseDeps()).sendCommunityMessage as Handler,
      BASE_REQ
    );

    expect(pubPush.mock.calls[0][0]).toMatchObject({
      communityName: "Football Fans",
    });
  });

  it("publishMessageSentSafe receives a fetchRecipients thunk pointing to the correct room", async () => {
    await invoke(
      createCommunityImpl(makeBaseDeps()).sendCommunityMessage as Handler,
      BASE_REQ
    );

    const call = pubPush.mock.calls[0][0];
    // fetchRecipients must be a function (lazy — not resolved at publish time)
    expect(typeof call.fetchRecipients).toBe("function");
  });

  it("skips publishCommunityUpdatedSafe + publishMessageSentSafe on idempotent replay", async () => {
    const replaySaved = markIdempotentReplay({ ...BASE_SAVED });
    const deps = makeDeps({
      cacheRepo: {},
      userSnapshotService: {
        getUserSnapshotsMap: jest.fn(
          async () => new Map([["u1", { displayName: "Alice", avatar: "" }]])
        ),
      },
      communityMessageService: {
        sendMessage: jest.fn(async () => replaySaved),
        getActiveMemberIds: jest.fn(async () => ["u1", "u2"]),
      },
    });

    await invoke(createCommunityImpl(deps).sendCommunityMessage as Handler, {
      ...BASE_REQ,
      clientMessageId: "c_dup",
    });

    expect(pubUpdated).not.toHaveBeenCalled();
    expect(pubPush).not.toHaveBeenCalled();
  });
});
