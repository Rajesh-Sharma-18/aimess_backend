import { z } from "zod";

export const getNotificationsSchema = z.object({
  cursor: z.string().nullish(),
  limit: z.coerce.number().min(1).max(100).default(20),
});

export const markReadSchema = z.union([
  z.object({ notificationId: z.string().min(5).max(100) }),
  z.object({
    notificationIds: z.array(z.string().min(5).max(100)).min(1).max(500),
  }),
]);
