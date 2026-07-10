import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { refreshQuoteDataForParent } from "./quote-refresh.js";

describe("refreshQuoteDataForParent", () => {
  it("issues one multi-update $set-ing only the patched dot-paths", async () => {
    const calls: Record<string, unknown>[] = [];
    const prisma = {
      $runCommandRaw: async (cmd: Record<string, unknown>) => {
        calls.push(cmd);
        return {};
      },
    };
    await refreshQuoteDataForParent(prisma, "private_messages", "p1", {
      isDeleted: true,
    });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], {
      update: "private_messages",
      updates: [
        {
          q: { parentMessageId: "p1" },
          u: { $set: { "quoteData.isDeleted": true } },
          multi: true,
        },
      ],
    });
  });

  it("$sets both preview and isDeleted when both are patched", async () => {
    const calls: Record<string, unknown>[] = [];
    const prisma = {
      $runCommandRaw: async (cmd: Record<string, unknown>) => {
        calls.push(cmd);
        return {};
      },
    };
    await refreshQuoteDataForParent(prisma, "group_messages", "p2", {
      preview: "new text",
      isDeleted: false,
    });
    const update = calls[0]!.updates as Array<{ u: { $set: unknown } }>;
    assert.deepEqual(update[0]!.u.$set, {
      "quoteData.preview": "new text",
      "quoteData.isDeleted": false,
    });
  });

  it("is a no-op (no command issued) when the patch is empty", async () => {
    let called = false;
    const prisma = {
      $runCommandRaw: async () => {
        called = true;
        return {};
      },
    };
    await refreshQuoteDataForParent(prisma, "general_room_messages", "p3", {});
    assert.equal(called, false);
  });
});
