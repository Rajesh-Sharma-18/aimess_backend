import { LivestreamRepository } from "../../src/repositories/livestream.repository.js";

function whereFor(status: string) {
  const count = jest.fn().mockResolvedValue(0);
  const repo = new LivestreamRepository({ livestream: { count } } as never);
  return repo.adminCount({ status, communityId: "c1" }).then(() => count.mock.calls[0][0].where);
}

describe("admin stream filter", () => {
  it("treats LIVE as LIVE + RECONNECTING", async () => {
    expect(await whereFor("LIVE")).toEqual({
      AND: [{ status: { in: ["LIVE", "RECONNECTING"] } }, { communityId: "c1" }],
    });
  });

  it("matches other statuses exactly", async () => {
    expect(await whereFor("ENDED")).toEqual({
      AND: [{ status: "ENDED" }, { communityId: "c1" }],
    });
  });
});
