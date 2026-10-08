import { Router, type NextFunction, type Request, type Response } from "express";
import type { z } from "zod";

import { authenticate } from "../../middleware/authenticate.js";
import { validateBody } from "../middleware/validate-body.js";
import {
  assertSendAllowed,
  type MessagingScope,
} from "../../middleware/rate-limit.js";
import { forwardMessagesSchema } from "../validators/forward.validator.js";
import type { ForwardController } from "../controllers/forward.controller.js";

const SCOPE: Record<string, MessagingScope> = {
  PRIVATE: "pm",
  GROUP: "gm",
  COMMUNITY: "cm",
};

// Each target is a send into that conversation: charge its own bucket, one token per message.
// ponytail: targets already charged stay charged if a later one is refused.
async function forwardLimit(req: Request, _res: Response, next: NextFunction) {
  const userId = (req as unknown as { auth: { userId: string } }).auth.userId;
  for (const t of (req.body as z.infer<typeof forwardMessagesSchema>).targets) {
    await assertSendAllowed(
      SCOPE[t.conversationType],
      userId,
      t.roomId,
      t.clientMessageIds.length
    );
  }
  next();
}

export function createForwardRoutes(ctrl: ForwardController): Router {
  const router = Router();
  router.post(
    "/",
    authenticate,
    validateBody(forwardMessagesSchema),
    forwardLimit,
    ctrl.forward
  );
  return router;
}
