import { adminPaths } from "../../paths/admin.paths.js";
import { openApiParameters } from "../../components/parameters.js";
import { openApiSchemas } from "../../components/schemas.js";
import { appVersionPaths } from "../../paths/app-version.paths.js";
import { authPaths } from "../../paths/auth.paths.js";
import { chatPaths } from "../../paths/chat.paths.js";
import { communityPaths } from "../../paths/community.paths.js";
import { userPaths } from "../../paths/user.paths.js";
import { chatExtrasPaths } from "../../paths/chat-extras.paths.js";
import { chatChangesPaths } from "../../paths/chat-changes.paths.js";
import { devicesPaths } from "../../paths/devices.paths.js";
import { mediaPaths } from "../../paths/media.paths.js";
import { searchPaths } from "../../paths/search.paths.js";
import { streamPaths } from "../../paths/stream.paths.js";

/**
 * OpenAPI paths for API v1.
 *
 * Non-admin keys are relative to server URL `…/api/v1`. Admin keys
 * (`/admin/v1/...`) carry their full prefix and get a path-level `servers`
 * override (the gateway root) stamped at build time — see openapi-document.ts.
 */
export const v1Paths = {
  ...appVersionPaths,
  ...authPaths,
  ...userPaths,
  ...communityPaths,
  ...chatPaths,
  ...chatExtrasPaths,
  // Folded onto v1 when /api/v2 was retired: the zero-loss /changes feeds and the
  // room-inferred SET-reaction routes. All keys are new — no overrides.
  ...chatChangesPaths,
  ...devicesPaths,
  ...mediaPaths,
  ...searchPaths,
  ...streamPaths,
  ...adminPaths,
};

export const v1Tags = [
  {
    name: "App",
    description: "Mobile app version / force-update checks (gateway)",
  },
  { name: "Auth", description: "Registration and login (auth-service)" },
  { name: "Users", description: "Profiles and social (user-service)" },
  {
    name: "Communities",
    description: "Communities and categories (community-service)",
  },
  {
    name: "Chat — Private",
    description: "1-to-1 private messaging (chat-service)",
  },
  {
    name: "Chat — Inbox",
    description: "Unified private + group conversation list and unread summary",
  },
  {
    name: "Chat — Groups",
    description:
      "Group rooms, members, messages, pins, and invite links (chat-service)",
  },
  {
    name: "Chat — Notifications",
    description: "In-app notification feed (chat-service)",
  },
  {
    name: "Chat — Community",
    description: "Community room browsing and messaging (chat-service)",
  },
  {
    name: "Media",
    description:
      "Centralized presigned URL generation for all media uploads and downloads",
  },
  {
    name: "Search",
    description:
      "Unified cursor-paginated search across messages, communities and people (gateway fan-out)",
  },
  {
    name: "Streams",
    description:
      "Livestream lifecycle, comments, viewers, and moderation (stream-service)",
  },
  {
    name: "Devices",
    description:
      "FCM / APNs device token registration for push notifications (notifications-service)",
  },
  {
    name: "Admin — Auth & Account",
    description: "Admin login, session, self profile (backoffice-service)",
  },
  {
    name: "Admin — Dashboard",
    description: "Stat cards, charts, service status (backoffice-service)",
  },
  {
    name: "Admin — User Management",
    description: "List, ban, suspend, sessions (backoffice-service)",
  },
  {
    name: "Admin — Communities",
    description: "Community moderation (backoffice-service)",
  },
  {
    name: "Admin — Groups",
    description: "Group-room moderation (backoffice-service)",
  },
  {
    name: "Admin — Reports & Moderation",
    description: "Moderation queue + actions (backoffice-service)",
  },
  {
    name: "Admin — Livestreams",
    description: "Livestream monitoring + force-end (backoffice-service)",
  },
  {
    name: "Admin — Announcements",
    description: "i18n platform announcements (backoffice-service)",
  },
  {
    name: "Admin — Categories",
    description: "Community categories (backoffice-service)",
  },
  {
    name: "Admin — Audit Logs",
    description: "Append-only admin action log (backoffice-service)",
  },
  {
    name: "Admin — System Health",
    description: "Health, queues, metrics + infra probes (backoffice-service)",
  },
  {
    name: "Admin — Admin Accounts",
    description:
      "Admin accounts & roles, SUPER_ADMIN only (backoffice-service)",
  },
];

export const v1Components = {
  parameters: openApiParameters,
  schemas: openApiSchemas,
};
