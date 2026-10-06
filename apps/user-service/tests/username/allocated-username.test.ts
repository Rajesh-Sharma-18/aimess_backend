/**
 * `allocatedUsername` — the username other people may see. Registration
 * reserves one derived from the login account; it is not the user's until the
 * profile is complete, so it must not be rendered as "@<handle>" before then.
 */
const publish = jest.fn();
jest.mock("amqplib", () => ({
  __esModule: true,
  default: {
    connect: jest.fn(async () => ({
      createChannel: async () => ({
        assertExchange: async () => undefined,
        publish,
      }),
    })),
  },
}));

import { allocatedUsername } from "../../src/lib/username.util.js";
import { publishProfileUpdatedSafe } from "../../src/messaging/publish-profile-updated.js";

describe("allocatedUsername", () => {
  it("hides the registration-reserved username while names are missing", () => {
    expect(
      allocatedUsername({ username: "rajesh123", firstName: "", lastName: "" })
    ).toBe("");
  });

  it("hides it when only one name is set", () => {
    expect(
      allocatedUsername({
        username: "rajesh123",
        firstName: "Rajesh",
        lastName: "  ",
      })
    ).toBe("");
  });

  it("returns the username once the profile is complete", () => {
    expect(
      allocatedUsername({
        username: "rajesh_sharma",
        firstName: "Rajesh",
        lastName: "Sharma",
      })
    ).toBe("rajesh_sharma");
  });

  it("returns it even when it matches the account text", () => {
    // Same text as the account is fine — the profile is complete, so it IS
    // the allocated username.
    expect(
      allocatedUsername({
        username: "rajesh123",
        firstName: "Rajesh",
        lastName: "Sharma",
      })
    ).toBe("rajesh123");
  });
});

describe("publishProfileUpdatedSafe", () => {
  const sent = async () => {
    await new Promise((r) => setImmediate(r));
    const buf = publish.mock.calls.at(-1)?.[2] as Buffer;
    return JSON.parse(buf.toString()).data as { username: string };
  };

  const base = {
    userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    displayName: "",
    avatarObjectKey: null,
    updatedAt: new Date(0).toISOString(),
  };

  it("does not fan the reserved username out to member snapshots", async () => {
    publishProfileUpdatedSafe({
      ...base,
      username: "rajesh123",
      isProfileCompleted: false,
    });
    expect((await sent()).username).toBe("");
  });

  it("carries the username once the profile is complete", async () => {
    publishProfileUpdatedSafe({
      ...base,
      username: "rajesh_sharma",
      isProfileCompleted: true,
    });
    expect((await sent()).username).toBe("rajesh_sharma");
  });
});
