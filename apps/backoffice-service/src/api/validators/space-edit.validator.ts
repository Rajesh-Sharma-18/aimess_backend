import {
  countCharacters,
  TEXT_NAME_MAX_LENGTH,
  TEXT_NAME_MAX_RAW_LENGTH,
} from "@aimess/constants";
import { z } from "zod";

export {
  userAvatarUploadUrlSchema as avatarUploadUrlSchema,
  type UserAvatarUploadUrlInput as AvatarUploadUrlInput,
} from "./user-account.validator.js";

// Same rules as the app's own edit endpoints (community-service
// updateCommunitySchema, chat-service updateGroupSchema), so the panel can
// never save a value the app would reject.

const nameSchema = (minLength: number, minMessage: string, maxKey: string) =>
  z
    .string()
    .trim()
    .min(minLength, minMessage)
    .max(TEXT_NAME_MAX_RAW_LENGTH, maxKey)
    .refine((v) => countCharacters(v) <= TEXT_NAME_MAX_LENGTH, maxKey);

const noChanges = (body: object) => Object.keys(body).length > 0;

export const updateCommunitySchema = z
  .object({
    name: nameSchema(
      3,
      "Community name must be at least 3 characters",
      "VALIDATION_COMMUNITY_NAME_MAX_LENGTH"
    ).optional(),
    description: z
      .string()
      .trim()
      .max(500, "Description must be at most 500 characters")
      .nullable()
      .optional(),
    categoryId: z
      .string()
      .trim()
      .regex(/^[a-f\d]{24}$/i, "Category is invalid")
      .optional(),
    type: z.enum(["PUBLIC", "PRIVATE"]).optional(),
    // Key from POST /communities/:communityId/avatar/upload-url.
    avatarObjectKey: z.string().trim().min(1).max(512).optional(),
  })
  .strict()
  .refine(noChanges, { message: "ADMIN_USER_NO_CHANGES" });
export type UpdateCommunityInput = z.infer<typeof updateCommunitySchema>;

export const updateGroupSchema = z
  .object({
    name: nameSchema(
      1,
      "Group name is required",
      "VALIDATION_GROUP_NAME_MAX_LENGTH"
    ).optional(),
    description: z.string().trim().max(1000).optional(),
    // true = private: invite-link joins become admin-approved requests.
    joinApproval: z.boolean().optional(),
    // Key from POST /groups/:groupId/avatar/upload-url.
    avatarObjectKey: z.string().trim().min(1).max(512).optional(),
  })
  .strict()
  .refine(noChanges, { message: "ADMIN_USER_NO_CHANGES" });
export type UpdateGroupInput = z.infer<typeof updateGroupSchema>;
