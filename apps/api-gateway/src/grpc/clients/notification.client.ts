import path from "node:path";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { env } from "../../config/env.js";
import { makeBreaker, makeGrpcCall } from "@aimess/grpc-utils";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = path.resolve(
  __dirname,
  "../../../../../packages/grpc-contracts/proto/notification.proto"
);

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

  const call = <TReq, TRes>(method: string, req: TReq) =>
    makeGrpcCall<TReq, TRes>(client, method, req);

  const getNotifBreaker = makeBreaker(
    "notification.getNotifications",
    (p: GetNotificationsParams) =>
      call<unknown, GetNotificationsResponse>("getNotifications", {
        userId: p.userId,
        cursor: p.cursor ?? "",
        limit: p.limit ?? 20,
        // int64 created_at arrives as a string (proto-loader longs:String);
        // coerce each notification's epoch-ms timestamp so the
        // notifications:fetch ack matches the notification:new broadcast.
      }).then((r) => ({
        ...r,
        notifications: r.notifications.map((n) => ({
          ...n,
          createdAt: Number(n.createdAt),
        })),
      }))
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
