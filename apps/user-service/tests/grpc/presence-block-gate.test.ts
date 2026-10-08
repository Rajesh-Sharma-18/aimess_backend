import { blockedEitherWay } from "../../src/lib/block-visibility.js";

describe("presence gate — blocks", () => {
  it("hides presence across a block in either direction", () => {
    const set = blockedEitherWay("me", [
      { blockerId: "me", blockedId: "a" },
      { blockerId: "b", blockedId: "me" },
    ]);
    expect([...set].sort()).toEqual(["a", "b"]);
  });
});
