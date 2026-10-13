// §5: signal loss waits 120s (SRS and CDN) before the sweeper ends a stream.
it("reconnect grace windows default to 120s", () => {
  delete process.env.STREAM_RECONNECT_GRACE_MS;
  delete process.env.STREAM_CDN_RECONNECT_GRACE_MS;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { env } = require("../src/config/env.js");
    expect(env.STREAM_RECONNECT_GRACE_MS).toBe(120_000);
    expect(env.STREAM_CDN_RECONNECT_GRACE_MS).toBe(120_000);
  });
});
