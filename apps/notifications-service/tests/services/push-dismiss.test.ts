/**
 * push-dismiss.ts — closing tray cards on every device of ONE user.
 *
 *  - the `notify:dismiss` socket frame is always published, with the tags
 *  - the silent push only goes out when a card with one of the tags was shown
 *    (tray marker), and then to every platform, WEB included
 *  - MESSAGE_READ keeps its mobile contract without a marker, but never wakes WEB
 */
const redisMock = { pipeline: jest.fn() };
jest.mock("../../src/config/redis.js", () => ({ redis: redisMock }));

const publishUserSocketEvent = jest.fn(async () => 1);
jest.mock("@aimess/redis", () => ({ publishUserSocketEvent }));

jest.mock("../../src/services/push.service.js", () => ({
  pushToUser: jest.fn(async () => undefined),
}));

import { dismissTrayCards } from "../../src/services/push-dismiss.js";
import { pushToUser } from "../../src/services/push.service.js";
import { roomTags } from "../../src/lib/push-tags.js";

const push = pushToUser as jest.Mock;
const USER = "11111111-1111-4111-8111-111111111111";
const ROOM = "room-1";

/** Tray markers present for these tags (DEL returns 1 for them). */
function shown(...tags: string[]): void {
  redisMock.pipeline.mockImplementation(() => {
    const dels: string[] = [];
    const p = {
      del: (key: string) => {
        dels.push(key);
        return p;
      },
      exec: async () =>
        dels.map((key) => [
          null,
          tags.some((t) => key.endsWith(`:${t}`)) ? 1 : 0,
        ]),
    };
    return p;
  });
}

beforeEach(() => {
  push.mockClear();
  publishUserSocketEvent.mockClear();
});

it("always tells the user's sockets, and sends no push when no card was shown", async () => {
  shown();
  await dismissTrayCards({
    userId: USER,
    tags: roomTags(ROOM),
    reason: "READ",
  });

  expect(publishUserSocketEvent).toHaveBeenCalledWith(
    expect.anything(),
    USER,
    "notify:dismiss",
    expect.objectContaining({
      op: "cancel",
      tags: roomTags(ROOM),
      reason: "READ",
    })
  );
  expect(push).not.toHaveBeenCalled();
});

it("sends a silent cancel to every platform when a card was shown", async () => {
  shown(`conv:${ROOM}`);
  await dismissTrayCards({
    userId: USER,
    tags: roomTags(ROOM),
    reason: "READ",
  });

  expect(push).toHaveBeenCalledTimes(1);
  const input = push.mock.calls[0][0];
  expect(input).toMatchObject({
    userId: USER,
    type: "NOTIFICATION_DISMISS",
    dataOnly: true,
    bypassSettings: true,
    skipInbox: true,
    data: { op: "cancel", tags: roomTags(ROOM).join(","), reason: "READ" },
  });
  expect(input.platforms).toBeUndefined();
});

it("keeps MESSAGE_READ on mobile without a card, but not on WEB", async () => {
  shown();
  await dismissTrayCards({
    userId: USER,
    type: "MESSAGE_READ",
    tags: roomTags(ROOM),
    reason: "READ",
    alwaysPushMobile: true,
  });

  expect(push).toHaveBeenCalledTimes(1);
  expect(push.mock.calls[0][0]).toMatchObject({
    type: "MESSAGE_READ",
    platforms: ["ANDROID", "IOS"],
  });
});
