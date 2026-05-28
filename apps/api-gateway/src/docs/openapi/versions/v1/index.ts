import { openApiParameters } from "../../components/parameters.js";
import { openApiSchemas } from "../../components/schemas.js";
import { appVersionPaths } from "../../paths/app-version.paths.js";
import { authPaths } from "../../paths/auth.paths.js";
import { chatPaths } from "../../paths/chat.paths.js";
import { communityPaths } from "../../paths/community.paths.js";
import { userPaths } from "../../paths/user.paths.js";

/** OpenAPI paths for API v1 (relative to server URL `…/api/v1`). */
export const v1Paths = {
  ...appVersionPaths,
  ...authPaths,
  ...userPaths,
  ...communityPaths,
  ...chatPaths,
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
    name: "Chat — Media",
    description: "File upload presigned URLs (chat-service)",
  },
];

export const v1Components = {
  parameters: openApiParameters,
  schemas: openApiSchemas,
};
