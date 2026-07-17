/**
 * checkMediaAccess (src/grpc/service-impl.ts createMessagingImpl) — the gRPC
 * media-service calls to authorize a download-url request against a chat
 * resource. Media access is intentionally HISTORICAL: a GROUP_CHAT/
 * COMMUNITY_CHAT member row need only exist (any status — ACTIVE, LEFT,
 * KICKED, BANNED), not be currently active, so previously-shared attachments
 * stay downloadable after leaving/removal/ban. A user with no member row at
 * all is denied UNLESS the community is PUBLIC — mirroring
 * assertCommunityReadAccess, which already lets non-members read PUBLIC
 * community message history (so media shouldn't be stricter than history).
 */
import {
  createMessagingImpl,
  type GrpcDeps,
} from "../../src/grpc/service-impl.js";

jest.mock("../../src/events/publish-conv-updated.js", () => ({
  publishConvUpdatedSafe: jest.fn(),
  publishCommunityUpdatedSafe: jest.fn(),
}));
jest.mock("../../src/events/publish-community-activity.js", () => ({
  publishCommunityActivitySafe: jest.fn(),
}));
jest.mock("../../src/events/publish-message-sent.js", () => ({
  publishMessageSentSafe: jest.fn(),
  buildPushPreview: jest.fn(() => ""),
  buildMessagePreview: jest.fn(() => ""),
}));

function makeDeps(over: Record<string, unknown>): GrpcDeps {
  return over as unknown as GrpcDeps;
}

type Handler = (
  call: { request: unknown },
  cb: (err: unknown, res?: unknown) => void
) => void;

function invoke(handler: Handler, request: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    handler({ request }, (err, res) =>
      err
        ? reject(err instanceof Error ? err : new Error(String(err)))
        : resolve(res)
    );
  });
}

describe("checkMediaAccess — historical membership", () => {
  it("GROUP_CHAT: a LEFT member is still allowed (historical access survives leaving)", async () => {
    const findByRoomAndUser = jest.fn().mockResolvedValue({
      roomId: "g1",
      userId: "u2",
      status: "LEFT",
    });
    const deps = makeDeps({ groupMemberRepo: { findByRoomAndUser } });
    const { checkMediaAccess } = createMessagingImpl(deps);

    const res = await invoke(checkMediaAccess as unknown as Handler, {
      userId: "u2",
      scope: "GROUP_CHAT",
      resourceId: "g1",
    });

    expect(res).toEqual({ allowed: true });
    expect(findByRoomAndUser).toHaveBeenCalledWith("g1", "u2");
  });

  it("COMMUNITY_CHAT: a BANNED member is still allowed (historical access survives a ban)", async () => {
    const findByRoomAndUser = jest.fn().mockResolvedValue({
      roomId: "c1",
      userId: "u2",
      status: "banned",
    });
    const deps = makeDeps({ roomMemberRepo: { findByRoomAndUser } });
    const { checkMediaAccess } = createMessagingImpl(deps);

    const res = await invoke(checkMediaAccess as unknown as Handler, {
      userId: "u2",
      scope: "COMMUNITY_CHAT",
      resourceId: "c1",
    });

    expect(res).toEqual({ allowed: true });
  });

  it("COMMUNITY_CHAT: a user who was NEVER a member is allowed when the community is PUBLIC", async () => {
    const findByRoomAndUser = jest.fn().mockResolvedValue(null);
    const findRoomById = jest.fn().mockResolvedValue({
      id: "c1",
      communityType: "PUBLIC",
    });
    const deps = makeDeps({
      roomMemberRepo: { findByRoomAndUser },
      generalRoomRepo: { findRoomById },
    });
    const { checkMediaAccess } = createMessagingImpl(deps);

    const res = await invoke(checkMediaAccess as unknown as Handler, {
      userId: "newcomer",
      scope: "COMMUNITY_CHAT",
      resourceId: "c1",
    });

    expect(res).toEqual({ allowed: true });
    expect(findRoomById).toHaveBeenCalledWith("c1");
  });

  it("COMMUNITY_CHAT: a user who was NEVER a member is denied when the community is PRIVATE", async () => {
    const findByRoomAndUser = jest.fn().mockResolvedValue(null);
    const findRoomById = jest.fn().mockResolvedValue({
      id: "c1",
      communityType: "PRIVATE",
    });
    const deps = makeDeps({
      roomMemberRepo: { findByRoomAndUser },
      generalRoomRepo: { findRoomById },
    });
    const { checkMediaAccess } = createMessagingImpl(deps);

    const res = await invoke(checkMediaAccess as unknown as Handler, {
      userId: "stranger",
      scope: "COMMUNITY_CHAT",
      resourceId: "c1",
    });

    expect(res).toEqual({ allowed: false });
  });

  it("COMMUNITY_CHAT: a user who was NEVER a member is denied when the room's visibility is unknown (fail-closed)", async () => {
    const findByRoomAndUser = jest.fn().mockResolvedValue(null);
    const findRoomById = jest.fn().mockResolvedValue(null);
    const deps = makeDeps({
      roomMemberRepo: { findByRoomAndUser },
      generalRoomRepo: { findRoomById },
    });
    const { checkMediaAccess } = createMessagingImpl(deps);

    const res = await invoke(checkMediaAccess as unknown as Handler, {
      userId: "stranger",
      scope: "COMMUNITY_CHAT",
      resourceId: "unsynced-room",
    });

    expect(res).toEqual({ allowed: false });
  });

  it("GROUP_CHAT: a user who was NEVER a member is denied", async () => {
    const findByRoomAndUser = jest.fn().mockResolvedValue(null);
    const deps = makeDeps({ groupMemberRepo: { findByRoomAndUser } });
    const { checkMediaAccess } = createMessagingImpl(deps);

    const res = await invoke(checkMediaAccess as unknown as Handler, {
      userId: "stranger",
      scope: "GROUP_CHAT",
      resourceId: "g1",
    });

    expect(res).toEqual({ allowed: false });
  });

  it("PRIVATE_CHAT: a non-participant is denied (unchanged behavior)", async () => {
    const findByRoomId = jest.fn().mockResolvedValue({
      roomId: "room1",
      participants: ["u1", "u2"],
    });
    const deps = makeDeps({ privateRoomRepo: { findByRoomId } });
    const { checkMediaAccess } = createMessagingImpl(deps);

    const res = await invoke(checkMediaAccess as unknown as Handler, {
      userId: "u3",
      scope: "PRIVATE_CHAT",
      resourceId: "room1",
    });

    expect(res).toEqual({ allowed: false });
  });
});
