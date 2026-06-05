/** HTTP payloads, DTOs, and shared typing for this service. */
export type ApiSuccess<T> = {
  success: true;
  data: T;
};

/** The authenticated admin attached to the request by `adminAuth`. */
export type RequestAdmin = {
  id: string;
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
