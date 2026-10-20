/**
 * Livestream-ended rows read the stream's runtime in the reader's language
 * (AIMESS-457): "sau 2 phút", never the English "sau 2m".
 *
 * The consumer used to put the English-baked `duration` string ("2m") into the
 * replay ticket, so every re-render kept it. New tickets carry the seconds; rows
 * already written are healed on read from their own `data.durationSeconds`.
 */
import { communityCopy, runWithLocale } from "@aimess/constants";

import type { Notification } from "../../src/generated/prisma/index.js";
import { serializeNotification } from "../../src/lib/notification-serializer.js";

type Copy = ReturnType<typeof communityCopy.livestreamEnded>;

function endedRow(copy: Copy, data: Record<string, string>): Notification {
  const baked = copy("en");
  return {
    id: "n-live",
    userId: "viewer-1",
    actorId: "host-1",
    entity: {},
    actorSnapshot: {},
    isRead: false,
    readAt: null,
    isDeleted: false,
    deletedAt: null,
    createdAt: new Date("2026-10-20T06:00:00Z"),
    updatedAt: new Date("2026-10-20T06:00:00Z"),
    loginSessionId: null,
    loginExpiresAt: null,
    loginResolvedAt: null,
    groupKey: null,
    version: 1,
    type: "community.livestream_ended",
    payload: {
      title: baked.title,
      body: baked.body,
      data: {
        communityId: "c".repeat(24),
        livestreamId: "5".repeat(24),
        endedReason: "USER",
        copyRef: JSON.stringify(copy.descriptor),
        ...data,
      },
    },
  } as Notification;
}

const read = (row: Notification, locale: "en" | "vi" | "th") =>
  runWithLocale(locale, () => serializeNotification(row, "viewer-1")).then(
    (dto) => dto.body
  );

describe("livestream-ended duration follows the reader's language", () => {
  it("a row written with the English-baked '2m' reads 'sau 2 phút' in Vietnamese", async () => {
    const row = endedRow(
      communityCopy.livestreamEnded("QA Android admin", "Himanshu Yadav", "2m"),
      { duration: "2m", durationSeconds: "120" }
    );
    expect(await read(row, "vi")).toBe(
      "Himanshu Yadav đã kết thúc buổi phát trực tiếp trong QA Android admin sau 2 phút"
    );
    expect(await read(row, "en")).toBe(
      "Himanshu Yadav ended the livestream in QA Android admin after 2m"
    );
    expect(await read(row, "th")).toContain("หลังจาก 2 นาที");
  });

  it("hours and minutes: '15h 45m' → '15 giờ 45 phút'", async () => {
    const row = endedRow(
      communityCopy.livestreamEnded("Stream Test", "Himanshu Yadav", "15h 45m"),
      { duration: "15h 45m", durationSeconds: String(15 * 3600 + 45 * 60) }
    );
    expect(await read(row, "vi")).toContain("sau 15 giờ 45 phút");
    expect(await read(row, "en")).toContain("after 15h 45m");
  });

  it("platform end ('System ended…') and Super Admin end heal the same way", async () => {
    const system = endedRow(
      communityCopy.livestreamEndedBySystem("Stream Test", "3m") as Copy,
      { duration: "3m", durationSeconds: "180", endedReason: "SYSTEM" }
    );
    expect(await read(system, "vi")).toBe(
      "Hệ thống đã kết thúc buổi phát trực tiếp trong Stream Test sau 3 phút"
    );
    const admin = endedRow(
      communityCopy.livestreamEndedByAdmin(
        "Cool Community",
        "4m",
        "Jane Doe"
      ) as Copy,
      { duration: "4m", durationSeconds: "240", endedReason: "ADMIN" }
    );
    expect(await read(admin, "vi")).toContain("sau 4 phút");
    expect(await read(admin, "vi")).toContain("Jane Doe");
  });

  it("a new ticket carries the seconds and renders per reader", async () => {
    const copy = communityCopy.livestreamEnded("Stream Test", "Jane Doe", 120);
    expect(copy.descriptor?.args?.[2]).toBe(120);
    const row = endedRow(copy, { duration: "2m", durationSeconds: "120" });
    expect(await read(row, "vi")).toContain("sau 2 phút");
    expect(await read(row, "en")).toContain("after 2m");
  });

  it("a row without durationSeconds keeps its stored runtime instead of dropping it", async () => {
    const row = endedRow(
      communityCopy.livestreamEnded("Stream Test", "Jane Doe", "2m"),
      { duration: "2m" }
    );
    expect(await read(row, "vi")).toContain("sau 2m");
  });

  it("a stream that ended with no runtime stays without one", async () => {
    const row = endedRow(
      communityCopy.livestreamEnded("Stream Test", "Jane Doe", ""),
      { duration: "", durationSeconds: "0" }
    );
    expect(await read(row, "vi")).toBe(
      "Jane Doe đã kết thúc buổi phát trực tiếp trong Stream Test"
    );
  });
});
