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
   * Admin-panel records only. Never forwarded to a user-facing service: AIMess
   * users see a Backoffice actor as "Administrator".
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
