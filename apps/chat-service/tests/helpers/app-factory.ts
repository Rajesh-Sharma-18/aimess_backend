/**
 * App-factory test helper — builds the REAL chat-service Express app via
 * `createApp(controllers)`, wiring REAL controllers → REAL services → MOCK
 * repositories (and a mock Redis), mirroring src/server.ts's DI graph.
 *
 * Unlike the auth-service template, chat-service does not export a default
 * `app`; server.ts assembles the controllers at startup. We reproduce just the
 * wiring here so each integration test exercises routing, middleware, Zod
 * validation, controllers AND service logic for real — only the I/O boundary
 * (Prisma repos, Redis, gRPC, user snapshots) is mocked.
 *
 * Per-test usage:
 *   const { app, mocks } = buildApp();
 *   mocks.privateRoomRepo.findByRoomId.mockResolvedValue(null);   // drive a branch
 *   await request(app).get(...).set(bearer(makeAccessToken()));
 *
 * Every repo method is an auto-vivified jest.fn() (see `repoMock()`), so a test
 * only stubs the methods the path under test touches; everything else is a
 * jest.fn returning undefined.
 */
import type { Express } from "express";

import { clearSendGateCaches } from "../../src/lib/send-gate-cache.js";

import { createApp } from "../../src/app.js";
import { TEST_USER_ID, TEST_PEER_ID } from "./auth.js";
import type { Controllers } from "../../src/api/routes/index.js";

// -- Real services --
import { PrivateRoomService } from "../../src/services/private-room.service.js";
import { InboxService } from "../../src/services/inbox.service.js";
import { ConversationBulkService } from "../../src/services/conversation-bulk.service.js";
import { SyncService } from "../../src/services/sync.service.js";
import { PrivateMessageService } from "../../src/services/private-message.service.js";
import { PrivatePinService } from "../../src/services/private-pin.service.js";
import { PrivateSystemMessageService } from "../../src/services/private-system-message.service.js";
import { GroupRoomService } from "../../src/services/group-room.service.js";
import { GroupSystemMessageService } from "../../src/services/group-system-message.service.js";
import { GroupMessageService } from "../../src/services/group-message.service.js";
import { GroupMemberService } from "../../src/services/group-member.service.js";
import { GroupInviteLinkService } from "../../src/services/group-invite-link.service.js";
import { GroupPinService } from "../../src/services/group-pin.service.js";
import { GroupAutoDeleteService } from "../../src/services/group-auto-delete.service.js";
import { NotificationService } from "../../src/services/notification.service.js";
import { UnreadSummaryService } from "../../src/services/unread-summary.service.js";
import { CommunityRoomService } from "../../src/services/community-room.service.js";
import { CommunityMessageService } from "../../src/services/community-message.service.js";
import { CommunityPinService } from "../../src/services/community-pin.service.js";
import { CommunitySystemMessageService } from "../../src/services/community-system-message.service.js";
import { ChatMessageOrchestrator } from "../../src/services/chat-message-orchestrator.js";
import { UserSnapshotService } from "../../src/services/user-snapshot.service.js";
import { CallService } from "../../src/services/call.service.js";
import { PresenceService } from "../../src/services/presence.service.js";
import { AutoDeleteService } from "../../src/services/auto-delete.service.js";

// -- Real controllers --
import { PrivateRoomController } from "../../src/api/controllers/private-room.controller.js";
import { InboxController } from "../../src/api/controllers/inbox.controller.js";
import { ConversationBulkController } from "../../src/api/controllers/conversation-bulk.controller.js";
import { SyncController } from "../../src/api/controllers/sync.controller.js";
import { PrivateMessageController } from "../../src/api/controllers/private-message.controller.js";
import { GroupRoomController } from "../../src/api/controllers/group-room.controller.js";
import { GroupMessageController } from "../../src/api/controllers/group-message.controller.js";
import { GroupMemberController } from "../../src/api/controllers/group-member.controller.js";
import { GroupInviteLinkController } from "../../src/api/controllers/group-invite-link.controller.js";
import { NotificationController } from "../../src/api/controllers/notification.controller.js";
import { NotificationCatalogueService } from "../../src/services/notification-catalogue.service.js";
import { UnreadSummaryController } from "../../src/api/controllers/unread-summary.controller.js";
import { CommunityController } from "../../src/api/controllers/community.controller.js";
import { CommunityMessageController } from "../../src/api/controllers/community-message.controller.js";
import { CallController } from "../../src/api/controllers/call.controller.js";
import { PresenceController } from "../../src/api/controllers/presence.controller.js";
import { MessageContextController } from "../../src/api/controllers/message-context.controller.js";
import { MessageSearchController } from "../../src/api/controllers/message-search.controller.js";
import { MessageSearchService } from "../../src/services/message-search.service.js";

/**
 * A Proxy whose every property is a fresh jest.fn() (memoized per key). Lets a
 * test stub only the repo methods a path touches; all others resolve undefined.
 *
 * Default impl is `async () => undefined` (resolves a Promise) because services
 * call several fire-and-forget repo methods as `repo.x(...).catch(...)`; an
 * undefined-returning stub would throw "Cannot read properties of undefined
 * (reading 'catch')". A test that needs a concrete value overrides the method.
 */
function repoMock(): any {
  const cache: Record<string, jest.Mock> = {};
  return new Proxy(
    {},
    {
      get: (_t, prop: string) => {
        if (prop === "then") return undefined; // not a thenable
        if (!(prop in cache)) cache[prop] = jest.fn(async () => undefined);
        return cache[prop];
      },
      set: (_t, prop: string, value) => {
        cache[prop] = value as jest.Mock;
        return true;
      },
    }
  );
}

/** A mock ioredis client — pub/sub + the bits controllers/services touch. */
function redisMock(): any {
  return {
    status: "ready",
    publish: jest.fn(async () => 0),
    get: jest.fn(async () => null),
    set: jest.fn(async () => "OK"),
    del: jest.fn(async () => 0),
    incr: jest.fn(async () => 1),
    expire: jest.fn(async () => 1),
    multi: jest.fn(() => ({
      zremrangebyscore: jest.fn().mockReturnThis(),
      zadd: jest.fn().mockReturnThis(),
      zcard: jest.fn().mockReturnThis(),
      pexpire: jest.fn().mockReturnThis(),
      exec: jest.fn(async () => null),
    })),
    zrange: jest.fn(async () => []),
    // Presence/unread fan-outs batch their reads through a pipeline; without it
    // the call threw "p.redis.pipeline is not a function".
    pipeline: jest.fn(() => {
      const chain: Record<string, unknown> = {};
      for (const op of [
        "get",
        "set",
        "setex",
        "del",
        "incr",
        "expire",
        "hget",
        "hset",
      ]) {
        chain[op] = jest.fn().mockReturnValue(chain);
      }
      chain.exec = jest.fn(async () => []);
      return chain;
    }),
    on: jest.fn(),
  };
}

export interface BuiltMocks {
  // repositories
  privateRoomRepo: any;
  privateMessageRepo: any;
  privateMessagePinRepo: any;
  privateMessageReportRepo: any;
  groupRoomRepo: any;
  groupMessageRepo: any;
  groupMemberRepo: any;
  groupInviteLinkRepo: any;
  groupMessagePinRepo: any;
  communityMessagePinRepo: any;
  generalRoomRepo: any;
  generalRoomMessageRepo: any;
  roomMemberRepo: any;
  notificationRepo: any;
  notificationCategoryRepo: any;
  callRepo: any;
  messageSearchRepo: any;
  cacheRepo: any;
  // peers / infra
  userServiceClient: any;
  friendshipGrpcClient: any;
  communityClient: any;
  streamCountsClient: any;
  redis: any;
  userSnapshotService: UserSnapshotService;
  // services (handy for spies in a few specs)
  presenceService: PresenceService;
  privateMessageService: PrivateMessageService;
  chatMessageOrchestrator: ChatMessageOrchestrator;
  autoDeleteService: AutoDeleteService;
  groupAutoDeleteService: GroupAutoDeleteService;
  groupMessageService: GroupMessageService;
}

export interface BuiltApp {
  app: Express;
  mocks: BuiltMocks;
}

/**
 * Build a fully-wired chat-service app with mock repositories. Returns the app
 * plus the mock objects so a test can program repo return values per scenario.
 */
export function buildApp(): BuiltApp {
  // The send path memoizes the DM roster and the "may these two still talk"
  // verdict in module scope (see lib/send-gate-cache.ts). In production that is
  // bounded by a 5s TTL and cleared by the friendship consumer; in a test file
  // it would otherwise leak across specs, so a spec that programs
  // `checkFriendship -> false` would still be answered by the PASS an earlier
  // spec cached. Every app the harness builds starts from a clean slate.
  clearSendGateCaches();

  const redis = redisMock();

  // -- Mock repositories --
  const cacheRepo = repoMock();
  // PresenceService reads status + lastSeen + version in ONE batched call.
  // Default it from the same per-user mocks specs already program
  // (`getUserPresence` / `getUserPresences` / `getLastSeen`), so a spec keeps
  // stubbing whichever of those it finds natural and never has to know a
  // snapshot shape exists.
  cacheRepo.getPresenceSnapshots = jest.fn(async (userIds: string[]) => {
    const statuses = (await cacheRepo.getUserPresences(userIds)) as
      | Map<string, string | null>
      | undefined;
    const snapshots = new Map();
    for (const userId of userIds) {
      const status =
        statuses?.get(userId) ?? (await cacheRepo.getUserPresence(userId));
      snapshots.set(userId, {
        userId,
        isOnline: status === "online",
        lastSeen: (await cacheRepo.getLastSeen(userId)) ?? null,
        version: 0,
      });
    }
    return snapshots;
  });
  const privateRoomRepo = repoMock();
  const privateMessageRepo = repoMock();
  const privateMessagePinRepo = repoMock();
  const privateMessageReportRepo = repoMock();
  const groupRoomRepo = repoMock();
  const groupMessageRepo = repoMock();
  const groupMemberRepo = repoMock();
  const groupInviteLinkRepo = repoMock();
  // Capacity is claimed with an atomic conditional update in production
  // (`reserveMemberSlot`). The mock reproduces its DECISION off the same room
  // the spec already programs, so a capacity spec keeps working by setting
  // `memberCount`/`memberLimit` — no spec has to know the primitive exists.
  // A concurrency spec overrides this to script the race.
  groupRoomRepo.reserveMemberSlot = jest.fn(
    async (roomId: string, limit: number) => {
      const room = await groupRoomRepo.findActiveByRoomId(roomId);
      if (!room) return false;
      return (room.memberCount ?? 0) < limit;
    }
  );
  // `findByToken` (ANY status) is what the invite state machine reads. Specs
  // predating it stub only the ACTIVE-filtered lookup, so fall back to that —
  // a spec exercising a revoked/expired token overrides `findByToken` directly.
  groupInviteLinkRepo.findByToken = jest.fn((token: string) =>
    groupInviteLinkRepo.findActiveByToken(token)
  );
  // Groups have an owner unless a spec says otherwise.
  groupMemberRepo.countActiveByRole = jest.fn(async () => 1);
  const groupMessagePinRepo = repoMock();
  const communityMessagePinRepo = repoMock();
  // CommunityPinService.pin() runs its switch-pin logic inside
  // `pinRepo.runTransaction(async (tx) => ...)`. There's no real Mongo
  // transaction in unit tests, so just invoke the callback directly — the
  // repo methods called inside it (createPin/softDeletePin/incPinnedCount)
  // are the same mocked jest.fn()s a test already stubs, just called with an
  // extra (ignored) `tx` arg.
  communityMessagePinRepo.runTransaction = jest.fn(
    (fn: (tx: unknown) => unknown) => fn({})
  );
  // Group and private pins run the same switch-pin transaction — same reason,
  // same passthrough.
  groupMessagePinRepo.runTransaction = jest.fn((fn: (tx: unknown) => unknown) =>
    fn({})
  );
  privateMessagePinRepo.runTransaction = jest.fn(
    (fn: (tx: unknown) => unknown) => fn({})
  );
  const generalRoomRepo = repoMock();
  // Default: community general rooms are open/active. The community write gate
  // (`assertCommunityRoomWritable`) loads the room on send/edit/delete/react/pin;
  // a spec that exercises a closed/suspended community overrides this.
  generalRoomRepo.findRoomById.mockResolvedValue({
    id: "room",
    status: "active",
  });
  // Community send takes its slot through `allocateRoomSlot` (lib/room-lock.ts)
  // so concurrent sends into one room share a single `$inc`, which means it
  // calls the BLOCK method. Delegating to `allocateSequenceAndRevision` keeps
  // every spec that stubs that (and asserts on the numbers it returns) working
  // untouched.
  generalRoomRepo.allocateSequenceAndRevisionBlock.mockImplementation(
    async (roomId: string, count: number) => {
      let slot = { sequenceNumber: 0, revision: 0 };
      for (let i = 0; i < Math.max(1, count); i += 1) {
        slot = await generalRoomRepo.allocateSequenceAndRevision(roomId);
      }
      return {
        lastSequence: slot.sequenceNumber,
        lastRevision: slot.revision,
        room: null,
      };
    }
  );
  // Default: the caller is a participant of whatever private room the spec
  // addresses. `assertPrivateParticipant` now runs on the WRITE paths too
  // (send/forward/mark-read/reactions — AUDIT-103/104/105/113), not just the
  // reads, so without this every private spec would 404 on CHAT_ROOM_NOT_FOUND.
  // `participants` is also what the peer/`receiverId` is derived from, so a spec
  // asserting on a specific peer overrides this with its own room.
  privateRoomRepo.findByRoomId.mockResolvedValue({
    roomId: "prv_room",
    participants: [TEST_USER_ID, TEST_PEER_ID],
  });
  // Default: the group is live. The group write gate (`assertGroupWritable`)
  // loads the room on send/edit/delete/react/pin/forward, so without this every
  // group write spec would 404 on CHAT_GROUP_NOT_FOUND. A spec exercising a
  // DISBANDED / CLOSED group overrides this with its own status.
  // The invite state machine also reads the room at ANY status (only that can
  // tell "disbanded" from "never existed"), and most specs program the room they
  // care about on the visible-status lookup — so prefer that answer when there
  // is one, and fall back to the generic live row otherwise.
  groupRoomRepo.findByRoomId.mockImplementation(async (roomId: string) => {
    const visible = await groupRoomRepo.findActiveByRoomId(roomId);
    return visible ?? { roomId: "grp_room", status: "ACTIVE" };
  });
  // Every timeline page probes one row beyond each seq edge for the bidirectional
  // continuation block and reads the room's change high-water. Default both so a
  // spec only stubs them when it actually asserts on continuation/revision.
  for (const repo of [privateMessageRepo, groupMessageRepo]) {
    repo.findByRoomIdSeq.mockResolvedValue([]);
  }
  for (const repo of [privateRoomRepo, groupRoomRepo]) {
    repo.getRoomRevision.mockResolvedValue(0);
  }
  // The private send path allocates a BLOCK of sequence numbers through
  // `allocateRoomSlot` (lib/room-lock.ts), which immediately reads
  // `block.lastSequence`. The auto-vivified Proxy method resolved `undefined`,
  // so every private send died inside `drain()` before reaching the controller.
  let privateSeq = 0;
  privateRoomRepo.allocateSequenceBlock.mockImplementation(
    async (roomId: string, count: number) => {
      privateSeq += count;
      return {
        lastSequence: privateSeq,
        lastRevision: privateSeq,
        room: { roomId, participants: [TEST_USER_ID, TEST_PEER_ID] },
      };
    }
  );

  // `forwardMessage` allocates the TARGET room's slot through the same
  // one-write helper the group path uses; only groupRoomRepo had a default, so
  // every private forward read `sequenceNumber` off undefined.
  privateRoomRepo.allocateSequenceWithRoom.mockImplementation(
    async (roomId: string) => ({
      sequenceNumber: 1,
      room: { roomId, participants: [TEST_USER_ID, TEST_PEER_ID] },
    })
  );

  // The group send/forward path takes the first sequence number and the room's
  // auto-delete timer off ONE write. Delegating to `allocateSequence` keeps every
  // spec that already stubs that (and asserts on the seq it returns) working
  // untouched; the room carries no `autoDelete`, i.e. the timer is Off, which is
  // what every pre-existing group spec assumes.
  groupRoomRepo.allocateSequenceWithRoom.mockImplementation(
    async (roomId: string) => ({
      sequenceNumber: await groupRoomRepo.allocateSequence(roomId),
      room: { roomId },
    })
  );
  // Group send now takes that slot through `allocateRoomSlot` (lib/room-lock.ts)
  // so concurrent sends into one room share a single `$inc`, which means the
  // send path calls the BLOCK method rather than `allocateSequenceWithRoom`.
  // Delegating to `allocateSequenceWithRoom` keeps every spec that stubs either
  // of those working untouched.
  groupRoomRepo.allocateSequenceBlock.mockImplementation(
    async (roomId: string, count: number) => {
      let last = 0;
      let room: unknown = { roomId };
      for (let i = 0; i < Math.max(1, count); i += 1) {
        const slot = await groupRoomRepo.allocateSequenceWithRoom(roomId);
        last = slot.sequenceNumber;
        room = slot.room;
      }
      // Group insert does not allocate revisions — see
      // GroupRoomRepository.allocateSequenceBlock.
      return { lastSequence: last, room };
    }
  );
  const generalRoomMessageRepo = repoMock();
  const roomMemberRepo = repoMock();
  const notificationRepo = repoMock();
  const notificationCategoryRepo = repoMock();
  // The six seeded catalogue rows. Specs that care override `listAll`; every
  // other spec just needs the categories endpoint not to blow up.
  notificationCategoryRepo.listAll.mockResolvedValue([]);
  // The list endpoint reads per-tab counts alongside the rows; without a default
  // every notifications spec would 500 on an undefined counts object.
  notificationRepo.countByCategories.mockResolvedValue({
    all: 0,
    friends: 0,
    communities: 0,
    mentions: 0,
    system: 0,
  });
  const callRepo = repoMock();
  const messageSearchRepo = repoMock();

  // -- Peers / collaborators --
  // UserSnapshotService is real (it calls the mocked user-service-client lib +
  // cacheRepo). Provide a userServiceClient stub used by the room services.
  const userSnapshotService = new UserSnapshotService();
  const userServiceClient: any = {
    checkFriendship: jest.fn(async () => true),
    // The send path gates on friendship AND on the block list; without this the
    // happy path threw "isFriendshipBlocked is not a function" → 500.
    isFriendshipBlocked: jest.fn(async () => false),
    // The gate reads the EITHER-WAY block (a one-way block closes the DM for
    // both parties), so this is the one the write path actually calls.
    isBlockedEitherWay: jest.fn(async () => false),
  };
  // Live gRPC friendship lookup for private-room list/details responses (the
  // `friendship` field) — distinct from userServiceClient's local send-gate
  // check above. Defaults to an empty map so every existing test (none of
  // which assert on `friendship`) keeps getting NONE_RELATIONSHIP unchanged;
  // a spec exercising a specific friendship state overrides the resolved map.
  const friendshipGrpcClient: any = {
    checkFriendships: jest.fn(async () => new Map()),
  };
  const communityClient: any = {
    getCommunityInviteContexts: jest.fn(async () => []),
  };

  // -- Real services wired to mocks --
  // Constructed early (before privateRoomService/orchestrator) to mirror
  // server.ts's DI order — presenceService is the single real-time source
  // both REST (isOnline/isOffline) and conv:updated read.
  // whoCanSeeOnlineStatus gate — defaults to "everyone may see" so specs that
  // aren't about privacy read presence as before; a privacy spec overrides
  // `presenceVisibilityGate.filterVisiblePresence` to deny.
  const presenceVisibilityGate: any = {
    filterVisiblePresence: jest.fn(
      async (_viewerId: string, peerIds: string[]) => new Set(peerIds)
    ),
    filterPresenceViewers: jest.fn(
      async (_subjectId: string, viewerIds: string[]) => new Set(viewerIds)
    ),
  };
  const presenceService = new PresenceService(
    cacheRepo,
    redis,
    undefined,
    presenceVisibilityGate
  );

  const privateSystemMessageService = new PrivateSystemMessageService(
    privateMessageRepo,
    privateRoomRepo,
    userSnapshotService,
    cacheRepo,
    redis
  );
  const privatePinService = new PrivatePinService(
    privateMessagePinRepo,
    privateMessageRepo,
    privateRoomRepo,
    cacheRepo,
    userSnapshotService,
    privateSystemMessageService
  );

  const privateRoomService = new PrivateRoomService(
    privateRoomRepo,
    privateMessageRepo,
    cacheRepo,
    userSnapshotService,
    userServiceClient,
    redis,
    presenceService,
    friendshipGrpcClient,
    privatePinService
  );
  const privateMessageService = new PrivateMessageService(
    privateMessageRepo,
    privateRoomRepo,
    cacheRepo,
    userSnapshotService,
    userServiceClient,
    privateMessageReportRepo,
    communityClient,
    // Matches server.ts wiring — without the group repos, GROUP_INVITE cards
    // are never re-resolved on a history read and the harness silently tests a
    // degraded path production never takes.
    undefined,
    undefined,
    groupRoomRepo,
    groupMemberRepo,
    groupInviteLinkRepo
  );

  const groupSystemMessageService = new GroupSystemMessageService(
    groupMessageRepo,
    groupRoomRepo,
    groupMemberRepo,
    cacheRepo,
    userSnapshotService,
    redis
  );
  const groupRoomService = new GroupRoomService(
    groupRoomRepo,
    groupMemberRepo,
    groupInviteLinkRepo,
    groupSystemMessageService,
    redis,
    groupMessageRepo
  );
  const groupMemberService = new GroupMemberService(
    groupMemberRepo,
    groupRoomRepo,
    groupSystemMessageService,
    redis,
    undefined,
    undefined,
    undefined,
    groupRoomService
  );
  const groupMessageService = new GroupMessageService(
    groupMessageRepo,
    groupRoomRepo,
    groupMemberRepo,
    cacheRepo,
    userSnapshotService
  );
  const groupInviteLinkService = new GroupInviteLinkService(
    groupInviteLinkRepo,
    groupRoomRepo,
    groupMemberRepo,
    privateRoomRepo,
    privateMessageRepo,
    userSnapshotService,
    cacheRepo,
    redis
  );
  const groupPinService = new GroupPinService(
    groupMessagePinRepo,
    groupMessageRepo,
    groupRoomRepo,
    groupMemberRepo,
    cacheRepo,
    userSnapshotService,
    groupSystemMessageService
  );

  const notificationService = new NotificationService(notificationRepo);
  const notificationCatalogueService = new NotificationCatalogueService(
    notificationCategoryRepo
  );
  // Stubs for CallService's LiveKit + gate deps. The REST call-history tests
  // (calls.test.ts) never invoke initiateCall so these are effectively unused,
  // but they satisfy the constructor and keep future initiate-flow tests honest.
  const stubLiveKit: any = {
    mintToken: jest
      .fn()
      .mockResolvedValue({ url: "ws://livekit", token: "tk" }),
  };
  const stubFriendshipRepo: any = {
    areFriends: jest.fn().mockResolvedValue(true),
  };
  const stubGetCallPrivacy = jest
    .fn()
    .mockResolvedValue({ whoCanCallMe: "FRIENDS", allowedUserIds: [] });
  const stubGetUserSnapshot = jest
    .fn()
    .mockResolvedValue({ displayName: "", avatarUrl: "" });
  const callService = new CallService(
    callRepo,
    privateRoomRepo,
    redis,
    stubLiveKit,
    stubFriendshipRepo,
    stubGetCallPrivacy,
    stubGetUserSnapshot
  );

  // Stub stream-counts gRPC client: default to "no live streams". A livestream
  // test overrides streamCountsClient.getActiveStreamCounts per scenario.
  const streamCountsClient: any = {
    getActiveStreamCounts: jest.fn(async () => new Map()),
  };
  const communityRoomService = new CommunityRoomService(
    generalRoomRepo,
    roomMemberRepo,
    cacheRepo,
    streamCountsClient
  );
  const communityMessageService = new CommunityMessageService(
    generalRoomMessageRepo,
    generalRoomRepo,
    roomMemberRepo,
    cacheRepo,
    userSnapshotService
  );
  // Real system-message service: the pin lifecycle RETRACTS its
  // "<actor> pinned a message" line, so a `undefined` here silently skipped
  // that half of pin/unpin/delete in every test.
  const communitySystemMessageService = new CommunitySystemMessageService(
    generalRoomMessageRepo,
    generalRoomRepo,
    cacheRepo,
    userSnapshotService,
    redis,
    roomMemberRepo
  );
  const communityPinService = new CommunityPinService(
    communityMessagePinRepo,
    generalRoomMessageRepo,
    generalRoomRepo,
    roomMemberRepo,
    communitySystemMessageService,
    userSnapshotService,
    cacheRepo
  );

  const inboxService = new InboxService(privateRoomService, groupRoomService);
  const unreadSummaryService = new UnreadSummaryService(
    privateRoomService,
    groupRoomService,
    communityMessageService
  );
  const syncService = new SyncService(
    privateMessageService,
    groupMessageService
  );
  const chatMessageOrchestrator = new ChatMessageOrchestrator(
    privateMessageService,
    groupMessageService,
    groupMemberService,
    communityMessageService,
    userSnapshotService,
    cacheRepo,
    redis,
    privatePinService,
    groupPinService,
    presenceService
  );
  const conversationBulkService = new ConversationBulkService(
    privateRoomService,
    groupRoomService,
    groupMemberService,
    chatMessageOrchestrator,
    privateRoomRepo,
    groupRoomRepo
  );
  const autoDeleteService = new AutoDeleteService(
    privateRoomRepo,
    privateMessageRepo,
    privateSystemMessageService,
    privatePinService,
    chatMessageOrchestrator,
    redis
  );
  const groupAutoDeleteService = new GroupAutoDeleteService(
    groupRoomRepo,
    groupMemberRepo,
    groupMessageRepo,
    groupSystemMessageService,
    groupPinService,
    chatMessageOrchestrator,
    redis
  );

  // -- Real controllers --
  const controllers: Controllers = {
    privateRoomCtrl: new PrivateRoomController(
      privateRoomService,
      autoDeleteService
    ),
    inboxCtrl: new InboxController(inboxService),
    conversationBulkCtrl: new ConversationBulkController(
      conversationBulkService
    ),
    syncCtrl: new SyncController(syncService),
    privateMessageCtrl: new PrivateMessageController(
      privateMessageService,
      privatePinService,
      redis,
      chatMessageOrchestrator
    ),
    groupRoomCtrl: new GroupRoomController(
      groupRoomService,
      groupAutoDeleteService
    ),
    groupMessageCtrl: new GroupMessageController(
      groupMessageService,
      groupPinService,
      redis,
      chatMessageOrchestrator
    ),
    groupMemberCtrl: new GroupMemberController(groupMemberService),
    groupInviteLinkCtrl: new GroupInviteLinkController(
      groupInviteLinkService,
      groupMemberService
    ),
    notificationCtrl: new NotificationController(
      notificationService,
      notificationCatalogueService
    ),
    unreadSummaryCtrl: new UnreadSummaryController(unreadSummaryService),
    communityCtrl: new CommunityController(communityRoomService),
    communityMessageCtrl: new CommunityMessageController(
      communityMessageService,
      communityPinService,
      redis,
      chatMessageOrchestrator
    ),
    callCtrl: new CallController(callService),
    presenceCtrl: new PresenceController(presenceService),
    messageContextCtrl: new MessageContextController(
      privateMessageService,
      groupMessageService,
      communityMessageService
    ),
    messageSearchCtrl: new MessageSearchController(
      new MessageSearchService(
        messageSearchRepo,
        privateRoomRepo,
        groupRoomRepo,
        groupMemberRepo,
        generalRoomRepo,
        roomMemberRepo,
        userSnapshotService,
        cacheRepo
      )
    ),
  };

  const app = createApp(controllers);

  return {
    app,
    mocks: {
      privateRoomRepo,
      privateMessageRepo,
      privateMessagePinRepo,
      privateMessageReportRepo,
      groupRoomRepo,
      groupMessageRepo,
      groupMemberRepo,
      groupInviteLinkRepo,
      groupMessagePinRepo,
      communityMessagePinRepo,
      generalRoomRepo,
      generalRoomMessageRepo,
      roomMemberRepo,
      notificationRepo,
      notificationCategoryRepo,
      callRepo,
      messageSearchRepo,
      cacheRepo,
      userServiceClient,
      friendshipGrpcClient,
      communityClient,
      streamCountsClient,
      redis,
      userSnapshotService,
      presenceService,
      presenceVisibilityGate,
      privateMessageService,
      chatMessageOrchestrator,
      autoDeleteService,
      groupAutoDeleteService,
      groupMessageService,
    },
  };
}

/**
 * Program BOTH group-membership lookups with the same rows.
 *
 * The inbox/count paths read `getActiveOrLeftMemberships` (ACTIVE + LEFT +
 * KICKED — a removed member keeps a read-only row), while `/my-groups` and the
 * unread sum still read the ACTIVE-only `getActiveMemberships`. A spec that
 * stubs only one of them gets `undefined` back from the other and 500s, so
 * stub them together unless the spec is specifically about the difference.
 */
export function mockGroupMemberships(mocks: BuiltMocks, rows: unknown[]): void {
  mocks.groupMemberRepo.getActiveMemberships.mockResolvedValue(rows);
  mocks.groupMemberRepo.getActiveOrLeftMemberships.mockResolvedValue(rows);
}
