import {
  toLoginAccountPreview,
  type UserSnapshot,
} from "../../src/lib/login-account-preview.js";

const snapshot = (overrides: Partial<UserSnapshot> = {}): UserSnapshot => ({
  userId: "u1",
  username: "tom",
  displayName: "Tom Hardy",
  firstName: "Tom",
  lastName: "Hardy",
  avatarObjectKey: "avatars/u1.jpg",
  avatarUrl: "https://minio.local/avatars/u1.jpg?sig",
  isDeleted: false,
  isSuspended: false,
  ...overrides,
});

describe("toLoginAccountPreview", () => {
  it("maps name + avatar, never the user id", () => {
    expect(toLoginAccountPreview(snapshot())).toEqual({
      displayName: "Tom Hardy",
      firstName: "Tom",
      lastName: "Hardy",
      username: "tom",
      avatarUrl: "https://minio.local/avatars/u1.jpg?sig",
      avatarObjectKey: "avatars/u1.jpg",
    });
  });

  it("no avatar -> nulls", () => {
    expect(
      toLoginAccountPreview(snapshot({ avatarUrl: "", avatarObjectKey: "" }))
    ).toMatchObject({ avatarUrl: null, avatarObjectKey: null });
  });

  it.each([
    ["deleted", snapshot({ isDeleted: true })],
    ["suspended/banned", snapshot({ isSuspended: true })],
    ["not found", undefined],
  ])("%s -> null", (_label, user) => {
    expect(toLoginAccountPreview(user)).toBeNull();
  });
});
