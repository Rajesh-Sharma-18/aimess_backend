import path from "node:path";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import CircuitBreaker from "opossum";
import { logger } from "@aimess/logger";
import { env } from "../../config/env.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = path.resolve(
  __dirname,
  "../../../../../packages/grpc-contracts/proto/notification.proto"
);

const BREAKER_OPTS = {
  timeout: 2000,
  errorThresholdPercentage: 50,
  resetTimeout: 10000,
  volumeThreshold: 5,
};

export interface GetNotificationsParams {
  userId: string;
  cursor?: string;
  limit?: number;
}
export interface GetNotificationsResponse {
  notifications: NotificationDto[];
  nextCursor: string;
  hasMore: boolean;
  unreadCount: number;
}
export interface NotificationDto {
  notificationId: string;
  userId: string;
  type: string;
  title: string;
  body: string;
  referenceId: string;
  isRead: boolean;
  createdAt: number;
}
export interface MarkNotificationsReadParams {
  userId: string;
  notificationIds: string[];
}
export interface MarkNotificationsReadResult {
  updatedCount: number;
  remainingUnread: number;
}

export interface NotificationClient {
  getNotifications(
    p: GetNotificationsParams
  ): Promise<GetNotificationsResponse>;
  markNotificationsRead(
    p: MarkNotificationsReadParams
  ): Promise<MarkNotificationsReadResult>;
}

function makeBreaker<T, R>(
  name: string,
  fn: (p: T) => Promise<R>
): CircuitBreaker<[T], R> {
  const breaker = new CircuitBreaker(fn, { ...BREAKER_OPTS, name });
  breaker.fallback(() => {
    throw new Error(`${name} unavailable`);
  });
  breaker.on("open", () => logger.warn(`Circuit opened: ${name}`));
  breaker.on("halfOpen", () => logger.info(`Circuit half-open: ${name}`));
  return breaker;
}

export function createNotificationClient(): NotificationClient {
  const pkgDef = protoLoader.loadSync(PROTO_PATH, {
    keepCase: false,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const proto = grpc.loadPackageDefinition(pkgDef) as grpc.GrpcObject;
  const ServiceCtor = (proto["notification"] as grpc.GrpcObject)[
    "NotificationService"
  ] as grpc.ServiceClientConstructor;
  const client = new ServiceCtor(
    env.NOTIFICATION_GRPC_URL,
    grpc.credentials.createInsecure()
  );

  function call<TReq, TRes>(method: string, req: TReq): Promise<TRes> {
    return new Promise((resolve, reject) => {
      const typed = client as unknown as Record<
        string,
        (r: TReq, cb: (e: grpc.ServiceError | null, res: TRes) => void) => void
      >;
      typed[method](req, (err, res) => {
        if (err) reject(err);
        else resolve(res);
      });
    });
  }

  const getNotifBreaker = makeBreaker(
    "notification.getNotifications",
    (p: GetNotificationsParams) =>
      call<unknown, GetNotificationsResponse>("getNotifications", {
        userId: p.userId,
        cursor: p.cursor ?? "",
        limit: p.limit ?? 20,
      })
  );
  const markReadBreaker = makeBreaker(
    "notification.markNotificationsRead",
    (p: MarkNotificationsReadParams) =>
      call<unknown, MarkNotificationsReadResult>("markNotificationsRead", {
        userId: p.userId,
        notificationIds: p.notificationIds,
      })
  );

  return {
    getNotifications: (p) => getNotifBreaker.fire(p),
    markNotificationsRead: (p) => markReadBreaker.fire(p),
  };
}
