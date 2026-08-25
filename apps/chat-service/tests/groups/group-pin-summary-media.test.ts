/**
 * `GroupPinService.getActivePinSummary` — the `pinnedMessage` field the group
 * messages API embeds so the pinned banner can render before (or without) the
 * pinned row ever entering the loaded page.
 *
 * The banner reads its thumbnail straight off this summary, so the summary must
 * cross the resolve-on-read boundary: raw object keys in the frozen
 * `contentPinned` snapshot become full download URLs here, never at the client.
 */
import { GroupPinService } from "../../src/services/group-pin.service.js";

jest.mock("../../src/lib/media-resolve.js", () => {
  const actual = jest.requireActual("../../src/lib/media-resolve.js");
  return {
    ...actual,
    resolveMediaUrl: jest.fn(async (key?: string | null) =>
      key ? `https://cdn.test/${key}` : ""
    ),
    resolveContentFiles: jest.fn(async (files: Array<{ objectKey?: string }>) =>
      (files ?? []).map((f) => ({
        ...f,
        url: f.objectKey ? `https://cdn.test/${f.objectKey}` : "",
      }))
    ),
  };
});

const ROOM_ID = "r".repeat(24);
const MSG_ID = "m".repeat(24);

function makeService(pin: unknown, live: unknown) {
  return new GroupPinService(
    { findActivePinByRoom: jest.fn().mockResolvedValue(pin) } as never,
    { findById: jest.fn().mockResolvedValue(live) } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never
  );
}

const basePin = {
  messageId: MSG_ID,
  roomId: ROOM_ID,
  senderId: "u1",
  senderDisplayName: "Ann",
  senderAvatar: "avatars/ann.png",
  messageCreatedAt: new Date(1000),
  pinnedAt: new Date(2000),
  pinnedBy: "u1",
  originalMessageDeletedAt: null,
};

describe("GroupPinService.getActivePinSummary — media resolve-on-read", () => {
  it("returns a full URL for an image pin, not the raw object key", async () => {
    const svc = makeService(
      {
        ...basePin,
        contentPinned: { files: [{ objectKey: "group-chat-uploads/a.jpg" }] },
      },
      { id: MSG_ID, messageType: "IMAGE", content: {} }
    );

    const summary = await svc.getActivePinSummary(ROOM_ID);

    expect(summary?.messageType).toBe("IMAGE");
    expect(summary?.media[0]?.url).toBe(
      "https://cdn.test/group-chat-uploads/a.jpg"
    );
    expect(summary?.senderAvatar).toBe("https://cdn.test/avatars/ann.png");
  });

  it("carries the sticker attachment, which lives outside content.files", async () => {
    const svc = makeService(
      {
        ...basePin,
        contentPinned: { sticker: { objectKey: "stickers/wave.webp" } },
      },
      { id: MSG_ID, messageType: "STICKER", content: {} }
    );

    const summary = await svc.getActivePinSummary(ROOM_ID);

    expect(summary?.media[0]?.url).toBe("https://cdn.test/stickers/wave.webp");
  });

  it("returns no media for a text pin", async () => {
    const svc = makeService(
      { ...basePin, contentPinned: { text: "hello" } },
      { id: MSG_ID, messageType: "TEXT", content: { text: "hello" } }
    );

    const summary = await svc.getActivePinSummary(ROOM_ID);

    expect(summary?.text).toBe("hello");
    expect(summary?.media).toEqual([]);
  });
});
