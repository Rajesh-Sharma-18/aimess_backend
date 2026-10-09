/**
 * Suite: LivestreamCommentService.reportComment — the shared 20-reports/day quota.
 */
import { TooManyRequestsError } from "@aimess/errors";
import { LivestreamCommentService } from "../../src/services/livestream-comment.service.js";

/** Minimal in-memory Redis: just the calls the limiter + broadcast make. */
function fakeRedis() {
  const store = new Map<string, { v: number; exp?: number }>();
  const live = (k: string) => {
    const e = store.get(k);
    if (e?.exp !== undefined && e.exp <= Date.now()) store.delete(k);
    return store.get(k);
  };
  return {
    publish: jest.fn().mockResolvedValue(1),
    ttl: async (k: string) => {
      const e = live(k);
      if (!e) return -2;
      return e.exp === undefined ? -1 : Math.ceil((e.exp - Date.now()) / 1000);
    },
    incr: async (k: string) => {
      const e = live(k) ?? { v: 0 };
      e.v += 1;
      store.set(k, e);
      return e.v;
    },
    expire: async (k: string, sec: number) => {
      const e = live(k);
      if (e) e.exp = Date.now() + sec * 1000;
      return e ? 1 : 0;
    },
    set: async (k: string, _v: string, _ex: string, sec: number, nx?: string) => {
      if (nx === "NX" && live(k)) return null;
      store.set(k, { v: 1, exp: Date.now() + sec * 1000 });
      return "OK";
    },
    del: async (k: string) => (store.delete(k) ? 1 : 0),
  };
}

it("21st report in a day is REPORT_LIMIT_REACHED with retry-after; nothing persisted", async () => {
  const reportRepo = {
    upsert: jest.fn().mockImplementation((d: Record<string, unknown>) =>
      Promise.resolve({ id: "r1", ...d, createdAt: new Date() })
    ),
  };
  const service = new LivestreamCommentService(
    {
      findById: jest
        .fn()
        .mockResolvedValue({ id: "c1", livestreamId: "s1", sentBy: "u2" }),
    } as any,
    { findById: jest.fn().mockResolvedValue({ id: "s1", communityId: null }) } as any,
    {} as any,
    fakeRedis() as any,
    {} as any,
    {} as any,
    reportRepo as any
  );
  const report = () =>
    service.reportComment({
      commentId: "c1",
      livestreamId: "s1",
      reportedBy: "u1",
      reason: "SPAM" as any,
    });

  for (let i = 0; i < 20; i++) await report();
  const err = await report().catch((e: unknown) => e);
  expect(err).toBeInstanceOf(TooManyRequestsError);
  expect((err as TooManyRequestsError).messageKey).toBe("REPORT_LIMIT_REACHED");
  expect((err as TooManyRequestsError).retryAfterSec).toBe(86_400);
  expect(reportRepo.upsert).toHaveBeenCalledTimes(20);
});
