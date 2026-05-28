import { openApiParameters } from "../../components/parameters.js";
import { openApiSchemas } from "../../components/schemas.js";
import { appVersionPaths } from "../../paths/app-version.paths.js";
import { authPaths } from "../../paths/auth.paths.js";
import { communityPaths } from "../../paths/community.paths.js";
import { userPaths } from "../../paths/user.paths.js";

/** OpenAPI paths for API v1 (relative to server URL `…/api/v1`). */
export const v1Paths = {
  ...appVersionPaths,
  ...authPaths,
  ...userPaths,
  ...communityPaths,
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
];

export const v1Components = {
  parameters: openApiParameters,
  schemas: openApiSchemas,
};
