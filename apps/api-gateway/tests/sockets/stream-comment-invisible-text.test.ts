import { StreamCommentSchema } from "../../src/sockets/namespaces/stream.ns.js";

describe("stream:comment payload", () => {
  it.each(["", "   ", "\t\n", "​‍", "⠀", "ㅤ", " ​⠀﻿　 "])(
    "rejects visually blank message %j",
    (message) => {
      expect(StreamCommentSchema.safeParse({ streamId: "s-1", message }).success).toBe(false);
    }
  );

  it.each(["hi", "สวัสดี", "👍", "​ok"])("accepts %j", (message) => {
    expect(StreamCommentSchema.safeParse({ streamId: "s-1", message }).success).toBe(true);
  });
});
