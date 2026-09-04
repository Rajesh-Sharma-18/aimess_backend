export {
  ACCESS_TOKEN_AUDIENCE,
  ACCESS_TOKEN_ISSUER,
  ACCESS_TOKEN_TYPE,
  ADMIN_ACCESS_TOKEN_TYPE,
  extractBearerToken,
  signAccessToken,
  verifyAccessToken,
  verifyAdminAccessToken,
  type AccessTokenPayload,
  type AccessTokenSigningKey,
  type AccessTokenVerifyConfig,
  type AdminAccessTokenPayload,
  type PlatformRole,
  type VerifiedAccessToken,
  type VerifiedAdminAccessToken,
} from "./access-token.js";

export {
  createAuthenticateAccessToken,
  type AuthenticateAccessTokenOptions,
} from "./middleware.js";
