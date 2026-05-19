import { openApiParameters } from "../../components/parameters.js";
import { openApiSchemas } from "../../components/schemas.js";
import { authPaths } from "../../paths/auth.paths.js";
import { userPaths } from "../../paths/user.paths.js";

/** OpenAPI paths for API v1 (relative to server URL `…/api/v1`). */
export const v1Paths = {
  ...authPaths,
  ...userPaths,
};

export const v1Tags = [
  { name: "Auth", description: "Registration and login (auth-service)" },
  { name: "Users", description: "Profiles and social (user-service)" },
];

export const v1Components = {
  parameters: openApiParameters,
  schemas: openApiSchemas,
};
