import { z } from "zod";

export const deleteAccountSchema = z
  .object({
    // Optional at the schema level, and deliberately WITHOUT a `.min(1)`: the
    // service is the single authority on whether a password is required (only
    // accounts that actually have one — social-only accounts can skip it). A
    // `.min(1)` here rejected `password: ""` with a bare zod string and no
    // error `code`, while a missing password reached the service and came back
    // as a coded `AUTH_PASSWORD_REQUIRED` — two different response shapes for
    // one user mistake, which the client cannot map to a single in-modal
    // message. Empty string is falsy, so it lands on the same coded error.
    password: z.string().optional(),
  })
  // Express 5 leaves `req.body` undefined when the request carries no body at
  // all — legitimate for a social-only account that has no password to send.
  // Without this the schema would reject it outright with a 400.
  .default({});

export type DeleteAccountInput = z.infer<typeof deleteAccountSchema>;
