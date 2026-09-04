export type AuthUserResponse = {
  userId: string;
  account: string;
  role: string;
};

export type AuthTokensResponse = {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresIn: number;
  refreshTokenExpiresIn: number;
};

export type RegisterResult = {
  user: AuthUserResponse & { createdAt: string };
  tokens: AuthTokensResponse;
};

export type LoginResult = {
  tokens: AuthTokensResponse;
  /** Whether the user has filled in their required profile fields; lets the
   * client route to the edit-profile screen on first login. */
  isProfileCompleted: boolean;
  role: string;
};

export type AccessTokenResponse = {
  accessToken: string;
  accessTokenExpiresIn: number;
  /**
   * The rotated refresh token. Additive: this endpoint used to mint an access
   * token and leave the refresh token untouched, so a stolen one could be
   * replayed forever without tripping reuse detection. The caller MUST store
   * this and use it next time — the token it sent is now spent.
   */
  refreshToken: string;
  refreshTokenExpiresIn: number;
};
