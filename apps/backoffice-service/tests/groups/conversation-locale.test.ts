/**
 * The read-only conversation viewers: chat-service rebuilds every SYSTEM line on
 * read, with no viewer (so an admin reads the factual actor, never "You …"), in
 * the `x-lang` of the gRPC call. These pin that the admin's language is what
 * rides that call, and that the viewer rows carry the group's ordering sequence.
 */
jest.mock("../../src/grpc/chat.client.js", () => ({
  chatClient: {
    adminGetGroupMessages: jest.fn(),
    adminGetCommunityMessages: jest.fn(),
  },
}));

import { currentLocale } from "@aimess/constants";

import { chatClient } from "../../src/grpc/chat.client.js";
import { communityService } from "../../src/services/community.service.js";
import { groupService } from "../../src/services/group.service.js";

const client = chatClient as unknown as Record<string, jest.Mock>;
const EMPTY_PAGE = {
  messages: [],
  nextCursor: "",
  hasMore: false,
  newerCursor: "",
  hasMoreNewer: false,
  pinnedMessageJson: "",
};

describe("conversation reads carry the admin's language to chat-service", () => {
  it.each(["vi", "th", "en"] as const)(
    "group read runs in %s",
    async (locale) => {
      let seen = "";
      client.adminGetGroupMessages.mockImplementation(async () => {
        seen = currentLocale();
        return EMPTY_PAGE;
      });
      await groupService.getConversationMessages("grp_1", { limit: 30 }, locale);
      expect(seen).toBe(locale);
    }
  );

  it.each(["vi", "th"] as const)("community read runs in %s", async (locale) => {
    let seen = "";
    client.adminGetCommunityMessages.mockImplementation(async () => {
      seen = currentLocale();
      return EMPTY_PAGE;
    });
    await communityService.getConversationMessages(
      "com_1",
      { limit: 30 },
      locale
    );
    expect(seen).toBe(locale);
  });

  it("passes the system text through as rendered and keeps the sequence", async () => {
    client.adminGetGroupMessages.mockResolvedValue({
      ...EMPTY_PAGE,
      messages: [
        {
          messageId: "m1",
          senderId: "",
          senderName: "",
          senderAvatar: "",
          message: "Smiley Creatures created the group",
          contentType: "SYSTEM",
          attachmentsJson: "[]",
          reactionsJson: "[]",
          quoteDataJson: "",
          mentionsJson: "[]",
          sentAt: "1787138497261",
          sequenceNumber: "1",
          systemMessageType: "GROUP_CREATED",
          systemMetadata: "{}",
          isDeleted: false,
        },
      ],
    });
    const page = await groupService.getConversationMessages(
      "grp_1",
      { limit: 30 },
      "en"
    );
    expect(page.messages[0]).toMatchObject({
      message: "Smiley Creatures created the group",
      systemMessageType: "GROUP_CREATED",
      sequenceNumber: 1,
      sentAt: 1787138497261,
    });
  });
});
