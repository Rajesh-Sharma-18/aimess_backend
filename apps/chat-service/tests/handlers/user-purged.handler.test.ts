/**
 * AIM-44 — chat-service consumed no user lifecycle event, so every message a
 * deleted account had ever sent kept a `senderName` and `senderAvatar` snapshot
 * taken at send time. Those are what the transcript and the conversation list
 * render — not a live lookup — so the person's real name and photo stayed
 * visible in every conversation they had ever taken part in, indefinitely.
 */

type Message = Record<string, unknown>;

let privateMessages: Message[] = [];
let groupMessages: Message[] = [];
let generalMessages: Message[] = [];

function updater(rows: () => Message[], idField: string) {
  return async ({
    where,
    data,
  }: {
    where: Record<string, string>;
    data: Record<string, unknown>;
  }) => {
    let count = 0;
    for (const row of rows()) {
      if (row[idField] === where[idField]) {
        Object.assign(row, data);
        count += 1;
      }
    }
    return { count };
  };
}

jest.mock("../../src/config/prisma.js", () => ({
  prisma: {
    privateMessage: { updateMany: updater(() => privateMessages, "senderId") },
    groupMessage: { updateMany: updater(() => groupMessages, "senderId") },
    generalRoomMessage: {
      updateMany: updater(() => generalMessages, "sentBy"),
    },
  },
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { handleUserPurged } =
  require("../../src/handlers/user-purged.handler.js") as typeof import("../../src/handlers/user-purged.handler.js");

const USER = "user-1";

beforeEach(() => {
  privateMessages = [
    {
      id: "p1",
      senderId: USER,
      content: "see you at six",
      senderName: "Jane Doe",
      senderAvatar: "avatars/jane.jpg",
    },
    {
      id: "p2",
      senderId: "user-2",
      content: "sounds good",
      senderName: "Minh Tran",
      senderAvatar: "avatars/minh.jpg",
    },
  ];
  groupMessages = [
    {
      id: "g1",
      senderId: USER,
      senderName: "Jane Doe",
      senderAvatar: "avatars/jane.jpg",
    },
  ];
  generalMessages = [
    {
      id: "c1",
      sentBy: USER,
      senderName: "Jane Doe",
      senderAvatar: "avatars/jane.jpg",
    },
  ];
});

describe("user.purged — chat sender snapshots", () => {
  it("erases the sender identity across all three message families", async () => {
    // Private, group and community-room messages each keep their own copy under
    // slightly different column names; missing one leaves the name on display.
    await handleUserPurged({ userId: USER } as never);

    expect(privateMessages[0]?.senderName).toBe("Deleted Account");
    expect(groupMessages[0]?.senderName).toBe("Deleted Account");
    expect(generalMessages[0]?.senderName).toBe("Deleted Account");

    expect(privateMessages[0]?.senderAvatar).toBe("");
    expect(groupMessages[0]?.senderAvatar).toBe("");
    // Nullable on this model, unlike the other two.
    expect(generalMessages[0]?.senderAvatar).toBeNull();
  });

  it("keeps the messages themselves", async () => {
    // They are the other participants' conversation history as much as the
    // sender's; deleting them would silently rewrite it. What goes is the
    // identity attached to them.
    await handleUserPurged({ userId: USER } as never);

    expect(privateMessages).toHaveLength(2);
    expect(privateMessages[0]?.content).toBe("see you at six");
  });

  it("leaves the other participant's identity alone", async () => {
    await handleUserPurged({ userId: USER } as never);

    expect(privateMessages[1]?.senderName).toBe("Minh Tran");
    expect(privateMessages[1]?.senderAvatar).toBe("avatars/minh.jpg");
  });

  it("is idempotent, so a dead-letter replay is safe", async () => {
    await handleUserPurged({ userId: USER } as never);
    const first = { ...(privateMessages[0] as Message) };

    await handleUserPurged({ userId: USER } as never);

    expect(privateMessages[0]).toEqual(first);
  });

  it("does not fail for a user who never sent a message", async () => {
    privateMessages = [];
    groupMessages = [];
    generalMessages = [];

    await expect(handleUserPurged({ userId: USER } as never)).resolves.toBeUndefined();
  });
});
