import { z } from "zod";

import { isObjectId } from "../../lib/object-id.js";

const conversationType = z.enum(["PRIVATE", "GROUP", "COMMUNITY"]);
const CLIENT_MESSAGE_ID_RE =
  /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;

export const forwardMessagesSchema = z
  .object({
    sources: z
      .array(
        z.object({
          messageId: z.string().refine(isObjectId, "Invalid message id"),
          conversationType,
        })
      )
      .min(1)
      .max(50),
    targets: z
      .array(
        z.object({
          conversationType,
          roomId: z.string().min(4).max(150),
          clientMessageIds: z
            .array(z.string().regex(CLIENT_MESSAGE_ID_RE))
            .min(1)
            .max(50),
        })
      )
      .min(1)
      .max(20),
  })
  .superRefine((val, ctx) => {
    const ids = val.sources.map((s) => s.messageId.toLowerCase());
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({
        code: "custom",
        path: ["sources"],
        message: "Duplicate source messageId",
      });
    }
    const rooms = val.targets.map((t) => t.roomId);
    if (new Set(rooms).size !== rooms.length) {
      ctx.addIssue({
        code: "custom",
        path: ["targets"],
        message: "Duplicate target roomId",
      });
    }
    val.targets.forEach((t, i) => {
      if (t.clientMessageIds.length !== val.sources.length) {
        ctx.addIssue({
          code: "custom",
          path: ["targets", i, "clientMessageIds"],
          message: "clientMessageIds must have one id per source",
        });
      }
      const upper = t.clientMessageIds.map((id) => id.toUpperCase());
      if (new Set(upper).size !== upper.length) {
        ctx.addIssue({
          code: "custom",
          path: ["targets", i, "clientMessageIds"],
          message: "Duplicate clientMessageId",
        });
      }
    });
  });
