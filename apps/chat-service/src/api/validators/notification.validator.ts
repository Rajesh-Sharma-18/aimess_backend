import { z } from "zod";

export const getNotificationsSchema = z.object({
  cursor: z.string().nullish(),
  limit: z.coerce.number().min(1).max(100).default(20),
});

export const markReadSchema = z.object({
  notificationId: z.string().min(5).max(100),
});
