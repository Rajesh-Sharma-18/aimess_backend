/** Cross-service user domain events (auth-service ↔ user-service). */
export const UserEvents = {
  USER_CREATED: "user.created",
} as const;

export type UserEventType = (typeof UserEvents)[keyof typeof UserEvents];

export type UserCreatedPayload = {
  userId: string;
  account: string;
  email: string;
  createdAt: string;
};
