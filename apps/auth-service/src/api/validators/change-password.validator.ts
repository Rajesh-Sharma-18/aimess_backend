import { z } from "zod";

import { existingPasswordSchema, passwordSchema } from "./auth.validator.js";

export const changePasswordSchema = z.object({
  /**
   * The password the account HAS, so it is validated permissively.
   *
   * Applying the creation policy here would lock an account created under the
   * older 8-character rule out of changing its password — the one action that
   * would bring it into compliance. Whether the value is correct is bcrypt's
   * job, not the schema's.
   */
  currentPassword: existingPasswordSchema,
  /** The password the account is MOVING TO: full creation policy applies. */
  newPassword: passwordSchema,
});

export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
