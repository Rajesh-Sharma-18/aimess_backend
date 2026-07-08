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

import { createApp } from "../../src/app.js";
import type { Controllers } from "../../src/api/routes/index.js";

// -- Real services --
import { PrivateRoomService } from "../../src/services/private-room.service.js";
import { InboxService } from "../../src/services/inbox.service.js";
import { SyncService } from "../../src/services/sync.service.js";
import { PrivateMessageService } from "../../src/services/private-message.service.js";
import { PrivatePinService } from "../../src/services/private-pin.service.js";
import { GroupRoomService } from "../../src/services/group-room.service.js";
import { GroupSystemMessageService } from "../../src/services/group-system-message.service.js";
import { GroupMessageService } from "../../src/services/group-message.service.js";
import { GroupMemberService } from "../../src/services/group-member.service.js";
import { GroupInviteLinkService } from "../../src/services/group-invite-link.service.js";
import { GroupPinService } from "../../src/services/group-pin.service.js";
import { NotificationService } from "../../src/services/notification.service.js";
import { CommunityRoomService } from "../../src/services/community-room.service.js";
import { CommunityMessageService } from "../../src/services/community-message.service.js";
import { CommunityPinService } from "../../src/services/community-pin.service.js";
import { ChatMessageOrchestrator } from "../../src/services/chat-message-orchestrator.js";
import { UserSnapshotService } from "../../src/services/user-snapshot.service.js";
import { CallService } from "../../src/services/call.service.js";
import { PresenceService } from "../../src/services/presence.service.js";

// -- Real controllers --
import { PrivateRoomController } from "../../src/api/controllers/private-room.controller.js";
import { InboxController } from "../../src/api/controllers/inbox.controller.js";
import { SyncController } from "../../src/api/controllers/sync.controller.js";
import { PrivateMessageController } from "../../src/api/controllers/private-message.controller.js";
import { GroupRoomController } from "../../src/api/controllers/group-room.controller.js";
import { GroupMessageController } from "../../src/api/controllers/group-message.controller.js";
import { GroupMemberController } from "../../src/api/controllers/group-member.controller.js";
import { GroupInviteLinkController } from "../../src/api/controllers/group-invite-link.controller.js";
import { NotificationController } from "../../src/api/controllers/notification.controller.js";
import { CommunityController } from "../../src/api/controllers/community.controller.js";
import { CommunityMessageController } from "../../src/api/controllers/community-message.controller.js";
import { CallController } from "../../src/api/controllers/call.controller.js";
import { PresenceController } from "../../src/api/controllers/presence.controller.js";

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
    multi: jest.fn(() => ({
      zremrangebyscore: jest.fn().mockReturnThis(),
      zadd: jest.fn().mockReturnThis(),
      zcard: jest.fn().mockReturnThis(),
      pexpire: jest.fn().mockReturnThis(),
      exec: jest.fn(async () => null),
    })),
    zrange: jest.fn(async () => []),
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
  callRepo: any;
  cacheRepo: any;
  // peers / infra
  userServiceClient: any;
  streamCountsClient: any;
  redis: any;
  userSnapshotService: UserSnapshotService;
  // services (handy for spies in a few specs)
  presenceService: PresenceService;
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
  const redis = redisMock();

  // -- Mock repositories --
  const cacheRepo = repoMock();
  const privateRoomRepo = repoMock();
  const privateMessageRepo = repoMock();
  const privateMessagePinRepo = repoMock();
  const privateMessageReportRepo = repoMock();
  const groupRoomRepo = repoMock();
  const groupMessageRepo = repoMock();
  const groupMemberRepo = repoMock();
  const groupInviteLinkRepo = repoMock();
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
  const generalRoomRepo = repoMock();
  // Default: community general rooms are open/active. The community write gate
  // (`assertCommunityRoomWritable`) loads the room on send/edit/delete/react/pin;
  // a spec that exercises a closed/suspended community overrides this.
  generalRoomRepo.findRoomById.mockResolvedValue({
    id: "room",
    status: "active",
  });
  const generalRoomMessageRepo = repoMock();
  const roomMemberRepo = repoMock();
  const notificationRepo = repoMock();
  const callRepo = repoMock();

  // -- Peers / collaborators --
  // UserSnapshotService is real (it calls the mocked user-service-client lib +
  // cacheRepo). Provide a userServiceClient stub used by the room services.
  const userSnapshotService = new UserSnapshotService();
  const userServiceClient: any = {
    checkFriendship: jest.fn(async () => true),
  };

  // -- Real services wired to mocks --
  const privateRoomService = new PrivateRoomService(
    privateRoomRepo,
    privateMessageRepo,
    cacheRepo,
    userSnapshotService,
    userServiceClient,
    redis
  );
  const privateMessageService = new PrivateMessageService(
    privateMessageRepo,
    privateRoomRepo,
    cacheRepo,
    userSnapshotService,
    userServiceClient,
    privateMessageReportRepo
  );
  const privatePinService = new PrivatePinService(
    privateMessagePinRepo,
    privateMessageRepo,
    privateRoomRepo,
    cacheRepo,
    userSnapshotService
  );

  const groupSystemMessageService = new GroupSystemMessageService(
    groupMessageRepo,
    groupRoomRepo,
    groupMemberRepo,
    cacheRepo,
    userSnapshotService,
    redis
  );
  const groupMemberService = new GroupMemberService(
    groupMemberRepo,
    groupRoomRepo,
    groupSystemMessageService
  );
  const groupRoomService = new GroupRoomService(
    groupRoomRepo,
    groupMemberRepo,
    groupInviteLinkRepo,
    groupSystemMessageService,
    redis,
    groupMessageRepo
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
    groupMemberRepo
  );
  const groupPinService = new GroupPinService(
    groupMessagePinRepo,
    groupMessageRepo,
    groupRoomRepo,
    groupMemberRepo,
    cacheRepo,
    userSnapshotService
  );

  const notificationService = new NotificationService(notificationRepo);
  const callService = new CallService(callRepo, privateRoomRepo, redis);

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
  const communityPinService = new CommunityPinService(
    communityMessagePinRepo,
    generalRoomMessageRepo,
    generalRoomRepo,
    roomMemberRepo,
    undefined,
    userSnapshotService,
    cacheRepo
  );

  const presenceService = new PresenceService(cacheRepo, redis);
  const inboxService = new InboxService(privateRoomService, groupRoomService);
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
    groupPinService
  );

  // -- Real controllers --
  const controllers: Controllers = {
    privateRoomCtrl: new PrivateRoomController(privateRoomService),
    inboxCtrl: new InboxController(inboxService),
    syncCtrl: new SyncController(syncService),
    privateMessageCtrl: new PrivateMessageController(
      privateMessageService,
      privatePinService,
      redis,
      chatMessageOrchestrator
    ),
    groupRoomCtrl: new GroupRoomController(groupRoomService),
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
    notificationCtrl: new NotificationController(notificationService),
    communityCtrl: new CommunityController(communityRoomService),
    communityMessageCtrl: new CommunityMessageController(
      communityMessageService,
      communityPinService,
      redis,
      chatMessageOrchestrator
    ),
    callCtrl: new CallController(callService),
    presenceCtrl: new PresenceController(presenceService),
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
      callRepo,
      cacheRepo,
      userServiceClient,
      streamCountsClient,
      redis,
      userSnapshotService,
      presenceService,
    },
  };
}
