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
};
