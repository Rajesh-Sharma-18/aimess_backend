import {
  buildPrivateSystemFallbackText,
  personalizePrivateSystemMessageForViewer,
} from "@aimess/constants";

describe("buildPrivateSystemFallbackText", () => {
  it("personalizes friendship creation copy for the viewer", () => {
    const data = {
      actorId: "u1",
      actorName: "Rajesh",
      targetUserId: "u2",
      targetName: "Peter Parker",
    };

    expect(buildPrivateSystemFallbackText("FRIENDSHIP_CREATED", data)).toBe(
      "Rajesh and Peter Parker are now friends"
    );
    expect(
      personalizePrivateSystemMessageForViewer(
        "FRIENDSHIP_CREATED",
        data,
        "Rajesh and Peter Parker are now friends",
        "u1"
      )
    ).toBe("You and Peter Parker are now friends");
  });

  it("personalizes private pin copy like group/community lifecycle lines", () => {
    const data = { actorId: "u1", actorName: "Rajesh" };

    expect(buildPrivateSystemFallbackText("MESSAGE_PINNED", data)).toBe(
      "Rajesh pinned a message"
    );
    expect(
      personalizePrivateSystemMessageForViewer(
        "MESSAGE_PINNED",
        data,
        "Rajesh pinned a message",
        "u1"
      )
    ).toBe("You pinned a message");
  });
});
