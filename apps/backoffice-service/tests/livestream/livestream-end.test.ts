import { GrpcLivestreamRepository } from "../../src/repositories/livestream.repository.js";
import { streamClient } from "../../src/grpc/stream.client.js";

const stream = streamClient as unknown as Record<string, jest.Mock>;
const repo = new GrpcLivestreamRepository();
const actor = { admin: { id: "admin-1", name: "Super Admin" }, at: 1_700_000_000_000 };
const input = { reasonCode: "MANUAL_ADMIN" as const };

describe("GrpcLivestreamRepository.end", () => {
  it.each(["LIVE", "RECONNECTING", "PENDING"])(
    "force-ends exactly the requested %s stream",
    async (status) => {
      stream.adminGetStream.mockResolvedValueOnce({ id: "s-2", status });
      stream.adminForceEnd.mockResolvedValueOnce({ success: true, status: "ENDED" });

      const result = await repo.end("s-2", input, actor);

      expect(stream.adminForceEnd).toHaveBeenCalledTimes(1);
      expect(stream.adminForceEnd).toHaveBeenCalledWith("s-2", "MANUAL_ADMIN");
      expect(result).toMatchObject({ livestreamId: "s-2", status: "ENDED" });
    }
  );

  it("rejects an already-ended stream without calling stream-service", async () => {
    stream.adminGetStream.mockResolvedValueOnce({ id: "s-2", status: "ENDED" });

    await expect(repo.end("s-2", input, actor)).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(stream.adminForceEnd).not.toHaveBeenCalled();
  });

  it("rejects the admin who loses the end race", async () => {
    stream.adminGetStream.mockResolvedValueOnce({ id: "s-2", status: "LIVE" });
    stream.adminForceEnd.mockResolvedValueOnce({ success: false, status: "ENDED" });

    await expect(repo.end("s-2", input, actor)).rejects.toMatchObject({
      statusCode: 409,
    });
  });
});
