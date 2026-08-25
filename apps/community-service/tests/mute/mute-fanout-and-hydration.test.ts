/**
 * The two halves of "a mute must reach a member who is NOT inside the chatroom".
 *
 * The moderation-mute mechanics (persistence, lazy expiry, the sweeper, the
 * PERSONAL system line) are covered by the sibling suites. What was never pinned
 * is the pair of contracts a member OUTSIDE the room depends on, and each was the
 * root cause of a real bug:
 *
 *   1. FAN-OUT — `community:member:muted` / `:unmuted` must go to the community
 *      room AND to the target's own `user:<id>` channel. The room channel only
 *      holds sockets that called `community:join`, i.e. the ONE community
 *      currently open, so a room-only broadcast is invisible to a member on the
 *      community list, in a different community, or anywhere else in the app.
 *      The same change must also be mirrored to chat-service, which owns the
 *      server-side write gate.
 *
 *   2. HYDRATION — `GET /communities/:id` must report the CALLER's own mute as
 *      `isMemberMuted` / `memberMutedUntil`. This is what makes a hard reload,
 *      a cold start, a re-login, a new device and a mute applied while offline
 *      all render correctly; a client that has to remember its own mute state
 *      cannot get any of those right.
 */
import { publishChatUserEvent, publishCommunityRoomEvent } from "@aimess/redis";

import { communityRepository } from "../../src/repositories/community.repository.js";
import { communityService } from "../../src/services/community.service.js";
import { publishCommunityMemberMuteSyncedForChatSafe } from "../../src/messaging/publish-community-chat.js";

const repo = communityRepository as unknown as Record<string, jest.Mock>;
const userEvent = publishChatUserEvent as jest.Mock;
const roomEvent = publishCommunityRoomEvent as jest.Mock;
const chatMirror = publishCommunityMemberMuteSyncedForChatSafe as jest.Mock;

const CID = "a".repeat(24);
const CALLER = "11111111-1111-4111-8111-111111111111";
const TARGET = "22222222-2222-4222-8222-222222222222";

/** Which channels the given socket event was published on, plus its payload. */
const publishedOn = (event: string) => ({
  rooms: roomEvent.mock.calls.filter((c) => c[2] === event).map((c) => c[1]),
  users: userEvent.mock.calls.filter((c) => c[2] === event).map((c) => c[1]),
  payload:
    userEvent.mock.calls.find((c) => c[2] === event)?.[3] ??
    roomEvent.mock.calls.find((c) => c[2] === event)?.[3],
});

beforeEach(() => {
  jest.clearAllMocks();
  repo.findById.mockResolvedValue({ id: CID, status: "ACTIVE" });
  repo.findMembership.mockResolvedValue({ status: "ACTIVE", role: "ADMIN" });
  repo.findMemberByUserId.mockResolvedValue({
    userId: TARGET,
    status: "ACTIVE",
    role: "MEMBER",
    snapshotUsername: "target",
    snapshotDisplayName: "Target User",
    snapshotAvatarKey: null,
  });
});

describe("mute/unmute fan-out reaches a member who is not in the chatroom", () => {
  // muteMember derives `mutedUntil` from its OWN clock read (now + N minutes) and
  // that value — not the mocked repo row — is what goes on the wire. Freeze time so
  // the expected expiry is exact instead of racing the elapsed millisecond.
  beforeEach(() => jest.useFakeTimers().setSystemTime(new Date("2026-01-01T00:00:00Z")));
  afterEach(() => jest.useRealTimers());

  it("muteMember publishes community:member:muted to BOTH the community room and the target's user channel", async () => {
    const until = new Date(Date.now() + 30 * 60_000);
    repo.upsertMemberMute.mockResolvedValue({
      mutedBy: CALLER,
      reason: null,
      createdAt: new Date(),
      mutedUntil: until,
    });

    await communityService.muteMember(CID, CALLER, TARGET, 30);

    const { rooms, users, payload } = publishedOn("community:member:muted");
    expect(rooms).toEqual([CID]);
    // The user channel is what makes this work off the community screen.
    expect(users).toEqual([TARGET]);
    expect(payload).toMatchObject({
      communityId: CID,
      memberId: TARGET,
      isMuted: true,
      mutedUntil: until.getTime(),
    });
  });

  it("muteMember mirrors the state into chat-service, which owns the write gate", async () => {
    const until = new Date(Date.now() + 30 * 60_000);
    repo.upsertMemberMute.mockResolvedValue({
      mutedBy: CALLER,
      reason: null,
      createdAt: new Date(),
      mutedUntil: until,
    });

    await communityService.muteMember(CID, CALLER, TARGET, 30);

    expect(chatMirror).toHaveBeenCalledWith({
      communityId: CID,
      userId: TARGET,
      isMuted: true,
      mutedUntil: until.toISOString(),
    });
  });

  it("an INDEFINITE mute goes out as mutedUntil:null on both channels", async () => {
    repo.upsertMemberMute.mockResolvedValue({
      mutedBy: CALLER,
      reason: null,
      createdAt: new Date(),
      mutedUntil: null,
    });

    await communityService.muteMember(CID, CALLER, TARGET, null);

    const { rooms, users, payload } = publishedOn("community:member:muted");
    expect(rooms).toEqual([CID]);
    expect(users).toEqual([TARGET]);
    expect(payload).toMatchObject({ isMuted: true, mutedUntil: null });
  });

  it("unmuteMember publishes community:member:unmuted on the same two channels and lifts the chat gate", async () => {
    repo.findMemberMute.mockResolvedValue({
      mutedUntil: new Date(Date.now() + 60_000),
    });
    repo.deleteMemberMute.mockResolvedValue(undefined);

    await communityService.unmuteMember(CID, CALLER, TARGET);

    const { rooms, users, payload } = publishedOn("community:member:unmuted");
    expect(rooms).toEqual([CID]);
    expect(users).toEqual([TARGET]);
    expect(payload).toMatchObject({
      communityId: CID,
      memberId: TARGET,
      isMuted: false,
      mutedUntil: null,
    });
    expect(chatMirror).toHaveBeenCalledWith({
      communityId: CID,
      userId: TARGET,
      isMuted: false,
      mutedUntil: null,
    });
  });
});

describe("GET /communities/:id hydrates the caller's own moderation mute", () => {
  const community = {
    id: CID,
    name: "C",
    handle: "c",
    description: null,
    type: "PUBLIC",
    category: { id: "cat", name: "Cat" },
    creatorId: CALLER,
    adminId: CALLER,
    memberCount: 2,
    avatarUrl: null,
    coverUrl: null,
    moderationStatus: "ACTIVE",
    status: "ACTIVE",
    statusClosedReasonCode: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(() => {
    repo.findById.mockResolvedValue(community);
    repo.findMembership.mockResolvedValue({ status: "ACTIVE", role: "MEMBER" });
    repo.findMuteByUserAndCommunity.mockResolvedValue(null);
    repo.findJoinRequestByCommunityAndUser.mockResolvedValue(null);
  });

  it("reports a timed mute with its expiry", async () => {
    const until = new Date(Date.now() + 60 * 60_000);
    repo.findActiveMemberMute.mockResolvedValue({ mutedUntil: until });

    const data = await communityService.getById(CID, TARGET);

    expect(data.isMemberMuted).toBe(true);
    expect(data.memberMutedUntil).toBe(until.toISOString());
  });

  it("reports an indefinite mute as isMemberMuted:true with a null expiry", async () => {
    repo.findActiveMemberMute.mockResolvedValue({ mutedUntil: null });

    const data = await communityService.getById(CID, TARGET);

    expect(data.isMemberMuted).toBe(true);
    expect(data.memberMutedUntil).toBeNull();
  });

  it("reports no mute when the caller has none — the flag can never go stale-true on reload", async () => {
    repo.findActiveMemberMute.mockResolvedValue(null);

    const data = await communityService.getById(CID, TARGET);

    expect(data.isMemberMuted).toBe(false);
    expect(data.memberMutedUntil).toBeNull();
  });

  it("resolves the mute through findActiveMemberMute, so an EXPIRED row never hydrates as muted", async () => {
    // findActiveMemberMute applies the `mutedUntil IS NULL OR > now` filter, so a
    // lapsed timed mute resolves to null here — proven by active-member-mute.test.ts.
    repo.findActiveMemberMute.mockResolvedValue(null);

    await communityService.getById(CID, TARGET);

    expect(repo.findActiveMemberMute).toHaveBeenCalledWith(CID, TARGET);
  });
});
