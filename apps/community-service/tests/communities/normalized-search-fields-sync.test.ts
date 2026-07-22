/**
 * Repository-level coverage that `createCommunity`/`updateCommunity` keep the
 * `normalizedName`/`normalizedHandle` search shadow fields in sync with
 * `name`/`handle` (see the schema doc comment on those fields, and
 * `normalizeForSearch` in `lib/community-search.util.ts`).
 *
 * Exercises the REAL repository methods with only the Prisma I/O boundary
 * mocked — same pattern as `list-discoverable-search.test.ts`.
 */

jest.unmock("../../src/repositories/community.repository.js");

jest.mock("../../src/config/prisma.js", () => ({
  prisma: {
    community: {
      create: jest.fn(),
      update: jest.fn(),
    },
  },
}));

jest.mock("../../src/generated/prisma/index.js", () => {
  const echo = () =>
    new Proxy(
      {},
      { get: (_t, key) => (typeof key === "string" ? key : undefined) }
    );
  return new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (prop === "__esModule") return true;
        return echo();
      },
    }
  );
});

import { prisma } from "../../src/config/prisma.js";
import { communityRepository } from "../../src/repositories/community.repository.js";

const createMock = (prisma as unknown as { community: { create: jest.Mock } })
  .community.create;
const updateMock = (prisma as unknown as { community: { update: jest.Mock } })
  .community.update;

beforeEach(() => {
  createMock.mockReset();
  updateMock.mockReset();
  createMock.mockResolvedValue({});
  updateMock.mockResolvedValue({});
});

function baseCreateData(
  overrides: Partial<
    Parameters<typeof communityRepository.createCommunity>[0]
  > = {}
) {
  return {
    name: "Dr. Jhatka",
    handle: "dr_jhatka",
    description: null,
    type: "PUBLIC" as never,
    categoryId: "cat1",
    categoryName: "General",
    creatorId: "u1",
    adminId: "u1",
    avatarUrl: null,
    coverUrl: null,
    ...overrides,
  };
}

describe("communityRepository.createCommunity — normalized field sync", () => {
  it("derives normalizedName/normalizedHandle from name/handle on create", async () => {
    await communityRepository.createCommunity(baseCreateData());

    const data = createMock.mock.calls[0][0].data;
    expect(data.normalizedName).toBe("drjhatka");
    expect(data.normalizedHandle).toBe("drjhatka");
  });

  it("strips a mix of formatting characters (spaces/underscores/hyphens/dots) and lowercases", async () => {
    await communityRepository.createCommunity(
      baseCreateData({
        name: "AI Developers-India.2",
        handle: "ai_developers_india2",
      })
    );

    const data = createMock.mock.calls[0][0].data;
    expect(data.normalizedName).toBe("aidevelopersindia2");
    expect(data.normalizedHandle).toBe("aidevelopersindia2");
  });

  it("still passes through the original name/handle unchanged", async () => {
    await communityRepository.createCommunity(baseCreateData());

    const data = createMock.mock.calls[0][0].data;
    expect(data.name).toBe("Dr. Jhatka");
    expect(data.handle).toBe("dr_jhatka");
  });
});

describe("communityRepository.updateCommunity — normalized field sync", () => {
  it("refreshes normalizedName when name is part of the update", async () => {
    await communityRepository.updateCommunity("c1", { name: "New Name" });

    const data = updateMock.mock.calls[0][0].data;
    expect(data.normalizedName).toBe("newname");
  });

  it("refreshes normalizedHandle when handle is part of the update", async () => {
    await communityRepository.updateCommunity("c1", { handle: "new_handle" });

    const data = updateMock.mock.calls[0][0].data;
    expect(data.normalizedHandle).toBe("newhandle");
  });

  it("refreshes both when name and handle are updated together", async () => {
    await communityRepository.updateCommunity("c1", {
      name: "Dr. Jhatka",
      handle: "dr-jhatka",
    });

    const data = updateMock.mock.calls[0][0].data;
    expect(data.normalizedName).toBe("drjhatka");
    expect(data.normalizedHandle).toBe("drjhatka");
  });

  it("leaves normalizedName/normalizedHandle untouched when updating unrelated fields", async () => {
    await communityRepository.updateCommunity("c1", {
      description: "new description",
    });

    const data = updateMock.mock.calls[0][0].data;
    expect(data).not.toHaveProperty("normalizedName");
    expect(data).not.toHaveProperty("normalizedHandle");
  });

  it("does not mutate the caller's input object", async () => {
    const input = { name: "New Name" };
    await communityRepository.updateCommunity("c1", input);

    expect(input).not.toHaveProperty("normalizedName");
  });
});
