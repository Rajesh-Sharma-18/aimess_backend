// A peer who blocked the viewer keeps their name in the inbox but not their photo.
import request from "supertest";

jest.mock("../../src/grpc/auth.client.js", () => ({
  authGrpcClient: { bulkGetAccounts: jest.fn(async () => []) },
}));

import { buildApp, type BuiltMocks } from "../helpers/app-factory.js";
import { bearer, makeAccessToken, TEST_USER_ID } from "../helpers/auth.js";
import { fetchUsersBatch } from "../../src/lib/user-service-client.js";

const PEER = "22222222-2222-4222-8222-222222222222";
let app: import("express").Express;
let mocks: BuiltMocks;

const room = (blockedBy: string[]) => ({
  roomId: "prv_1",
  participants: [TEST_USER_ID, PEER],
  lastMessageAt: new Date(1000),
  lastMessage: null,
  unreadCountByUser: { [TEST_USER_ID]: 0 },
  mutedBy: {},
  pinnedCount: 0,
  blockedBy,
});

beforeEach(() => {
  ({ app, mocks } = buildApp());
  mocks.cacheRepo.getUserSnapshots.mockResolvedValue(new Map());
  mocks.privateRoomRepo.countConversations.mockResolvedValue(1);
  (fetchUsersBatch as jest.Mock).mockResolvedValue([
    { userId: PEER, displayName: "Neel Sheth", username: "neel", avatar: "avatars/neel.jpg", isOnline: false, isDeleted: false },
    { userId: TEST_USER_ID, displayName: "Me", username: "me", avatar: "", isOnline: false, isDeleted: false },
  ]);
});

const list = async (blockedBy: string[]) => {
  mocks.privateRoomRepo.getInboxConversations.mockResolvedValue([room(blockedBy)]);
  const res = await request(app)
    .get("/api/chat/private/conversations")
    .set(bearer(makeAccessToken()));
  expect(res.status).toBe(200);
  return res.body.data.data[0];
};

describe("inbox peer avatar under a block", () => {
  it("shows the photo when nobody blocked", async () => {
    expect(JSON.stringify(await list([]))).toContain("avatars/neel.jpg");
  });

  it("hides the photo when the peer blocked the viewer; name stays", async () => {
    const row = await list([PEER]);
    expect(JSON.stringify(row)).not.toContain("avatars/neel.jpg");
    expect(row.displayName).toBe("Neel Sheth");
  });

  it("keeps the photo when only the viewer blocked the peer", async () => {
    expect(JSON.stringify(await list([TEST_USER_ID]))).toContain("avatars/neel.jpg");
  });
});
