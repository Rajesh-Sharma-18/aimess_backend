import { Router } from "express";

import { createPrivateMessageRoutes } from "./private-message.routes.js";
import { createInboxRoutes } from "./inbox.routes.js";
import { createGroupRoomRoutes } from "./group-room.routes.js";
import { createGroupMessageRoutes } from "./group-message.routes.js";
import { createGroupMemberRoutes } from "./group-member.routes.js";
import { createGroupInviteLinkRoutes } from "./group-invite-link.routes.js";
import { createNotificationRoutes } from "./notification.routes.js";
import { createCommunityRoutes } from "./community.routes.js";
import { createMediaRoutes } from "./media.routes.js";
import { createCallRoutes } from "./call.routes.js";
import { healthRoutes } from "./health.routes.js";

import type { PrivateRoomController } from "../controllers/private-room.controller.js";
import type { InboxController } from "../controllers/inbox.controller.js";
import type { PrivateMessageController } from "../controllers/private-message.controller.js";
import type { GroupRoomController } from "../controllers/group-room.controller.js";
import type { GroupMessageController } from "../controllers/group-message.controller.js";
import type { GroupMemberController } from "../controllers/group-member.controller.js";
import type { GroupInviteLinkController } from "../controllers/group-invite-link.controller.js";
import type { NotificationController } from "../controllers/notification.controller.js";
import type { CommunityController } from "../controllers/community.controller.js";
import type { CommunityMessageController } from "../controllers/community-message.controller.js";
import type { MediaController } from "../controllers/media.controller.js";
import type { CallController } from "../controllers/call.controller.js";
import type { PresenceController } from "../controllers/presence.controller.js";

export interface Controllers {
  privateRoomCtrl: PrivateRoomController;
  inboxCtrl: InboxController;
  privateMessageCtrl: PrivateMessageController;
  groupRoomCtrl: GroupRoomController;
  groupMessageCtrl: GroupMessageController;
  groupMemberCtrl: GroupMemberController;
  groupInviteLinkCtrl: GroupInviteLinkController;
  notificationCtrl: NotificationController;
  communityCtrl: CommunityController;
  communityMessageCtrl: CommunityMessageController;
  mediaCtrl: MediaController;
  callCtrl: CallController;
  presenceCtrl: PresenceController;
}

export function createRoutes(controllers: Controllers): Router {
  const router = Router();

  router.use("/", healthRoutes);

  const basePath = "/api/chat";

  router.use(`${basePath}/inbox`, createInboxRoutes(controllers.inboxCtrl));
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
    `${basePath}/community`,
    createCommunityRoutes(
      controllers.communityCtrl,
      controllers.communityMessageCtrl
    )
  );
  router.use(`${basePath}/media`, createMediaRoutes(controllers.mediaCtrl));
  router.use(`${basePath}/calls`, createCallRoutes(controllers.callCtrl));

  return router;
}
