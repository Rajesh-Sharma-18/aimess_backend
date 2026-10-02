import path from "node:path";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { logger } from "@aimess/logger";
import { makeBreaker, makeGrpcCall } from "@aimess/grpc-utils";

import { env } from "../config/env.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = path.resolve(
  __dirname,
  "../../../../packages/grpc-contracts/proto/backoffice.proto"
);

const CACHE_TTL_MS = 60_000;

type CredentialPlatform = "ANDROID" | "IOS" | "WEB";
type ListResponse = { credentials?: { name: string; value: string }[] };

let breaker: ReturnType<typeof makeBreaker<string, ListResponse>> | null = null;
const cache = new Map<CredentialPlatform, { value: Record<string, string>; expiresAt: number }>();

function getBreaker() {
  if (!breaker) {
    const pkgDef = protoLoader.loadSync(PROTO_PATH, {
      keepCase: false,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true,
    });
    const proto = grpc.loadPackageDefinition(pkgDef) as grpc.GrpcObject;
    const ServiceCtor = (proto["backoffice"] as grpc.GrpcObject)[
      "BackofficeService"
    ] as grpc.ServiceClientConstructor;
    const client = new ServiceCtor(env.BACKOFFICE_GRPC_URL, grpc.credentials.createInsecure());
    breaker = makeBreaker(
      "backoffice.listCustomCredentials",
      (platform: string) =>
        makeGrpcCall<{ platform: string }, ListResponse>(client, "listCustomCredentials", {
          platform,
        }),
      { timeout: 2000 }
    );
  }
  return breaker;
}

export function credentialPlatformFor(header: string | undefined): CredentialPlatform {
  const normalized = header?.trim().toLowerCase();
  if (normalized === "android") return "ANDROID";
  if (normalized === "ios") return "IOS";
  return "WEB";
}

export async function listCustomCredentials(
  platform: CredentialPlatform
): Promise<Record<string, string>> {
  const cached = cache.get(platform);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  try {
    const res = await getBreaker().fire(platform);
    const value = Object.fromEntries((res.credentials ?? []).map((c) => [c.name, c.value]));
    cache.set(platform, { value, expiresAt: Date.now() + CACHE_TTL_MS });
    return value;
  } catch (error) {
    logger.warn(`backoffice.listCustomCredentials failed: ${String(error)}`);
    return cached?.value ?? {};
  }
}
