/**
 * Resource-driven download authorization (authorizeMediaAccess).
 *
 * The registry repository and the chat-service membership gRPC client are mocked
 * globally (tests/setup/global-mocks.ts); these tests drive the registry record
 * and the membership verdict to exercise each policy branch.
 */
import { mediaFileRepository } from "../../src/repositories/media-file.repository.js";
import { getChatAccessClient } from "../../src/grpc/clients/chat-access.client.js";
import { authorizeMediaAccess } from "../../src/lib/download-authz.js";

const mockFind = jest.mocked(mediaFileRepository.findByObjectKey);
const mockCheck = jest.mocked(getChatAccessClient().checkMediaAccess);

// Minimal registry-record shape the authz reads (cast away the full model).
const record = (over: Record<string, unknown>) =>
  over as unknown as Awaited<
    ReturnType<typeof mediaFileRepository.findByObjectKey>
  >;

beforeEach(() => {
  jest.clearAllMocks();
  mockCheck.mockResolvedValue(true);
});

describe("authorizeMediaAccess — registry-bound", () => {
  it("PUBLIC (USER_AVATAR): any authenticated user is allowed, no membership call", async () => {
    mockFind.mockResolvedValue(
      record({ resourceType: "USER_AVATAR", ownerId: "u1", resourceId: "u1" })
    );
    await expect(
      authorizeMediaAccess({
        objectKey: "avatars/u1/x.jpg",
        category: "USER_AVATAR",
        requesterId: "u2",
      })
    ).resolves.toBeUndefined();
    expect(mockCheck).not.toHaveBeenCalled();
  });

  it("PRIVATE_CHAT: a participant (gRPC allowed) can download — closes the recipient gap (P2)", async () => {
    mockFind.mockResolvedValue(
      record({
        resourceType: "PRIVATE_CHAT_DOCUMENT",
        ownerId: "u1",
        resourceId: "room1",
      })
    );
    mockCheck.mockResolvedValue(true);
    await expect(
      authorizeMediaAccess({
        objectKey: "chat-uploads/u1/x.pdf",
        category: "CHAT_ATTACHMENT",
        requesterId: "u2",
      })
    ).resolves.toBeUndefined();
    expect(mockCheck).toHaveBeenCalledWith({
      userId: "u2",
      scope: "PRIVATE_CHAT",
      resourceId: "room1",
    });
  });

  it("COMMUNITY_CHAT: a non-member (gRPC denied) is Forbidden — closes the IDOR (P1)", async () => {
    mockFind.mockResolvedValue(
      record({
        resourceType: "COMMUNITY_CHAT_IMAGE",
        ownerId: "u1",
        resourceId: "comm1",
      })
    );
    mockCheck.mockResolvedValue(false);
    await expect(
      authorizeMediaAccess({
        objectKey: "community-chat-uploads/u1/x.jpg",
        category: "COMMUNITY_CHAT_ATTACHMENT",
        requesterId: "u2",
      })
    ).rejects.toThrow();
    expect(mockCheck).toHaveBeenCalledWith({
      userId: "u2",
      scope: "COMMUNITY_CHAT",
      resourceId: "comm1",
    });
  });

  it("the uploader can always fetch their own chat object without a membership round-trip", async () => {
    mockFind.mockResolvedValue(
      record({
        resourceType: "GROUP_CHAT_VIDEO",
        ownerId: "u1",
        resourceId: "g1",
      })
    );
    await expect(
      authorizeMediaAccess({
        objectKey: "group-chat-uploads/u1/x.mp4",
        category: "GROUP_CHAT_ATTACHMENT",
        requesterId: "u1",
      })
    ).resolves.toBeUndefined();
    expect(mockCheck).not.toHaveBeenCalled();
  });

  it("no registry row → legacy ownership check (private chat is owner-only)", async () => {
    mockFind.mockResolvedValue(null);
    await expect(
      authorizeMediaAccess({
        objectKey: "chat-uploads/u1/x.pdf",
        category: "CHAT_ATTACHMENT",
        requesterId: "u1",
      })
    ).resolves.toBeUndefined();
    await expect(
      authorizeMediaAccess({
        objectKey: "chat-uploads/u1/x.pdf",
        category: "CHAT_ATTACHMENT",
        requesterId: "u2",
      })
    ).rejects.toThrow();
  });
});
