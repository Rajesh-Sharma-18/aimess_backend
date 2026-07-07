import { logger } from "@aimess/logger";
import type { UserDeletedPayload } from "@aimess/shared-types";
import { userProfileService } from "../services/user-profile.service.js";
import { streamGrpcClient } from "../grpc/stream.client.js";

export async function handleUserDeleted(
  data: UserDeletedPayload
): Promise<void> {
  await userProfileService.softDeleteFromUserDeletedEvent(data);

  // Fire-and-forget (matches community-service's identical `void
  // getStreamClient().forceEndStreamsByCreator(...)` calls) — must never be
  // able to turn a successful profile deletion into a nack'd/dead-lettered
  // `user.deleted` message. A deleted account must not keep broadcasting on a
  // still-valid access token until it expires.
  void streamGrpcClient
    .forceEndStreamsByCreator(data.userId, "ACCOUNT_DELETED")
    .catch((err: unknown) => {
      logger.warn(
        `forceEndStreamsByCreator failed for deleted user=${data.userId}: ${String(err)}`
      );
    });
}
