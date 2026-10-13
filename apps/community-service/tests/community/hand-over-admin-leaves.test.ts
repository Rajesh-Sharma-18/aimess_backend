jest.unmock("../../src/repositories/community.repository.js");
const updateMany = jest.fn(async () => ({ count: 1 }));
jest.mock("../../src/config/prisma.js", () => ({
  prisma: {
    $transaction: jest.fn(async (fn: (tx: unknown) => unknown) =>
      fn({ community: { updateMany }, communityMember: { updateMany } })
    ),
  },
}));

import { communityRepository } from "../../src/repositories/community.repository.js";

describe("handOverAdmin — former admin's row", () => {
  beforeEach(() => updateMany.mockClear());

  it("default: former admin becomes MODERATOR and stays ACTIVE", async () => {
    await expect(communityRepository.handOverAdmin("c1", "old", "new")).resolves.toBe(true);
    const former = (updateMany.mock.calls[2] as unknown as [{ data: Record<string, unknown> }])[0];
    expect(former.data).toMatchObject({ role: "MODERATOR" });
    expect(former.data).not.toHaveProperty("status");
  });

  it("deleted account: former admin's membership ends LEFT", async () => {
    await communityRepository.handOverAdmin("c1", "old", "new", true);
    const former = (updateMany.mock.calls[2] as unknown as [{ data: Record<string, unknown> }])[0];
    expect(former.data).toMatchObject({ role: "MEMBER", status: "LEFT" });
  });
});
