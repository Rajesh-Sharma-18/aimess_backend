import { logger } from "@aimess/logger";
import { parseSupportedLocale } from "@aimess/constants";
import {
  SESSION_LOCALE_CHANNEL,
  type SessionLocaleChange,
} from "@aimess/redis";

import { redis } from "../config/redis.js";
import { deviceTokenRepository } from "../repositories/device-token.repository.js";

/**
 * Keep a device's PUSH language in step with the language its session is
 * actually reading in.
 *
 * `DeviceToken.locale` is written by the owning client when it registers, and
 * that is the only moment the server hears about it — so a user who switched
 * language in the app flipped every socket-rendered surface instantly and went
 * on receiving push tray text in the old language until the client happened to
 * re-register its token. Re-registering is a client contract the server cannot
 * enforce, and the mismatch is visible on one device at one time: the banner
 * says one language, the notification it opens says another.
 *
 * The gateway publishes on `locale:set`, which is the one moment the server
 * genuinely knows. This applies it to the tokens of THAT session only, so a
 * second device of the same account is untouched.
 *
 * Its own connection: ioredis cannot mix subscriber mode with regular commands,
 * and this consumer has to issue a write for every message it receives.
 */
export async function startSessionLocaleConsumer(): Promise<void> {
  // connectRedis returns a SINGLETON, so this consumer never actually had its
  // own connection despite the note above — it shared one with every cache
  // caller, and subscribing broke all of them. `duplicate()` clones the
  // service's configured client, inheriting host/port/auth/TLS; the partial
  // option set that used to be passed to connectRedis here omitted `tls`, and
  // whichever caller reached connectRedis first decided the whole process's
  // connection.
  const subscriber = redis.duplicate();
  if (subscriber.status === "wait") await subscriber.connect();
  await subscriber.subscribe(SESSION_LOCALE_CHANNEL);

  logger.info("Session-locale consumer started");

  subscriber.on("message", (channel: string, raw: string) => {
    if (channel !== SESSION_LOCALE_CHANNEL) return;
    void (async () => {
      try {
        const change = JSON.parse(raw) as SessionLocaleChange;
        // Re-validate rather than trust the wire: this decides what language a
        // user is spoken to in, and an unsupported value must leave the
        // previous one in place rather than be normalized onto the default.
        const locale = parseSupportedLocale(change.locale);
        if (!locale || !change.userId || !change.sessionId) return;
        const moved = await deviceTokenRepository.updateLocaleBySession(
          change.userId,
          change.sessionId,
          locale
        );
        if (moved > 0) {
          logger.debug(
            `[session:locale] ${String(moved)} device token(s) → ${locale} for session ${change.sessionId}`
          );
        }
      } catch (error) {
        // A language preference is never worth crashing a consumer over; the
        // next registration or the next change re-states it.
        logger.warn("session-locale consumer failed to apply a change");
        logger.warn(error);
      }
    })();
  });
}
