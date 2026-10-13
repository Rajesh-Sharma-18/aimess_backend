/** §9.1: one missed-call tray card per caller, counted until read/answer. */
const pushToUser = jest.fn();
jest.mock("../../src/services/push.service.js", () => ({
  pushToUser: (...args: unknown[]) => pushToUser(...args),
}));

const publishUserSocketEvent = jest.fn(async () => undefined);
jest.mock("@aimess/redis", () => ({
  ...jest.requireActual("@aimess/redis"),
  publishUserSocketEvent: (...args: unknown[]) => publishUserSocketEvent(...(args as [])),
}));

// In-memory redis: enough of set / multi / pipeline for the code under test.
const store = new Map<string, Record<string, string> | string>();
const hash = (k: string): Record<string, string> => {
  const v = store.get(k);
  if (v && typeof v === "object") return v;
  const h: Record<string, string> = {};
  store.set(k, h);
  return h;
};
function chain() {
  const ops: (() => unknown)[] = [];
  const c = {
    hincrby: (k: string, f: string, n: number) => (ops.push(() => { const h = hash(k); h[f] = String(Number(h[f] ?? 0) + n); return Number(h[f]); }), c),
    hset: (k: string, f: string, v: string) => (ops.push(() => { hash(k)[f] = v; return 1; }), c),
    expire: () => (ops.push(() => 1), c),
    hgetall: (k: string) => (ops.push(() => ({ ...hash(k) })), c),
    hget: (k: string, f: string) => (ops.push(() => { const v = store.get(k); return v && typeof v === "object" ? v[f] ?? null : null; }), c),
    del: (k: string) => (ops.push(() => (store.delete(k) ? 1 : 0)), c),
    exec: async () => ops.map((op) => [null, op()]),
  };
  return c;
}
const redisMock = {
  set: jest.fn(async (k: string) => (store.has(k) ? null : (store.set(k, "1"), "OK"))),
  multi: () => chain(),
  pipeline: () => chain(),
};
jest.mock("../../src/config/redis.js", () => ({ redis: redisMock }));

import { handleCallActivity } from "../../src/consumers/call.consumer.js";
import { handleConversationRead } from "../../src/consumers/read.consumer.js";

const CALLER = "caller-1";
const CALLEE = "callee-1";
const base = {
  callerId: CALLER,
  calleeId: CALLEE,
  callType: "AUDIO",
  status: "MISSED",
  endReason: "no_answer",
  durationSec: 0,
  ringDurationSec: 60,
  privateRoomId: "prv_1",
  endedAt: 1_700_000_000_000,
  callerName: "Ann",
  callerAvatar: "",
  calleeName: "Bo",
  calleeAvatar: "",
};

type Push = {
  type: string;
  userId: string;
  collapseKey?: string;
  renotify?: boolean;
  data: Record<string, string>;
  copy?: (l: "en" | "vi" | "th") => { title: string; body: string };
};
const missed = (): Push[] =>
  pushToUser.mock.calls.map(([i]) => i as Push).filter((i) => i.type === "CALL_MISSED");
const last = () => missed().at(-1)!;

beforeEach(() => {
  store.clear();
  pushToUser.mockReset();
  pushToUser.mockResolvedValue(undefined);
  publishUserSocketEvent.mockClear();
});

describe("missed-call push grouping", () => {
  it("tags by caller, renotifies on web, and counts N per caller", async () => {
    await handleCallActivity({ ...base, callId: "c1" });
    expect(last()).toMatchObject({ collapseKey: "missed:" + CALLER, renotify: true });
    expect(last().copy!("en")).toEqual({ title: "Ann", body: "Missed voice call" });

    await handleCallActivity({ ...base, callId: "c2" });
    expect(last().copy!("en").body).toBe("2 missed voice calls");
    expect(last().copy!("vi").body).toBe("2 cuộc gọi thoại nhỡ");
    expect(last().copy!("th").body).toBe("สายสนทนาที่ไม่ได้รับ 2 สาย");
    expect(last().data.missedCount).toBe("2");
  });

  it("all video, then mixed", async () => {
    await handleCallActivity({ ...base, callId: "v1", callType: "VIDEO" });
    await handleCallActivity({ ...base, callId: "v2", callType: "VIDEO" });
    expect(last().copy!("en").body).toBe("2 missed video calls");
    expect(last().copy!("th").body).toBe("วิดีโอคอลที่ไม่ได้รับ 2 สาย");
    await handleCallActivity({ ...base, callId: "a3" });
    expect(last().copy!("en").body).toBe("3 missed calls");
    expect(last().copy!("vi").body).toBe("3 cuộc gọi nhỡ");
    expect(last().copy!("th").body).toBe("สายที่ไม่ได้รับ 3 สาย");
  });

  it("a redelivered call is not counted twice", async () => {
    await handleCallActivity({ ...base, callId: "c1" });
    await handleCallActivity({ ...base, callId: "c1" });
    expect(missed()).toHaveLength(1);
    await handleCallActivity({ ...base, callId: "c2" });
    expect(last().copy!("en").body).toBe("2 missed voice calls");
  });

  it("reading the chat resets N and dismisses missed:<callerId>", async () => {
    await handleCallActivity({ ...base, callId: "c1" });
    await handleCallActivity({ ...base, callId: "c2" });
    await handleConversationRead({
      readerId: CALLEE,
      conversationId: "prv_1",
      conversationType: "PRIVATE",
      readAt: 1,
    });
    const tags = (publishUserSocketEvent.mock.calls.at(-1) as unknown[])[3] as { tags: string[] };
    expect(tags.tags).toContain("missed:" + CALLER);
    await handleCallActivity({ ...base, callId: "c3" });
    expect(last().copy!("en").body).toBe("Missed voice call");
  });

  it("answering a call from that caller resets N and dismisses the card", async () => {
    await handleCallActivity({ ...base, callId: "c1" });
    await handleCallActivity({ ...base, callId: "c2", status: "ENDED", endReason: "completed", durationSec: 30 });
    const dismiss = publishUserSocketEvent.mock.calls.at(-1) as unknown[];
    expect(dismiss[1]).toBe(CALLEE);
    expect((dismiss[3] as { tags: string[]; reason: string })).toMatchObject({ tags: ["missed:" + CALLER], reason: "ANSWERED" });
    await handleCallActivity({ ...base, callId: "c3" });
    expect(last().copy!("en").body).toBe("Missed voice call");
  });
});
