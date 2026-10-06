/**
 * Stream-lifecycle consumer — `handleStreamStarted` / `handleStreamEnded`.
 *
 * Each raw stream-service `stream.started` / `stream.ended` event becomes:
 *   1. a host-named chat SYSTEM message (LIVE_STREAM_STARTED / LIVE_STREAM_ENDED,
 *      triggeredByUserId = host, idempotent via the eventAt-derived dedup key), and
 *   2. a recipient-resolved push fan-out event (active members − host − stream-muted),
 *      deduped against RabbitMQ redelivery via a Redis SET-NX claim.
 *
 * The I/O boundary (repo, redis, chat publishers, push publishers, avatar
 * services) is mocked by tests/setup/global-mocks.ts; the real handler runs.
 */

import {
  handleStreamStarted,
  handleStreamEnded,
  streamEndedReason,
} from "../../src/consumers/stream-lifecycle.consumer.js";
import { communityRepository } from "../../src/repositories/community.repository.js";
import { redis } from "../../src/config/redis.js";
import { publishCommunitySystemMessageForChatSafe } from "../../src/messaging/publish-community-chat.js";
import {
  publishCommunityLivestreamStartedSafe,
  publishCommunityLivestreamEndedSafe,
} from "../../src/messaging/publish-community.js";

const repo = communityRepository as unknown as Record<string, jest.Mock>;
const redisMock = redis as unknown as Record<string, jest.Mock>;
const sysMsg = publishCommunitySystemMessageForChatSafe as jest.Mock;
const pushStarted = publishCommunityLivestreamStartedSafe as jest.Mock;
const pushEnded = publishCommunityLivestreamEndedSafe as jest.Mock;

const CID = "a".repeat(24);
const SID = "b".repeat(24);
const HOST = "11111111-1111-4111-8111-111111111111";
const U1 = "22222222-2222-4222-8222-222222222222";
const U2 = "33333333-3333-4333-8333-333333333333";

beforeEach(() => {
  jest.clearAllMocks();
  // SET-NX claim succeeds by default (first delivery).
  redisMock.set.mockResolvedValue("OK");
  repo.findById.mockResolvedValue({
    id: CID,
    name: "Test Community",
    handle: "test",
    avatarUrl: null,
  });
  repo.findActiveMemberIds.mockResolvedValue([HOST, U1, U2]);
  repo.findStreamMutedMemberIds.mockResolvedValue([]);
  repo.findMemberByUserId.mockResolvedValue({
    userId: HOST,
    snapshotDisplayName: "Host Name",
    snapshotAvatarKey: "host/key",
  });
});

describe("handleStreamStarted", () => {
  it("posts a host-named LIVE_STREAM_STARTED system message", async () => {
    await handleStreamStarted({
      communityId: CID,
      streamId: SID,
      creatorId: HOST,
      livedAt: 1_750_000_000_000,
    });

    expect(sysMsg).toHaveBeenCalledTimes(1);
    const arg = sysMsg.mock.calls[0][0];
    expect(arg.systemMessageType).toBe("LIVE_STREAM_STARTED");
    expect(arg.triggeredByUserId).toBe(HOST);
    expect(arg.communityId).toBe(CID);
    expect(arg.metadata).toMatchObject({ livestreamId: SID });
    // Stable eventAt (derived from livedAt) anchors the idempotency key.
    expect(arg.eventAt).toBe(new Date(1_750_000_000_000).toISOString());
  });

  it("fans out the push to active members minus the host", async () => {
    await handleStreamStarted({
      communityId: CID,
      streamId: SID,
      creatorId: HOST,
      livedAt: 1_750_000_000_000,
    });

    expect(pushStarted).toHaveBeenCalledTimes(1);
    const arg = pushStarted.mock.calls[0][0];
    expect(arg.recipientIds.sort()).toEqual([U1, U2].sort());
    expect(arg.recipientIds).not.toContain(HOST);
    expect(arg.hostUserId).toBe(HOST);
    expect(arg.hostDisplayName).toBe("Host Name");
    expect(arg.communityName).toBe("Test Community");
    expect(arg.livestreamId).toBe(SID);
  });

  it("excludes members who disabled livestream notifications", async () => {
    repo.findStreamMutedMemberIds.mockResolvedValue([U2]);

    await handleStreamStarted({
      communityId: CID,
      streamId: SID,
      creatorId: HOST,
      livedAt: 1,
    });

    expect(pushStarted.mock.calls[0][0].recipientIds).toEqual([U1]);
  });

  it("skips the push on redelivery but still posts the system message", async () => {
    redisMock.set.mockResolvedValue(null); // claim already held

    await handleStreamStarted({
      communityId: CID,
      streamId: SID,
      creatorId: HOST,
      livedAt: 1,
    });

    expect(sysMsg).toHaveBeenCalledTimes(1); // idempotent — always posted
    expect(pushStarted).not.toHaveBeenCalled(); // deduped
  });

  it("does not publish a push when there are no eligible recipients", async () => {
    repo.findActiveMemberIds.mockResolvedValue([HOST]); // only the host

    await handleStreamStarted({
      communityId: CID,
      streamId: SID,
      creatorId: HOST,
      livedAt: 1,
    });

    expect(sysMsg).toHaveBeenCalledTimes(1);
    expect(pushStarted).not.toHaveBeenCalled();
  });

  it("is a no-op when required fields are missing", async () => {
    await handleStreamStarted({
      communityId: CID,
      streamId: "",
      creatorId: HOST,
    });
    expect(sysMsg).not.toHaveBeenCalled();
    expect(pushStarted).not.toHaveBeenCalled();
  });
});

describe("handleStreamEnded", () => {
  it("posts LIVE_STREAM_ENDED with a formatted duration and fans out", async () => {
    await handleStreamEnded({
      communityId: CID,
      streamId: SID,
      creatorId: HOST,
      endedAt: 1_750_000_500_000,
      durationSeconds: 5040, // 1h 24m
    });

    expect(sysMsg).toHaveBeenCalledTimes(1);
    const sysArg = sysMsg.mock.calls[0][0];
    expect(sysArg.systemMessageType).toBe("LIVE_STREAM_ENDED");
    expect(sysArg.triggeredByUserId).toBe(HOST);
    expect(sysArg.metadata).toMatchObject({
      livestreamId: SID,
      duration: "1h 24m",
      durationSeconds: 5040,
    });

    expect(pushEnded).toHaveBeenCalledTimes(1);
    const pushArg = pushEnded.mock.calls[0][0];
    expect(pushArg.duration).toBe("1h 24m");
    expect(pushArg.durationSeconds).toBe(5040);
    expect(pushArg.recipientIds.sort()).toEqual([U1, U2].sort());
  });

  it("renders a zero/short duration safely", async () => {
    await handleStreamEnded({
      communityId: CID,
      streamId: SID,
      creatorId: HOST,
      endedAt: 1,
      durationSeconds: 0,
    });
    expect(sysMsg.mock.calls[0][0].metadata.duration).toBe("0s");
  });

  it("host End Live (HOST_ENDED) is endedReason USER", async () => {
    await handleStreamEnded({
      communityId: CID,
      streamId: SID,
      creatorId: HOST,
      endedAt: 1,
      durationSeconds: 2160,
      reason: "HOST_ENDED",
    });
    expect(sysMsg.mock.calls[0][0].metadata.endedReason).toBe("USER");
    // Host's own end keeps "{host} ended the livestream": no target.
    expect(sysMsg.mock.calls[0][0].metadata.targetUserId).toBeUndefined();
    expect(pushEnded.mock.calls[0][0].endedReason).toBe("USER");
  });

  it("Super Admin Backoffice end is endedReason ADMIN; host stays the host and IS pushed", async () => {
    await handleStreamEnded({
      communityId: CID,
      streamId: SID,
      creatorId: HOST,
      endedAt: 1,
      durationSeconds: 2160,
      reason: "MANUAL_ADMIN", // backoffice reasonCode
      byPlatformAdmin: true,
    });
    const sysArg = sysMsg.mock.calls[0][0];
    expect(sysArg.metadata).toMatchObject({ endedReason: "ADMIN", duration: "36m" });
    expect(sysArg.metadata.targetUserId).toBeUndefined();
    expect(sysArg.triggeredByUserId).toBe(HOST);
    // The raw reason code never reaches clients.
    expect(JSON.stringify(sysArg.metadata)).not.toContain("MANUAL_ADMIN");

    const pushArg = pushEnded.mock.calls[0][0];
    expect(pushArg.endedReason).toBe("ADMIN");
    expect(pushArg.hostUserId).toBe(HOST);
    expect(pushArg.endedByUserId).toBeUndefined();
    expect(pushArg.recipientIds.sort()).toEqual([HOST, U1, U2].sort());
  });

  it("platform end (moderation code, no byPlatformAdmin) stays SYSTEM; host not pushed", async () => {
    await handleStreamEnded({
      communityId: CID,
      streamId: SID,
      creatorId: HOST,
      endedAt: 1,
      durationSeconds: 2160,
      reason: "MEMBER_BANNED",
    });
    expect(sysMsg.mock.calls[0][0].metadata.endedReason).toBe("SYSTEM");
    expect(pushEnded.mock.calls[0][0].recipientIds).not.toContain(HOST);
  });

  it("host End Live keeps the host out of the push; admin End for Everyone pushes the host, not the admin", async () => {
    await handleStreamEnded({
      communityId: CID,
      streamId: SID,
      creatorId: HOST,
      endedAt: 1,
      durationSeconds: 240,
      reason: "HOST_ENDED",
    });
    expect(pushEnded.mock.calls[0][0].recipientIds.sort()).toEqual([U1, U2].sort());

    jest.clearAllMocks();
    redisMock.set.mockResolvedValue("OK");
    await handleStreamEnded({
      communityId: CID,
      streamId: SID,
      creatorId: HOST,
      endedAt: 2,
      durationSeconds: 240,
      reason: "COMMUNITY_ADMIN_ENDED",
      endedBy: U1,
    });
    expect(pushEnded.mock.calls[0][0].recipientIds.sort()).toEqual([HOST, U2].sort());
  });

  it("stream-muted members stay out of every variant's push", async () => {
    repo.findStreamMutedMemberIds.mockResolvedValue([U2]);
    await handleStreamEnded({
      communityId: CID,
      streamId: SID,
      creatorId: HOST,
      endedAt: 1,
      durationSeconds: 240,
      reason: "MANUAL_ADMIN",
      byPlatformAdmin: true,
    });
    expect(pushEnded.mock.calls[0][0].recipientIds.sort()).toEqual([HOST, U1].sort());
  });

  it.each([
    [undefined, "USER"], // PENDING-timeout sweeper / older producer
    ["HOST_ENDED", "USER"],
    ["ADMIN_FORCE_ENDED", "SYSTEM"],
    ["POLICY_VIOLATION", "SYSTEM"],
    ["ACCOUNT_BANNED", "SYSTEM"],
    ["MEMBER_BANNED", "SYSTEM"],
    ["COMMUNITY_CLOSED", "SYSTEM"],
    ["COMMUNITY_ADMIN_ENDED", "USER"],
  ])("reason %s ⇒ %s", (reason, expected) => {
    expect(streamEndedReason(reason)).toBe(expected);
  });

  it("byPlatformAdmin wins over any reason code ⇒ ADMIN", () => {
    expect(streamEndedReason("POLICY_VIOLATION", true)).toBe("ADMIN");
    expect(streamEndedReason(undefined, true)).toBe("ADMIN");
  });

  it("community admin End for Everyone names the ADMIN, not System or the host", async () => {
    repo.findMemberByUserId.mockImplementation(async (_c: string, id: string) =>
      id === U1
        ? { userId: U1, snapshotDisplayName: "Admin Person", snapshotAvatarKey: null }
        : { userId: HOST, snapshotDisplayName: "Host Name", snapshotAvatarKey: "host/key" }
    );
    await handleStreamEnded({
      communityId: CID,
      streamId: SID,
      creatorId: HOST,
      endedAt: 1,
      durationSeconds: 60,
      reason: "COMMUNITY_ADMIN_ENDED",
      endedBy: U1,
    });

    const sysArg = sysMsg.mock.calls[0][0];
    expect(sysArg.triggeredByUserId).toBe(U1);
    // The host rides as the target so chat-service names them:
    // "{admin} ended {host}'s livestream".
    expect(sysArg.metadata).toMatchObject({
      endedReason: "USER",
      hostUserId: HOST,
      targetUserId: HOST,
    });

    const pushArg = pushEnded.mock.calls[0][0];
    expect(pushArg).toMatchObject({
      endedReason: "USER",
      hostUserId: HOST,
      endedByUserId: U1,
      endedByDisplayName: "Admin Person",
    });
  });

  it("COMMUNITY_ADMIN_ENDED without endedBy (older producer) falls back to the host", async () => {
    await handleStreamEnded({
      communityId: CID,
      streamId: SID,
      creatorId: HOST,
      endedAt: 1,
      durationSeconds: 60,
      reason: "COMMUNITY_ADMIN_ENDED",
    });

    expect(sysMsg.mock.calls[0][0].triggeredByUserId).toBe(HOST);
    expect(pushEnded.mock.calls[0][0].endedByUserId).toBeUndefined();
  });
});
