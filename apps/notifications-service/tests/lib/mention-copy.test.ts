/**
 * Group @mention push copy. Chat copy is push-only (no inbox row), but it is
 * still a registered builder, so it must be named in COPY_PARAM_NAMES and
 * render in every supported language.
 */
import { COPY_PARAM_NAMES, MESSAGES } from "@aimess/constants";
import {
  chatCopy,
  chatMentionPreviewHiddenBody,
} from "../../src/lib/notification-copy.js";

describe("chat mention copy", () => {
  it("is named in COPY_PARAM_NAMES", () => {
    expect(COPY_PARAM_NAMES["chat.mention"]).toEqual(["params"]);
  });

  it("has vi/en/th for every mention key", () => {
    for (const key of [
      "NOTIF_CHAT_MENTION_BODY",
      "NOTIF_CHAT_MENTION_BODY_NO_PREVIEW",
      "NOTIF_CHAT_MENTION_HIDDEN_IN",
      "NOTIF_CHAT_MENTION_HIDDEN",
    ] as const) {
      const entry = MESSAGES[key];
      expect(entry.vi).toBeTruthy();
      expect(entry.en).toBeTruthy();
      expect(entry.th).toBeTruthy();
    }
  });

  it("renders in all three locales, titled on the group", () => {
    const copy = chatCopy.mention({
      groupName: "Weekend Trip",
      senderName: "Ana",
      preview: "hi @kristi",
      messageType: "TEXT",
    });
    expect(copy("en")).toEqual({
      title: "Weekend Trip",
      body: "Ana mentioned you: hi @kristi",
    });
    expect(copy("vi")).toEqual({
      title: "Weekend Trip",
      body: "Ana đã nhắc đến bạn: hi @kristi",
    });
    expect(copy("th")).toEqual({
      title: "Weekend Trip",
      body: "Ana กล่าวถึงคุณ: hi @kristi",
    });
  });

  it("falls back to 'New message' title and the no-preview body", () => {
    const copy = chatCopy.mention({ senderName: "Ana" });
    expect(copy("en")).toEqual({
      title: "New message",
      body: "Ana mentioned you",
    });
    expect(copy("vi").body).toBe("Ana đã nhắc đến bạn");
    expect(copy("th").body).toBe("Ana กล่าวถึงคุณ");
  });

  it("preview-hidden body still says it was a mention", () => {
    expect(chatMentionPreviewHiddenBody("Weekend Trip", "en")).toBe(
      "You were mentioned in Weekend Trip"
    );
    expect(chatMentionPreviewHiddenBody("Weekend Trip", "vi")).toBe(
      "Bạn được nhắc đến trong Weekend Trip"
    );
    expect(chatMentionPreviewHiddenBody("Weekend Trip", "th")).toBe(
      "มีคนกล่าวถึงคุณในWeekend Trip"
    );
    expect(chatMentionPreviewHiddenBody(undefined, "en")).toBe(
      "You were mentioned"
    );
  });
});
