export {
  ACCESS_TOKEN_TYPE,
  ADMIN_ACCESS_TOKEN_TYPE,
  extractBearerToken,
  signAccessToken,
  verifyAccessToken,
  verifyAdminAccessToken,
  type AccessTokenPayload,
  type AdminAccessTokenPayload,
  type PlatformRole,
  type VerifiedAccessToken,
  type VerifiedAdminAccessToken,
} from "./access-token.js";

export {
  createAuthenticateAccessToken,
  type AuthenticateAccessTokenOptions,
} from "./middleware.js";
