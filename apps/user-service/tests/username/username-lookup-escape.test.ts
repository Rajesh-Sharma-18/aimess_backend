/**
 * `findByUsername` runs Prisma's `mode: "insensitive"`, which is an ILIKE: `_`
 * (legal in every username) and `%` are wildcards there. Unescaped, "test_c"
 * matched "testxc" and was reported taken. Verified against Postgres: with the
 * backslash escape, 'testxc' ILIKE 'test\_c' is false and 'TEST_C' is true.
 */
const findFirst = jest.fn(async () => null);

jest.mock("../../src/config/prisma.js", () => ({
  prisma: { userProfile: { findFirst } },
}));

import { userProfileRepository } from "../../src/repositories/user-profile.repository.js";

describe("userProfileRepository.findByUsername", () => {
  it.each([
    ["Test_C", "test\\_c"],
    ["  RAJESH_SHARMA ", "rajesh\\_sharma"],
    ["a%b", "a\\%b"],
    ["plain", "plain"],
  ])("looks up %j as the escaped canonical pattern %j", async (input, pattern) => {
    await userProfileRepository.findByUsername(input);

    expect(findFirst).toHaveBeenLastCalledWith({
      where: { username: { equals: pattern, mode: "insensitive" } },
    });
  });
});
