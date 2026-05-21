/** Cross-service user domain events (auth-service ↔ user-service). */
export const UserEvents = {
  USER_CREATED: "user.created",
  USER_DELETED: "user.deleted",
} as const;

export type UserEventType = (typeof UserEvents)[keyof typeof UserEvents];

export type UserCreatedPayload = {
  userId: string;
  account: string;
  /** Present when the user registered or signed up with an email; omitted for account-only signup. */
  email?: string;
  createdAt: string;
};

export type UserDeletedPayload = {
  userId: string;
  deletedAt: string;
};
