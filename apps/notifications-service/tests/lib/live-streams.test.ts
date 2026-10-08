const store = new Map<string, Set<string>>();
jest.mock("../../src/config/redis.js", () => ({
  redis: {
    sadd: jest.fn(async (k: string, v: string) => {
      store.set(k, (store.get(k) ?? new Set()).add(v));
      return 1;
    }),
    expire: jest.fn(async () => 1),
    smembers: jest.fn(async (k: string) => [...(store.get(k) ?? [])]),
  },
}));

import { liveStreamTags, trackLiveStream } from "../../src/lib/live-streams.js";
import { redis } from "../../src/config/redis.js";

describe("live-streams", () => {
  it("returns every tracked stream of the community as a live:<streamId> tag", async () => {
    await trackLiveStream("c1", "s1");
    await trackLiveStream("c1", "s2");
    await trackLiveStream("c2", "s3");
    expect((await liveStreamTags("c1")).sort()).toEqual(["live:s1", "live:s2"]);
    expect(await liveStreamTags("c2")).toEqual(["live:s3"]);
  });

  it("degrades to no tags when Redis fails", async () => {
    (redis.smembers as jest.Mock).mockRejectedValueOnce(new Error("down"));
    expect(await liveStreamTags("c1")).toEqual([]);
  });
});
