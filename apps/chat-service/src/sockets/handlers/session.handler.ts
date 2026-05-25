import type { Server as SocketIOServer, Socket } from "socket.io";

import { logger } from "@aimess/logger";

import type { CacheRepository } from "../../repositories/cache.repository.js";
import type { PresenceService } from "../../services/presence.service.js";
import { fetchUsersBatch } from "../../lib/user-service-client.js";

export function registerSessionHandler(
  io: SocketIOServer,
  socket: Socket,
  cacheRepo: CacheRepository,
  presenceService: PresenceService
): void {
  const { userId, deviceId, platform, clientType, socketId, displayname } =
    socket.user;

  logger.debug(
    `SessionHandler|connected userId=${userId}, deviceId=${deviceId}, platform=${platform}, clientType=${clientType}`
  );

  // Initialize online state on connection
  cacheRepo
    .upsertDeviceSession({
      userId,
      deviceId,
      socketId,
      platform,
      clientType,
      realtimeConnected: true,
      appState: "FOREGROUND",
      now: Date.now(),
    })
    .then(() => presenceService.recompute(userId))
    .catch((err) => {
      logger.error(
        `SessionHandler|upsertDeviceSession|error: ${err instanceof Error ? err.stack : String(err)}`
      );
    });

  // Pre-warm user snapshot cache on connect
  cacheRepo
    .getUserSnapshot(userId)
    .then(async (existing) => {
      if (existing) return;
      const users = await fetchUsersBatch([userId]);
      if (users.length > 0) {
        const u = users[0];
        await cacheRepo.setUserSnapshot(userId, {
          userId: u.userId,
          displayName: u.displayName,
          avatar: u.avatar,
          memberId: u.username,
          isDeletedUser: false,
          isOnline: u.isOnline,
        });
      } else if (displayname) {
        await cacheRepo.setUserSnapshot(userId, {
          userId,
          displayName: displayname,
          avatar: "",
          memberId: "",
          isDeletedUser: false,
          isOnline: true,
        });
      }
    })
    .catch((err) => {
      logger.warn(
        `SessionHandler|snapshotWarm|error: ${err instanceof Error ? err.message : String(err)}`
      );
    });

  // Handle disconnect
  socket.on("disconnect", (reason) => {
    logger.debug(
      `SessionHandler|disconnect userId=${userId}, displayname=${displayname}, reason=${reason}`
    );

    cacheRepo
      .setDisconnected({ userId, deviceId, nowMs: Date.now() })
      .then(() => presenceService.recompute(userId))
      .catch((err) => {
        logger.error(
          `SessionHandler|setDisconnected|error: ${err instanceof Error ? err.stack : String(err)}`
        );
      });
  });

  socket.on("error", (err) => {
    logger.error(
      `SessionHandler|socket error userId=${userId}: ${err instanceof Error ? err.message : String(err)}`
    );
  });
}
