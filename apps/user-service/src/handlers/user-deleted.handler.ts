import type { UserDeletedPayload } from "@aimess/shared-types";
import { userProfileService } from "../services/user-profile.service.js";

export async function handleUserDeleted(
  data: UserDeletedPayload
): Promise<void> {
  await userProfileService.softDeleteFromUserDeletedEvent(data);
}
