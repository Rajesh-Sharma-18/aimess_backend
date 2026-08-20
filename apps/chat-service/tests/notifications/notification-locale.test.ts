/**
 * A notification row must read in the language the user is using RIGHT NOW —
 * not the one they were using when it was created.
 *
 * The bug this guards: a notification persists its rendered sentence, so a call
 * that arrived while the app was Vietnamese stayed "Cuộc gọi thoại nhỡ" forever,
 * including after the user switched back to English. The row now also carries a
 * replay ticket (`data.copyRef`) — the copy builder plus its arguments — and the
 * serializer rebuilds the sentence per read.
 *
 * Two invariants are asserted throughout:
 *   1. the SYSTEM sentence follows the reader's locale,
 *   2. the identity inside it (a person's name) never does.
 */
import {
  callCopy,
  friendCopy,
  resolutionCopy,
  runWithLocale,
  t,
} from "@aimess/constants";

import type { Notification } from "../../src/generated/prisma/index.js";
import { serializeNotification } from "../../src/lib/notification-serializer.js";

const CALLER = "Mohit Vasundhara";

function row(over: Partial<Notification> & { payload: unknown }): Notification {
  return {
    id: "n1",
    userId: "viewer-1",
    actorId: "peer-1",
    entity: {},
    actorSnapshot: {},
    isRead: false,
    readAt: null,
    isDeleted: false,
    deletedAt: null,
    createdAt: new Date("2026-08-20T10:00:00Z"),
    updatedAt: new Date("2026-08-20T10:00:00Z"),
    loginSessionId: null,
    loginExpiresAt: null,
    loginResolvedAt: null,
    groupKey: null,
    version: 1,
    type: "call.activity",
    ...over,
  } as Notification;
}

/** Exactly what `pushToUser` writes: baked text PLUS the replay ticket. */
function callRow(
  status: string,
  direction: "INCOMING" | "OUTGOING",
  callType: "AUDIO" | "VIDEO",
  bakedLocale: "en" | "vi" | "th" = "vi"
): Notification {
  const copy = callCopy.activity(CALLER, callType, status, direction, 0, 0);
  const baked = copy(bakedLocale);
  return row({
    type: "call.activity",
    groupKey: "call:c1",
    payload: {
      title: baked.title,
      body: baked.body,
      data: {
        callId: "c1",
        callType,
        callStatus: status,
        callDirection: direction,
        durationSec: "0",
        inboxTitle: CALLER,
        copyRef: JSON.stringify(copy.descriptor),
      },
    },
  });
}

const read = (r: Notification, locale: "en" | "vi" | "th") =>
  runWithLocale(locale, () => serializeNotification(r, "viewer-1"));

describe("notification copy follows the reader's current language", () => {
  it("renders the SAME row in whichever language is asked for", async () => {
    const missed = callRow("MISSED", "INCOMING", "AUDIO", "vi");

    const vi = await read(missed, "vi");
    const en = await read(missed, "en");
    const th = await read(missed, "th");

    expect(vi.body).toBe(t("NOTIF_CALL_MISSED_VOICE", "vi"));
    expect(en.body).toBe(t("NOTIF_CALL_MISSED_VOICE", "en"));
    expect(th.body).toBe(t("NOTIF_CALL_MISSED_VOICE", "th"));

    // Same row: id, timestamps and call metadata are untouched by the switch.
    for (const dto of [vi, en, th]) {
      expect(dto.id).toBe("n1");
      expect(dto.createdAt).toEqual(missed.createdAt);
      expect(dto.groupKey).toBe("call:c1");
      expect(dto.payload).toMatchObject({
        data: { callId: "c1", callStatus: "MISSED", callDirection: "INCOMING" },
      });
    }
  });

  it("never translates the caller's name", async () => {
    for (const locale of ["en", "vi", "th"] as const) {
      const dto = await read(callRow("MISSED", "INCOMING", "AUDIO"), locale);
      expect(dto.title).toBe(CALLER);
    }
  });

  it("covers all six call-history states from the canonical fields", async () => {
    const cases: [
      string,
      "INCOMING" | "OUTGOING",
      "AUDIO" | "VIDEO",
      Parameters<typeof t>[0],
    ][] = [
      ["ENDED", "INCOMING", "AUDIO", "NOTIF_CALL_COMPLETED_VOICE"],
      ["ENDED", "OUTGOING", "AUDIO", "NOTIF_CALL_COMPLETED_VOICE"],
      ["MISSED", "INCOMING", "AUDIO", "NOTIF_CALL_MISSED_VOICE"],
      ["ENDED", "INCOMING", "VIDEO", "NOTIF_CALL_COMPLETED_VIDEO"],
      ["ENDED", "OUTGOING", "VIDEO", "NOTIF_CALL_COMPLETED_VIDEO"],
      ["MISSED", "INCOMING", "VIDEO", "NOTIF_CALL_MISSED_VIDEO"],
    ];
    for (const [status, direction, callType, key] of cases) {
      const dto = await read(callRow(status, direction, callType), "en");
      expect(dto.body).toBe(t(key, "en"));
    }
    // The caller's side of an unanswered ring is "no answer", never "missed".
    const caller = await read(callRow("MISSED", "OUTGOING", "AUDIO"), "en");
    expect(caller.body).toBe(t("NOTIF_CALL_NO_ANSWER_VOICE", "en"));
  });

  it("localizes a friend request and its resolution line together", async () => {
    const copy = friendCopy.requested("Ana");
    const extra = resolutionCopy.friendAccepted("Ana");
    const baked = copy("vi");
    const friendRow = row({
      type: "friend.requested",
      actorId: "ana-1",
      payload: {
        title: baked.title,
        body: baked.body,
        data: {
          suppressTitle: "true",
          resolution: extra("vi").resolution,
          copyRef: JSON.stringify(copy.descriptor),
          dataRef: JSON.stringify(extra.descriptor),
        },
      },
    });

    const en = await read(friendRow, "en");
    expect(en.body).toBe(t("NOTIF_FRIEND_REQUESTED", "en", { name: "Ana" }));
    expect(en.resolution).toBe(
      t("NOTIF_FRIEND_RESOLUTION_ACCEPTED", "en", { name: "Ana" })
    );

    const th = await read(friendRow, "th");
    expect(th.body).toBe(t("NOTIF_FRIEND_REQUESTED", "th", { name: "Ana" }));
    expect(th.resolution).toBe(
      t("NOTIF_FRIEND_RESOLUTION_ACCEPTED", "th", { name: "Ana" })
    );
    expect(th.body).toContain("Ana");
  });

  it("keeps the replay tickets off the wire", async () => {
    const dto = await read(callRow("MISSED", "INCOMING", "AUDIO"), "en");
    const data = (dto.payload as { data: Record<string, unknown> }).data;
    expect(data.copyRef).toBeUndefined();
    expect(data.dataRef).toBeUndefined();
    // The canonical call fields the client maps from are still there.
    expect(data.callType).toBe("AUDIO");
    expect(data.callStatus).toBe("MISSED");
    expect(data.callDirection).toBe("INCOMING");
  });

  describe("backward compatibility with rows written before replay tickets", () => {
    it("keeps the stored text when there is no ticket", async () => {
      const legacy = row({
        type: "call.activity",
        payload: {
          title: CALLER,
          body: "Cuộc gọi thoại nhỡ",
          data: { callStatus: "MISSED", callDirection: "INCOMING" },
        },
      });
      expect((await read(legacy, "en")).body).toBe("Cuộc gọi thoại nhỡ");
    });

    it("keeps the stored text when the ticket is unusable", async () => {
      for (const copyRef of [
        "not json",
        JSON.stringify({ ref: "call.deletedBuilder", args: [] }),
        JSON.stringify({ args: [] }),
      ]) {
        const broken = row({
          type: "call.activity",
          payload: { title: CALLER, body: "stored", data: { copyRef } },
        });
        expect((await read(broken, "en")).body).toBe("stored");
      }
    });

    it("never re-renders admin-authored text, which has no ticket", async () => {
      const announcement = row({
        type: "ANNOUNCEMENT",
        actorId: "",
        payload: {
          title: "Scheduled maintenance",
          body: "We will be down 02:00–03:00 UTC.",
          data: {},
        },
      });
      const dto = await read(announcement, "vi");
      expect(dto.title).toBe("Scheduled maintenance");
      expect(dto.body).toBe("We will be down 02:00–03:00 UTC.");
    });
  });
});
