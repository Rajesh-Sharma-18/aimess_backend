import { Router } from "express";

import { createPrivateMessageRoutes } from "./private-message.routes.js";
import { createInboxRoutes } from "./inbox.routes.js";
import { createConversationBulkRoutes } from "./conversation-bulk.routes.js";
import { createSyncRoutes } from "./sync.routes.js";
import { createGroupRoomRoutes } from "./group-room.routes.js";
import { createGroupMessageRoutes } from "./group-message.routes.js";
import { createGroupMemberRoutes } from "./group-member.routes.js";
import { createGroupInviteLinkRoutes } from "./group-invite-link.routes.js";
import { createNotificationRoutes } from "./notification.routes.js";
import { createUnreadSummaryRoutes } from "./unread-summary.routes.js";
import { createCommunityRoutes } from "./community.routes.js";
import { createCommunityV2Routes } from "./community-v2.routes.js";
import {
  createPrivateV2Routes,
  createGroupV2Routes,
  createInboxV2Routes,
} from "./chat-v2.routes.js";
import { createCallRoutes } from "./call.routes.js";
import { createMessageContextRoutes } from "./message-context.routes.js";
import { healthRoutes } from "./health.routes.js";

import type { PrivateRoomController } from "../controllers/private-room.controller.js";
import type { InboxController } from "../controllers/inbox.controller.js";
import type { ConversationBulkController } from "../controllers/conversation-bulk.controller.js";
import type { SyncController } from "../controllers/sync.controller.js";
import type { PrivateMessageController } from "../controllers/private-message.controller.js";
import type { GroupRoomController } from "../controllers/group-room.controller.js";
import type { GroupMessageController } from "../controllers/group-message.controller.js";
import type { GroupMemberController } from "../controllers/group-member.controller.js";
import type { GroupInviteLinkController } from "../controllers/group-invite-link.controller.js";
import type { NotificationController } from "../controllers/notification.controller.js";
import type { UnreadSummaryController } from "../controllers/unread-summary.controller.js";
import type { CommunityController } from "../controllers/community.controller.js";
import type { CommunityMessageController } from "../controllers/community-message.controller.js";
import type { CallController } from "../controllers/call.controller.js";
import type { PresenceController } from "../controllers/presence.controller.js";
import type { MessageContextController } from "../controllers/message-context.controller.js";

export interface Controllers {
  privateRoomCtrl: PrivateRoomController;
  inboxCtrl: InboxController;
  conversationBulkCtrl: ConversationBulkController;
  syncCtrl: SyncController;
  privateMessageCtrl: PrivateMessageController;
  groupRoomCtrl: GroupRoomController;
  groupMessageCtrl: GroupMessageController;
  groupMemberCtrl: GroupMemberController;
  groupInviteLinkCtrl: GroupInviteLinkController;
  notificationCtrl: NotificationController;
  unreadSummaryCtrl: UnreadSummaryController;
  communityCtrl: CommunityController;
  communityMessageCtrl: CommunityMessageController;
  callCtrl: CallController;
  presenceCtrl: PresenceController;
  messageContextCtrl: MessageContextController;
}

export function createRoutes(controllers: Controllers): Router {
  const router = Router();

  router.use("/", healthRoutes);

  const basePath = "/api/chat";

  router.use(`${basePath}/inbox`, createInboxRoutes(controllers.inboxCtrl));
  // Bulk (multi-select) ops over the unified inbox — PRIVATE + GROUP in one
  // call, mirroring community-service's /communities/{leave,mute,read}/bulk.
  router.use(
    `${basePath}/conversations`,
    createConversationBulkRoutes(controllers.conversationBulkCtrl)
  );
  router.use(`${basePath}/sync`, createSyncRoutes(controllers.syncCtrl));
  router.use(
    `${basePath}/private`,
    createPrivateMessageRoutes(
      controllers.privateRoomCtrl,
      controllers.privateMessageCtrl,
      controllers.presenceCtrl
    )
  );
  router.use(
    `${basePath}/groups`,
    createGroupRoomRoutes(controllers.groupRoomCtrl)
  );
  router.use(
    `${basePath}/groups`,
    createGroupMessageRoutes(controllers.groupMessageCtrl)
  );
  router.use(
    `${basePath}/group-members`,
    createGroupMemberRoutes(controllers.groupMemberCtrl)
  );
  router.use(
    `${basePath}/invite-links`,
    createGroupInviteLinkRoutes(controllers.groupInviteLinkCtrl)
  );
  router.use(
    `${basePath}/notifications`,
    createNotificationRoutes(controllers.notificationCtrl)
  );
  router.use(
    `${basePath}/unread-summary`,
    createUnreadSummaryRoutes(controllers.unreadSummaryCtrl)
  );
  router.use(
    `${basePath}/community`,
    createCommunityRoutes(
      controllers.communityCtrl,
      controllers.communityMessageCtrl
    )
  );
  // The V2 routers, ALSO mounted on the V1 base path. Every V2 chat endpoint is
  // the same handler with a different query contract, and V1's timeline schema
  // already accepts the seq/around cursors — but `/rooms/:roomId/changes` (the
  // zero-loss revision feed the clients use on reopen/reconnect) and the
  // `/messages/:messageId/react` shape existed ONLY under `/api/v2`, so a client
  // on `/api/v1` got a bare `Cannot GET /api/chat/private/rooms/:id/changes`.
  //
  // Mounted AFTER the V1 routers above, so every path both define (e.g.
  // `GET /rooms/:roomId/messages`) still resolves to its V1 handler — this only
  // ADDS the endpoints V1 was missing. The `/api/v2/*` mounts below stay live.
  router.use(
    `${basePath}/private`,
    createPrivateV2Routes(controllers.privateMessageCtrl)
  );
  router.use(
    `${basePath}/groups`,
    createGroupV2Routes(controllers.groupMessageCtrl)
  );
  router.use(
    `${basePath}/community`,
    createCommunityV2Routes(controllers.communityMessageCtrl)
  );

  // Additive V2 surface: gateway `/api/v2/chat/community/*` rewrites to this
  // mount. V1 (`${basePath}/community`) above is untouched and always on.
  router.use(
    "/api/v2/chat/community",
    createCommunityV2Routes(controllers.communityMessageCtrl)
  );
  router.use(
    "/api/v2/chat/private",
    createPrivateV2Routes(controllers.privateMessageCtrl)
  );
  router.use(
    "/api/v2/chat/group",
    createGroupV2Routes(controllers.groupMessageCtrl)
  );
  router.use("/api/v2/chat/inbox", createInboxV2Routes(controllers.inboxCtrl));
  router.use(`${basePath}/calls`, createCallRoutes(controllers.callCtrl));
  router.use(
    `${basePath}/messages`,
    createMessageContextRoutes(controllers.messageContextCtrl)
  );

  return router;
}
