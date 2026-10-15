import {
  createGroupSchema,
  updateGroupSchema,
} from "../../src/api/validators/group-room.validator.js";
import { reportGroupMessageSchema } from "../../src/api/validators/group-message.validator.js";
import { reportMessageSchema } from "../../src/api/validators/community.validator.js";
import { reportUserReasonSchema } from "../../src/lib/report-user.js";
import { CommunityMessageService } from "../../src/services/community-message.service.js";
import { GroupMessageService } from "../../src/services/group-message.service.js";
import { PrivateMessageService } from "../../src/services/private-message.service.js";

const BLANKS = [
  "   ",
  "\t\n\r",
  "​​",
  "⠀",
  "ㅤﾠ",
  "﻿‌‍",
  " ​\t⠀　 ",
];

describe("group name", () => {
  it.each(BLANKS)("rejects visually blank %j on create and rename", (name) => {
    expect(createGroupSchema.safeParse({ name }).success).toBe(false);
    expect(updateGroupSchema.safeParse({ name }).success).toBe(false);
  });

  it("strips invisible padding and keeps international names", () => {
    const parsed = createGroupSchema.parse({ name: "​⠀ทีมงาน 👨‍👩‍👧ㅤ " });
    expect(parsed.name).toBe("ทีมงาน 👨‍👩‍👧");
  });

  it("collapses a visually blank description to empty", () => {
    expect(createGroupSchema.parse({ name: "Team", description: "​ ⠀" }).description).toBe("");
    expect(updateGroupSchema.parse({ description: " notes​ " }).description).toBe("notes");
  });
});

describe("report reasons", () => {
  it.each(BLANKS)("rejects visually blank reason %j", (reason) => {
    expect(reportGroupMessageSchema.safeParse({ reportReason: reason }).success).toBe(false);
    expect(
      reportMessageSchema.safeParse({
        roomId: "r".repeat(24),
        messageId: "m".repeat(24),
        reportReason: reason,
      }).success
    ).toBe(false);
    expect(reportUserReasonSchema.safeParse(reason).success).toBe(false);
  });

  it("accepts a real reason", () => {
    expect(reportGroupMessageSchema.safeParse({ reportReason: "SPAM" }).success).toBe(true);
    expect(reportUserReasonSchema.safeParse(" spam ").success).toBe(true);
  });

  it("rejects a reason padded to the minimum with invisible characters", () => {
    expect(reportUserReasonSchema.safeParse("ab​​").success).toBe(false);
  });
});

describe("blank TEXT sends are rejected on every send path", () => {
  const privateService = Object.create(PrivateMessageService.prototype) as PrivateMessageService;
  const groupService = Object.create(GroupMessageService.prototype) as GroupMessageService;
  const communityService = Object.create(CommunityMessageService.prototype) as CommunityMessageService;

  it.each(BLANKS)("private %j", async (text) => {
    await expect(
      privateService.sendMessage({
        roomId: "room",
        senderId: "user",
        messageType: "TEXT",
        content: { text },
      } as never)
    ).rejects.toMatchObject({ messageKey: "CHAT_TEXT_REQUIRED" });
  });

  it.each(BLANKS)("group %j", async (text) => {
    await expect(
      groupService.sendMessage({
        roomId: "room",
        senderId: "user",
        messageType: "TEXT",
        content: { text },
      } as never)
    ).rejects.toMatchObject({ messageKey: "CHAT_TEXT_REQUIRED" });
  });

  it.each(BLANKS)("community %j", async (message) => {
    await expect(
      communityService.sendMessage({
        roomId: "room",
        sentBy: "user",
        senderName: "John",
        senderAvatar: "",
        messageType: "text",
        message,
      } as never)
    ).rejects.toMatchObject({ messageKey: "CHAT_TEXT_REQUIRED" });
  });
});
