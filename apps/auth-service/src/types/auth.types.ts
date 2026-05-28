export type AuthUserResponse = {
  userId: string;
  account: string;
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
};

export type AccessTokenResponse = {
  accessToken: string;
  accessTokenExpiresIn: number;
};
