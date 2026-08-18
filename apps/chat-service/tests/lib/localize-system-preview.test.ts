/**
 * The REST half of list-preview localization. The live `conv:updated` bump is
 * localized at the gateway; if the read path did not do the same rebuild, the
 * row would flip back to the write-time English on the next refresh.
 */
import { runWithLocale, t } from "@aimess/constants";

import {
  localizedActivityPreview,
  withLocalizedSystemPreview,
} from "../../src/lib/localize-system-preview.js";

const GROUP_SNAPSHOT = {
  messageType: "SYSTEM",
  text: "Alex removed Jim",
  systemEvent: "MEMBER_REMOVED",
  systemData: {
    actorId: "admin-1",
    actorName: "Alex",
    targetUserId: "target-1",
    targetName: "Jim",
  },
};

// `content.text` rather than a top-level `text` — the private snapshot's shape.
const PRIVATE_SNAPSHOT = {
  messageType: "SYSTEM",
  content: { text: "Alice pinned a message" },
  systemEvent: "MESSAGE_PINNED",
  systemData: { actorId: "member-1", actorName: "Alice" },
};

const textOf = (row: unknown) => (row as { text: string }).text;

describe("withLocalizedSystemPreview", () => {
  it("renders the group row in the reader's language", () => {
    expect(
      textOf(withLocalizedSystemPreview(GROUP_SNAPSHOT, "GROUP", "x", "en"))
    ).toBe("Alex removed Jim");
    expect(
      textOf(withLocalizedSystemPreview(GROUP_SNAPSHOT, "GROUP", "x", "vi"))
    ).toBe("Alex đã xóa Jim");
    expect(
      textOf(withLocalizedSystemPreview(GROUP_SNAPSHOT, "GROUP", "x", "th"))
    ).toBe("AlexนำJimออกจากกลุ่ม");
  });

  it("gives the subject their first-person row, translated", () => {
    expect(
      textOf(
        withLocalizedSystemPreview(GROUP_SNAPSHOT, "GROUP", "target-1", "th")
      )
    ).toBe(t("SYS_GROUP_MEMBER_REMOVED_SELF", "th"));
  });

  it("never translates interpolated names", () => {
    const th = textOf(
      withLocalizedSystemPreview(GROUP_SNAPSHOT, "GROUP", "x", "th")
    );
    expect(th).toContain("Alex");
    expect(th).toContain("Jim");
  });

  it("rewrites the private snapshot's nested content.text", () => {
    const row = withLocalizedSystemPreview(
      PRIVATE_SNAPSHOT,
      "PRIVATE",
      "member-1",
      "en"
    ) as { content: { text: string } };
    expect(row.content.text).toBe("You pinned a message");
  });

  it("defaults to the ambient request locale, so REST follows x-lang", () => {
    const rendered = runWithLocale("th", () =>
      textOf(withLocalizedSystemPreview(GROUP_SNAPSHOT, "GROUP", "x"))
    );
    expect(rendered).toBe("AlexนำJimออกจากกลุ่ม");
  });

  it("keeps a legacy snapshot (no systemEvent) byte-identical", () => {
    const legacy = { messageType: "SYSTEM", text: "Alex removed Jim" };
    expect(withLocalizedSystemPreview(legacy, "GROUP", "x", "th")).toBe(legacy);
  });

  it("leaves an ordinary message preview alone", () => {
    const chat = { messageType: "TEXT", text: "sawadee" };
    expect(withLocalizedSystemPreview(chat, "PRIVATE", "x", "th")).toBe(chat);
  });

  it("passes null/undefined straight through", () => {
    expect(withLocalizedSystemPreview(null, "GROUP", "x", "th")).toBeNull();
    expect(
      withLocalizedSystemPreview(undefined, "GROUP", "x", "th")
    ).toBeUndefined();
  });
});

describe("localizedActivityPreview", () => {
  it("translates the normalized activity line from the same snapshot", () => {
    expect(
      localizedActivityPreview(
        "Alex removed Jim",
        {
          messageType: "SYSTEM",
          systemEvent: "MEMBER_REMOVED",
          systemData: GROUP_SNAPSHOT.systemData,
        },
        "GROUP",
        "x",
        "vi"
      )
    ).toBe("Alex đã xóa Jim");
  });

  it("returns the preview unchanged when there is no snapshot to rebuild from", () => {
    expect(
      localizedActivityPreview("Alex removed Jim", null, "GROUP", "x", "th")
    ).toBe("Alex removed Jim");
  });
});
