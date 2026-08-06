import {
  getGroupVisibilityCutoff,
  getPrivateDeletionCutoff,
} from "../../src/lib/deletion-cutoff.js";

describe("getPrivateDeletionCutoff", () => {
  it("returns clearFor when it is later than deletedFor", () => {
    const deletedAt = "2026-01-01T00:00:00.000Z";
    const clearAt = "2026-01-10T00:00:00.000Z";
    expect(
      getPrivateDeletionCutoff(
        { deletedFor: { user_1: deletedAt }, clearFor: { user_1: clearAt } },
        "user_1"
      )
    ).toEqual(new Date(clearAt));
  });

  it("returns deletedFor when clearFor is missing", () => {
    const deletedAt = "2026-01-01T00:00:00.000Z";
    expect(
      getPrivateDeletionCutoff({ deletedFor: { user_1: deletedAt } }, "user_1")
    ).toEqual(new Date(deletedAt));
  });
});

describe("getGroupVisibilityCutoff", () => {
  it("returns joinedAt when the member never cleared the conversation", () => {
    const joinedAt = new Date("2026-01-05T00:00:00Z");
    expect(getGroupVisibilityCutoff({ clearedAt: null, joinedAt })).toEqual(
      joinedAt
    );
  });

  it("returns clearedAt when it is LATER than joinedAt (cleared after joining)", () => {
    const joinedAt = new Date("2026-01-01T00:00:00Z");
    const clearedAt = new Date("2026-01-10T00:00:00Z");
    expect(getGroupVisibilityCutoff({ clearedAt, joinedAt })).toEqual(
      clearedAt
    );
  });

  it("returns joinedAt when it is LATER than clearedAt (rejoined after clearing)", () => {
    const clearedAt = new Date("2026-01-01T00:00:00Z");
    const joinedAt = new Date("2026-01-10T00:00:00Z");
    expect(getGroupVisibilityCutoff({ clearedAt, joinedAt })).toEqual(joinedAt);
  });

  it("returns clearChatAt when it is later than joinedAt and clearedAt", () => {
    const clearedAt = new Date("2026-01-01T00:00:00Z");
    const joinedAt = new Date("2026-01-05T00:00:00Z");
    const clearChatAt = new Date("2026-01-10T00:00:00Z");
    expect(
      getGroupVisibilityCutoff({ clearedAt, joinedAt, clearChatAt })
    ).toEqual(clearChatAt);
  });

  it("returns undefined when member is null (no gate — caller must guard membership separately)", () => {
    expect(getGroupVisibilityCutoff(null)).toBeUndefined();
  });

  it("returns undefined when joinedAt is missing (defensive — real rows always have it)", () => {
    expect(
      getGroupVisibilityCutoff({ clearedAt: null, joinedAt: null })
    ).toBeUndefined();
  });
});
