import express from "express";
import request from "supertest";

import { isCloudflareIp, resolveForwardedIp, trustProxyHops } from "../src/client-ip";

describe("client ip behind nginx + Cloudflare", () => {
  it("knows Cloudflare edges seen on sessions", () => {
    ["172.70.108.206", "162.159.98.168", "162.158.108.128", "2606:4700::1"].forEach((ip) =>
      expect(isCloudflareIp(ip)).toBe(true)
    );
    expect(isCloudflareIp("49.36.10.20")).toBe(false);
  });

  it("skips nginx and the Cloudflare edge, never a forged entry", () => {
    expect(resolveForwardedIp("10.0.0.2", "49.36.10.20, 172.70.108.206", 1)).toBe("49.36.10.20");
    expect(resolveForwardedIp("10.0.0.2", "6.6.6.6, 49.36.10.20, 172.70.108.206", 1)).toBe("49.36.10.20");
    expect(resolveForwardedIp("10.0.0.2", "6.6.6.6, 49.36.10.20", 1)).toBe("49.36.10.20");
  });

  it("ignores the chain when no proxy is configured", () => {
    expect(resolveForwardedIp("172.70.108.206", "49.36.10.20", 0)).toBe("172.70.108.206");
  });

  it("drives Express req.ip the same way", async () => {
    const app = express();
    app.set("trust proxy", trustProxyHops(1));
    app.get("/", (req, res) => res.send(req.ip));
    const res = await request(app).get("/").set("X-Forwarded-For", "49.36.10.20, 172.70.108.206");
    expect(res.text).toBe("49.36.10.20");
  });
});
