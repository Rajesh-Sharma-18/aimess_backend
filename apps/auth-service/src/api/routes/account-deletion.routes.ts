import { Router, type IRouter } from "express";

import { deleteAccount } from "../controllers/account-deletion.controller.js";
import { validateBody } from "../middleware/validate-body.js";
import { authenticateAccessToken } from "../../middleware/authenticate-access-token.js";
import { deleteAccountSchema } from "../validators/account-deletion.validator.js";

export const accountDeletionRoutes: IRouter = Router();

// DELIBERATELY UNTHROTTLED. This endpoint used to sit behind
// `deleteAccountRateLimiter` (5 attempts/hour/user); it was removed on request
// on 2026-08-12 because it kept locking real users out of their own delete
// dialog. Every OTHER limiter in this service is unchanged — in particular
// `changePasswordRateLimiter` still guards the other password-verifying
// endpoint.
//
// Understand what this costs before re-tuning it: the handler compares a
// caller-supplied password against `auth_users.passwordHash`, so with no
// limiter here, anyone holding a stolen access token can guess that password at
// request speed and confirm a hit from the 200-vs-400. In production the
// gateway's global per-IP limiter is the only thing left in front of it (and it
// is skipped entirely when NODE_ENV=development). If that trade stops being
// acceptable, re-add a per-user limiter AFTER `validateBody` with a
// `skip: (req) => !req.body?.password` so empty submissions cannot burn the
// budget — that ordering was the original lockout bug.
accountDeletionRoutes.delete(
  "/account",
  authenticateAccessToken,
  validateBody(deleteAccountSchema),
  deleteAccount
);
