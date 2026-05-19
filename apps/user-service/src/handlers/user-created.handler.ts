import type { UserCreatedPayload } from "@aimess/shared-types";
import { userProfileService } from "../services/user-profile.service.js";

export async function handleUserCreated(
  data: UserCreatedPayload
): Promise<void> {
  await userProfileService.createFromUserCreatedEvent(data);
}
