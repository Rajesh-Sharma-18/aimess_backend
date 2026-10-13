import { logger } from "@aimess/logger";
import {
  accountCopy,
  resolveTimeZone,
  type LocalizedCopy,
} from "@aimess/constants";
import {
  AdminUserEvents,
  type AdminUserNotifyPayload,
  type NotificationNavigation,
} from "@aimess/shared-types";
import amqp from "amqplib";

import { env } from "../config/env.js";
import { accountRestrictedEmail } from "../providers/mail/templates/account-restricted.js";
import { sendMail } from "../providers/mail/sendMail.js";
import { deviceTokenService } from "../services/device-token.service.js";
import { pushToUser } from "../services/push.service.js";
import { getUserLocale } from "../services/notification-settings.service.js";

/**
 * auth-service re-publishes admin ban/suspend/unban actions (after force-logout)
 * to this plain durable queue as notify-ready messages. We deliver each to the
 * affected user via pushToUser (settings/quiet-hours gate → inbox row → realtime
 * bridge → FCM-if-offline). Ban/suspend/unban carry the `systemEnabled`
 * category for tab placement, but they are account-integrity events and are
 * exempt from the toggle and from quiet hours via NON_SUPPRESSIBLE_TYPES in
 * push.service.ts — a banned user must always be told.
 * Envelope: JSON.stringify({ type, data }) where data is the
 * notify-ready payload published by auth-service publish-admin-user-notify.ts.
 */
const ADMIN_USER_NOTIFY_QUEUE = "admin.user.notify.queue";

/**
 * The localized builder behind each admin action.
 *
 * auth-service still publishes a rendered `title`/`body`, and they are still
 * used — as the LEGACY FALLBACK for a type this build does not recognize. The
 * builder is what makes the row follow its reader: `pushToUser` renders it in
 * the recipient's language for the stored row, attaches the replay ticket so
 * the Notification Center can re-render it after a language change, and renders
 * it once per device locale for the tray.
 */
const NOTIFY_COPY_BUILDER: Record<
  string,
  ((data: Record<string, string>) => LocalizedCopy) | undefined
> = {
  [AdminUserEvents.USER_BANNED]: (data) => accountCopy.banned(data.reason),
  [AdminUserEvents.USER_SUSPENDED]: (data) =>
    accountCopy.suspended(Date.parse(data.suspendedUntil ?? "") || null, data.reason),
  [AdminUserEvents.USER_UNBANNED]: () => accountCopy.reinstated(),
  [AdminUserEvents.USER_ACCOUNT_UPDATED]: () => accountCopy.updatedByAdmin(),
  ACCOUNT_WARNED: (data) => accountCopy.warned(data.note),
  REPORT_OUTCOME: (data) => accountCopy.reportOutcome(data.outcome ?? ""),
};

async function handleAdminUserNotify(
  type: string,
  data: unknown
): Promise<void> {
  const p = data as AdminUserNotifyPayload;
  if (!p?.userId || !p.title || !p.body) {
    logger.warn(`admin.user.notify message missing required fields: ${type}`);
    return;
  }

  // A Super Admin is not an AIMess user: no actor on the row, and their id
  // (sent by older publishers as data.actorId) never reaches the inbox or FCM.
  const { actorId: _adminId, ...rest } = p.data ?? {};

  await pushToUser({
    userId: p.userId,
    category: "systemEnabled",
    type,
    copy: NOTIFY_COPY_BUILDER[type]?.(p.data ?? {}),
    title: p.title,
    body: p.body,
    data: {
      ...rest,
      navigation: JSON.stringify({
        screen: "ACCOUNT_STATUS",
      } satisfies NotificationNavigation),
    },
  });

  if (p.email) {
    const locale = await getUserLocale(p.userId).catch(() => undefined);
    // The most recently seen device's zone; none → UTC.
    const latest = (await deviceTokenService.getTokensForUser(p.userId).catch(() => []))
      .filter((row) => row.timezone)
      .sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime())[0];
    const until = Date.parse(p.data?.suspendedUntil ?? "");
    // The push already went out; a mail failure must not dead-letter it.
    await sendMail({
      to: p.email,
      ...accountRestrictedEmail({
        banned: type === AdminUserEvents.USER_BANNED,
        reason: p.data?.reason ?? "",
        until: Number.isFinite(until) ? until : null,
        locale,
        timeZone: resolveTimeZone(latest?.timezone),
      }),
    }).catch((error: unknown) => {
      logger.warn(`account-restricted email failed user=${p.userId}`);
      logger.warn(error);
    });
  }
}

export async function startAdminUserConsumer(): Promise<void> {
  const connection = await amqp.connect(env.RABBITMQ_URL);
  const channel = await connection.createChannel();

  await channel.assertQueue(ADMIN_USER_NOTIFY_QUEUE, { durable: true });
  await channel.prefetch(10);

  logger.info("Admin-user notification consumer started");

  void channel.consume(ADMIN_USER_NOTIFY_QUEUE, (message) => {
    if (!message) return;

    void (async () => {
      try {
        const parsed = JSON.parse(message.content.toString()) as {
          type: string;
          data: unknown;
        };
        await handleAdminUserNotify(parsed.type, parsed.data);
        channel.ack(message);
      } catch (error) {
        logger.error("Admin-user consumer failed to process message", error);
        channel.nack(message, false, false);
      }
    })();
  });
}
