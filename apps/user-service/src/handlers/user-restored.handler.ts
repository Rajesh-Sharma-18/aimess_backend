import type { UserRestoredPayload } from "@aimess/shared-types";
import { userProfileService } from "../services/user-profile.service.js";

/**
 * Inverse of handleUserDeleted. Nothing here mirrors that handler's
 * `forceEndStreamsByCreator` side effect: ending a live broadcast has no
 * inverse (a stream that was force-ended stays ended), and the restored user
 * can simply go live again.
 */
export async function handleUserRestored(
  data: UserRestoredPayload
): Promise<void> {
  await userProfileService.restoreFromUserRestoredEvent(data);
}
