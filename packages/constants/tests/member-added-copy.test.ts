import { PLATFORM_ADMIN_ACTOR_ID, SYSTEM_ACTOR_ID } from "../src/member-change-text.js";
import { buildCommunitySystemFallbackText } from "../src/community/system-message-text.js";
import {
  communityCopy,
  describeCopyTicket,
  groupCopy,
  renderNotificationCopy,
  type LocalizedCopy,
} from "../src/notification-copy.js";

/**
 * Member-added copy names who added whom, and renders the READER's own side as
 * "You". The ticket stores ids + names only, so the same stored row reads
 * correctly for the target, the actor and a third-party moderator — live, after
 * a refresh (replay), and on every device of the same account.
 */
const JOHN = "u-john";
const TOM = "u-tom";
const MOD = "u-sarah";

const ticket = (copy: LocalizedCopy): string => JSON.stringify(copy.descriptor);

describe("member-added copy", () => {
  const community = communityCopy.memberAdded(
    "Gokuldham Society",
    "John Smith",
    "Tom Brown",
    JOHN,
    TOM
  );
  const group = groupCopy.memberAdded(
    "Weekend Trip",
    "Kristi Noem",
    "Boyd Stevens",
    "u-kristi",
    "u-boyd"
  );

  it("community: target, actor and third viewer each read their own sentence", () => {
    expect(community("en", TOM).body).toBe(
      "John Smith added You to Gokuldham Society"
    );
    expect(community("en", JOHN).body).toBe(
      "You added Tom Brown to Gokuldham Society"
    );
    const kicked = communityCopy.memberKicked(
      "C",
      "John Smith",
      "Tom Brown",
      JOHN,
      TOM
    );
    expect(kicked("en", MOD).body).toBe("John Smith removed Tom Brown from C");
  });

  it("group: same rule", () => {
    expect(group("en", "u-boyd").body).toBe(
      "Kristi Noem added You to Weekend Trip"
    );
    expect(group("en", "u-kristi").body).toBe(
      "You added Boyd Stevens to Weekend Trip"
    );
    expect(group("en", MOD).body).toBe(
      "Kristi Noem added Boyd Stevens to Weekend Trip"
    );
  });

  it("moderator copy uses the same sentence (third person for a moderator)", () => {
    const mods = communityCopy.memberAddedForModerators(
      "Gokuldham Society",
      "Sarah Jones",
      "Tom Brown",
      MOD,
      TOM
    );
    expect(mods("en", "u-admin").body).toBe(
      "Sarah Jones added Tom Brown to Gokuldham Society"
    );
  });

  it("replay from the stored ticket (refresh/history/socket) matches the live render", () => {
    for (const viewer of [TOM, JOHN, MOD]) {
      expect(
        renderNotificationCopy(ticket(community), "en", undefined, viewer)?.body
      ).toBe(community("en", viewer).body);
    }
  });

  it("ticket stores no rendered 'You' — only ids and names", () => {
    const raw = ticket(community);
    expect(raw).not.toMatch(/\bYou\b/);
    expect(describeCopyTicket(raw)?.params).toEqual({
      communityName: "Gokuldham Society",
      actorName: "John Smith",
      targetName: "Tom Brown",
      actorId: JOHN,
      targetUserId: TOM,
    });
  });

  it("missing names fall back to the localized 'Someone', never undefined/null", () => {
    const copy = communityCopy.memberAdded("C", "", null, JOHN, TOM);
    expect(copy("en", MOD).body).toBe("Someone added Someone to C");
    expect(copy("en", TOM).body).toBe("Someone added You to C");
  });

  it("localizes in vi and th", () => {
    expect(community("vi", TOM).body).toBe(
      "John Smith đã thêm Bạn vào Gokuldham Society"
    );
    expect(community("th", TOM).body).toBe(
      "John Smithเพิ่มคุณเข้าGokuldham Society"
    );
  });

  it("legacy tickets (entity name only) keep their original sentence", () => {
    const legacyCommunity = JSON.stringify({
      ref: "community.memberAdded",
      args: ["Gokuldham Society"],
    });
    const legacyGroup = JSON.stringify({
      ref: "group.memberAdded",
      args: ["Weekend Trip"],
    });
    const legacyMods = JSON.stringify({
      ref: "community.memberAddedForModerators",
      args: ["Gokuldham Society"],
    });
    expect(
      renderNotificationCopy(legacyCommunity, "en", undefined, TOM)?.body
    ).toBe("You were added to Gokuldham Society");
    expect(
      renderNotificationCopy(legacyGroup, "en", undefined, TOM)?.body
    ).toBe("You were added to the group");
    expect(renderNotificationCopy(legacyMods, "en", undefined, MOD)?.body).toBe(
      "A new member joined Gokuldham Society"
    );
  });
});

describe("Super Admin (Backoffice) actor reads 'Administrator'", () => {
  it("community removal push/inbox: target reads 'Administrator removed You from …'", () => {
    for (const actorId of [PLATFORM_ADMIN_ACTOR_ID, SYSTEM_ACTOR_ID /* legacy rows */]) {
      const copy = communityCopy.memberKicked(
        "Mission AIMess",
        "",
        "Tom Brown",
        actorId,
        TOM
      );
      expect(copy("en", TOM).body).toBe(
        "Administrator removed You from Mission AIMess"
      );
      expect(copy("vi", TOM).body).toBe(
        "Quản trị viên đã xóa Bạn khỏi Mission AIMess"
      );
      expect(copy("th", TOM).body).toBe("ผู้ดูแลระบบนำคุณออกจากMission AIMess");
      // Replayed from the stored ticket (refresh / history / socket): same text.
      expect(
        renderNotificationCopy(ticket(copy), "en", undefined, TOM)?.body
      ).toBe("Administrator removed You from Mission AIMess");
    }
  });

  // No Backoffice path adds members; SYSTEM_ACTOR_ID stays the automated actor.
  it("an automated (SYSTEM_ACTOR_ID) add still reads 'System added …'", () => {
    const copy = communityCopy.memberAdded(
      "C",
      "",
      "Tom Brown",
      SYSTEM_ACTOR_ID,
      TOM
    );
    expect(copy("en", TOM).body).toBe("System added You to C");
    expect(copy("en", MOD).body).toBe("System added Tom Brown to C");
    expect(
      buildCommunitySystemFallbackText(
        "MEMBER_ADDED",
        {
          actorUserId: SYSTEM_ACTOR_ID,
          targetUserId: TOM,
          targetName: "Tom Brown",
          communityName: "C",
        },
        "",
        "Tom Brown",
        MOD
      )
    ).toBe("System added Tom Brown to C");
  });

  it("a real user's name is never replaced by 'System'", () => {
    const kicked = communityCopy.memberKicked(
      "C",
      "John Smith",
      "Tom Brown",
      JOHN,
      TOM
    );
    expect(kicked("en", MOD).body).toBe("John Smith removed Tom Brown from C");
  });
});
