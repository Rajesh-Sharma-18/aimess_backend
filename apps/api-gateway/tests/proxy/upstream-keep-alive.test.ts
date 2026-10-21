import http, { type AddressInfo } from "node:http";

import express from "express";

import { createServiceProxy } from "../../src/proxy/create-service-proxy.js";

const listen = (server: http.Server) =>
  new Promise<number>((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve((server.address() as AddressInfo).port)
    )
  );

describe("service proxy upstream connections", () => {
  let upstream: http.Server;
  let gateway: http.Server;
  let gatewayPort: number;
  let connections = 0;
  const connectionHeaders: Array<string | undefined> = [];

  beforeAll(async () => {
    upstream = http.createServer((req, res) => {
      connectionHeaders.push(req.headers.connection);
      res.end("ok");
    });
    upstream.on("connection", () => connections++);
    const upstreamPort = await listen(upstream);

    const app = express();
    app.use(
      "/api/v1/chat",
      createServiceProxy({
        target: `http://127.0.0.1:${upstreamPort}`,
        downstreamPrefix: "/api/chat",
        serviceName: "chat",
      })
    );
    gateway = http.createServer(app);
    gatewayPort = await listen(gateway);
  });

  afterAll(async () => {
    upstream.closeAllConnections();
    gateway.closeAllConnections();
    await Promise.all(
      [upstream, gateway].map((s) => new Promise((r) => s.close(r)))
    );
  });

  it("reuses one pooled upstream socket instead of connecting per request", async () => {
    for (let i = 0; i < 3; i++) {
      const res = await fetch(
        `http://127.0.0.1:${gatewayPort}/api/v1/chat/unread-summary`
      );
      expect(await res.text()).toBe("ok");
    }
    expect(connections).toBe(1);
    expect(connectionHeaders).not.toContain("close");
  });
});
