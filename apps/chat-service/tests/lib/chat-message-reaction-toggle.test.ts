/**
 * One-reaction-per-user (WhatsApp-style) invariant for `toggleStoredReaction` —
 * the shared toggle/replace primitive used by community, private, and group
 * message reactions alike.
 */
import {
  toggleStoredReaction,
  reactionUserIdMap,
} from "../../src/lib/chat-message.serializer.js";

const U1 = "user-1";
const U2 = "user-2";

describe("toggleStoredReaction — one reaction per user", () => {
  it("adds a reaction when the user had none", () => {
    const result = toggleStoredReaction({}, U1, "👍");
    expect(reactionUserIdMap(result)).toEqual({ "👍": [U1] });
  });

  it("removes the reaction on a second tap of the SAME emoji (toggle-off)", () => {
    const first = toggleStoredReaction({}, U1, "👍");
    const second = toggleStoredReaction(first, U1, "👍");
    expect(reactionUserIdMap(second)).toEqual({});
  });

  it("REPLACES the reaction when tapping a DIFFERENT emoji — never stacks", () => {
    const first = toggleStoredReaction({}, U1, "👍");
    const replaced = toggleStoredReaction(first, U1, "❤️");
    const map = reactionUserIdMap(replaced);
    expect(map["👍"]).toBeUndefined();
    expect(map["❤️"]).toEqual([U1]);
    // Exactly one bucket contains the user.
    const bucketsWithUser = Object.values(map).filter((ids) =>
      ids.includes(U1)
    );
    expect(bucketsWithUser).toHaveLength(1);
  });

  it("leaves other users' reactions on the same emoji untouched when one user replaces theirs", () => {
    let state = toggleStoredReaction({}, U1, "👍");
    state = toggleStoredReaction(state, U2, "👍");
    state = toggleStoredReaction(state, U1, "❤️");
    const map = reactionUserIdMap(state);
    expect(map["👍"]).toEqual([U2]);
    expect(map["❤️"]).toEqual([U1]);
  });

  it("prunes an emoji bucket to empty (deleted) once its last reactor replaces/removes", () => {
    const first = toggleStoredReaction({}, U1, "👍");
    const replaced = toggleStoredReaction(first, U1, "❤️");
    expect(Object.prototype.hasOwnProperty.call(replaced, "👍")).toBe(false);
  });
});
