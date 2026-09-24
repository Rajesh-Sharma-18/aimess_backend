/**
 * Group @mention copy. The push copy (mention / mentionAll) never reaches the
 * inbox; mentionInbox is the Notification-Center row. All are registered
 * builders, so each must be named in COPY_PARAM_NAMES and render in every
 * supported language.
 */
import { COPY_PARAM_NAMES, MESSAGES } from "@aimess/constants";
import {
  chatCopy,
  chatMentionAllPreviewHiddenBody,
  chatMentionPreviewHiddenBody,
  renderNotificationCopy,
} from "../../src/lib/notification-copy.js";

describe("chat mention inbox copy", () => {
  it("is named in COPY_PARAM_NAMES", () => {
    expect(COPY_PARAM_NAMES["chat.mentionInbox"]).toEqual(["params"]);
  });

  it("has vi/en/th for both inbox keys", () => {
    for (const key of [
      "NOTIF_CHAT_MENTION_INBOX_BODY",
      "NOTIF_CHAT_MENTION_INBOX_BODY_NO_GROUP",
    ] as const) {
      const entry = MESSAGES[key];
      expect(entry.vi).toBeTruthy();
      expect(entry.en).toBeTruthy();
      expect(entry.th).toBeTruthy();
    }
  });

  it("renders in all three locales, titled on the group", () => {
    const copy = chatCopy.mentionInbox({
      senderName: "Ana",
      groupName: "Weekend Trip",
    });
    expect(copy("en")).toEqual({
      title: "Weekend Trip",
      body: "Ana mentioned you in Weekend Trip",
    });
    expect(copy("vi")).toEqual({
      title: "Weekend Trip",
      body: "Ana đã nhắc đến bạn trong Weekend Trip",
    });
    expect(copy("th")).toEqual({
      title: "Weekend Trip",
      body: "Ana กล่าวถึงคุณในWeekend Trip",
    });
  });

  it("falls back to 'New message' and the no-group body", () => {
    const copy = chatCopy.mentionInbox({ senderName: "Ana" });
    expect(copy("en")).toEqual({
      title: "New message",
      body: "Ana mentioned you",
    });
    expect(copy("vi").body).toBe("Ana đã nhắc đến bạn");
    expect(copy("th").body).toBe("Ana กล่าวถึงคุณ");
  });

  it("replays from its stored ticket in another language", () => {
    const copy = chatCopy.mentionInbox({
      senderName: "Ana",
      groupName: "Weekend Trip",
    });
    expect(
      renderNotificationCopy(JSON.stringify(copy.descriptor), "vi")?.body
    ).toBe("Ana đã nhắc đến bạn trong Weekend Trip");
  });
});

describe("chat @all mention inbox copy", () => {
  it("has vi/en/th for both @all inbox keys", () => {
    for (const key of [
      "NOTIF_CHAT_MENTION_ALL_INBOX_BODY",
      "NOTIF_CHAT_MENTION_ALL_INBOX_BODY_NO_GROUP",
    ] as const) {
      const entry = MESSAGES[key];
      expect(entry.vi).toBeTruthy();
      expect(entry.en).toBeTruthy();
      expect(entry.th).toBeTruthy();
    }
  });

  it("says @all, never 'you', in all three locales", () => {
    const copy = chatCopy.mentionInbox({
      senderName: "Ana",
      groupName: "Weekend Trip",
      all: true,
    });
    expect(copy("en")).toEqual({
      title: "Weekend Trip",
      body: "Ana mentioned @all in Weekend Trip",
    });
    expect(copy("vi").body).toBe("Ana đã nhắc đến @all trong Weekend Trip");
    expect(copy("th").body).toBe("Ana กล่าวถึง @all ในWeekend Trip");
    for (const locale of ["en", "vi", "th"] as const) {
      expect(copy(locale).body).not.toBe(
        chatCopy.mentionInbox({
          senderName: "Ana",
          groupName: "Weekend Trip",
        })(locale).body
      );
    }
  });

  it("falls back to the no-group body", () => {
    const copy = chatCopy.mentionInbox({ senderName: "Ana", all: true });
    expect(copy("en")).toEqual({
      title: "New message",
      body: "Ana mentioned @all",
    });
    expect(copy("vi").body).toBe("Ana đã nhắc đến @all");
    expect(copy("th").body).toBe("Ana กล่าวถึง @all");
  });

  it("replays from its stored ticket in another language", () => {
    const copy = chatCopy.mentionInbox({
      senderName: "Ana",
      groupName: "Weekend Trip",
      all: true,
    });
    expect(
      renderNotificationCopy(JSON.stringify(copy.descriptor), "vi")?.body
    ).toBe("Ana đã nhắc đến @all trong Weekend Trip");
  });

  // Rows written before the split have no `all` in their ticket, but every
  // chat.mention row has always carried `data.mentionType`.
  it("renders a historical @all row from data.mentionType", () => {
    const legacy = JSON.stringify({
      ref: "chat.mentionInbox",
      args: [{ senderName: "Ana", groupName: "Weekend Trip" }],
    });
    expect(
      renderNotificationCopy(legacy, "en", { mentionType: "ALL" })?.body
    ).toBe("Ana mentioned @all in Weekend Trip");
    expect(
      renderNotificationCopy(legacy, "en", { mentionType: "USER" })?.body
    ).toBe("Ana mentioned you in Weekend Trip");
    // No metadata at all: keep the old sentence rather than guess.
    expect(renderNotificationCopy(legacy, "en")?.body).toBe(
      "Ana mentioned you in Weekend Trip"
    );
  });

  it("never overrides a ticket that already decided", () => {
    const stored = JSON.stringify(
      chatCopy.mentionInbox({ senderName: "Ana", all: false }).descriptor
    );
    expect(
      renderNotificationCopy(stored, "en", { mentionType: "ALL" })?.body
    ).toBe("Ana mentioned you");
  });
});

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

describe("chat @all copy", () => {
  it("is named in COPY_PARAM_NAMES", () => {
    expect(COPY_PARAM_NAMES["chat.mentionAll"]).toEqual(["params"]);
  });

  it("has vi/en/th for every @all key", () => {
    for (const key of [
      "NOTIF_CHAT_MENTION_ALL_BODY",
      "NOTIF_CHAT_MENTION_ALL_BODY_NO_PREVIEW",
      "NOTIF_CHAT_MENTION_ALL_HIDDEN_IN",
      "NOTIF_CHAT_MENTION_ALL_HIDDEN",
    ] as const) {
      const entry = MESSAGES[key];
      expect(entry.vi).toBeTruthy();
      expect(entry.en).toBeTruthy();
      expect(entry.th).toBeTruthy();
    }
  });

  it("renders in all three locales, with the no-preview fallback", () => {
    const copy = chatCopy.mentionAll({
      groupName: "Weekend Trip",
      senderName: "Ana",
      preview: "standup @all",
      messageType: "TEXT",
    });
    expect(copy("en")).toEqual({
      title: "Weekend Trip",
      body: "Ana mentioned @all: standup @all",
    });
    expect(copy("vi").body).toBe("Ana đã nhắc đến @all: standup @all");
    expect(copy("th").body).toBe("Ana กล่าวถึง @all: standup @all");
    expect(chatCopy.mentionAll({ senderName: "Ana" })("en")).toEqual({
      title: "New message",
      body: "Ana mentioned @all",
    });
  });

  it("preview-hidden body says everyone was mentioned", () => {
    expect(chatMentionAllPreviewHiddenBody("Weekend Trip", "en")).toBe(
      "Everyone was mentioned in Weekend Trip"
    );
    expect(chatMentionAllPreviewHiddenBody(undefined, "vi")).toBe(
      "Mọi người được nhắc đến"
    );
    expect(chatMentionAllPreviewHiddenBody(undefined, "th")).toBe(
      "มีการกล่าวถึงทุกคน"
    );
  });
});
