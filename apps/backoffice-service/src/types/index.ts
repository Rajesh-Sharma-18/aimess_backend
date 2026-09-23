/** HTTP payloads, DTOs, and shared typing for this service. */
export type ApiSuccess<T> = {
  success: true;
  data: T;
};

/** The authenticated admin attached to the request by `adminAuth`. */
export type RequestAdmin = {
  id: string;
  /**
   * AdminUser.name, resolved by `adminAuth` from the row it already loads.
   * Carried so a moderation action performed platform-side can be attributed by
   * name in the service that owns the affected data (chat-service cannot read
   * admin_db), instead of surfacing as an anonymous actor.
   */
  name: string;
  role: string;
  permissions: string[];
  sid: string;
};

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      admin?: RequestAdmin;
    }
  }
}

export {};
