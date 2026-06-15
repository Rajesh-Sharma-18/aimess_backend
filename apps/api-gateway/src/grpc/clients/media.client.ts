import path from "node:path";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { env } from "../../config/env.js";
import { makeBreaker, makeGrpcCall } from "@aimess/grpc-utils";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = path.resolve(
  __dirname,
  "../../../../../packages/grpc-contracts/proto/media.proto"
);

export interface GenerateUploadUrlGrpcParams {
  category: string;
  contentType: string;
  contentLength: number;
  ownerId: string;
}
export interface GenerateDownloadUrlGrpcParams {
  objectKey: string;
  category: string;
  requesterId: string;
}
export interface MediaObjectDto {
  fileId: string;
  objectKey: string;
  fileName: string;
  contentType: string;
  size: number;
  downloadUrl: string;
  downloadUrlExpiresIn: number;
  uploadUrl: string;
  uploadUrlExpiresIn: number;
  uploadHeaders: Record<string, string>;
}
export interface GenerateUploadUrlGrpcResult {
  uploadUrl: string;
  objectKey: string;
  expiresIn: number;
  maxBytes: number;
  media: MediaObjectDto;
}
export interface GenerateDownloadUrlGrpcResult {
  downloadUrl: string;
  expiresIn: number;
  media: MediaObjectDto;
}
export type MediaClient = {
  generateUploadUrl(
    p: GenerateUploadUrlGrpcParams
  ): Promise<GenerateUploadUrlGrpcResult | null>;
  generateDownloadUrl(
    p: GenerateDownloadUrlGrpcParams
  ): Promise<GenerateDownloadUrlGrpcResult | null>;
};

export function createMediaClient(): MediaClient {
  const pkgDef = protoLoader.loadSync(PROTO_PATH, {
    keepCase: false,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const proto = grpc.loadPackageDefinition(pkgDef) as grpc.GrpcObject;
  const ServiceCtor = (proto["media"] as grpc.GrpcObject)[
    "MediaService"
  ] as grpc.ServiceClientConstructor;

  const client = new ServiceCtor(
    env.MEDIA_GRPC_URL,
    grpc.credentials.createInsecure()
  );

  const call = <TReq, TRes>(method: string, req: TReq) =>
    makeGrpcCall<TReq, TRes>(client, method, req);

  const generateUploadUrlBreaker = makeBreaker(
    "media.generateUploadUrl",
    (p: GenerateUploadUrlGrpcParams) =>
      call<unknown, GenerateUploadUrlGrpcResult>("generateUploadUrl", {
        category: p.category,
        contentType: p.contentType,
        contentLength: p.contentLength,
        ownerId: p.ownerId,
      }).then((r) => ({
        ...r,
        expiresIn: Number(r.expiresIn),
        maxBytes: Number(r.maxBytes),
        media: {
          ...r.media,
          size: Number(r.media.size),
          downloadUrlExpiresIn: Number(r.media.downloadUrlExpiresIn),
          uploadUrlExpiresIn: Number(r.media.uploadUrlExpiresIn),
        },
      }))
  );

  const generateDownloadUrlBreaker = makeBreaker(
    "media.generateDownloadUrl",
    (p: GenerateDownloadUrlGrpcParams) =>
      call<unknown, GenerateDownloadUrlGrpcResult>("generateDownloadUrl", {
        objectKey: p.objectKey,
        category: p.category,
        requesterId: p.requesterId,
      }).then((r) => ({
        ...r,
        expiresIn: Number(r.expiresIn),
        media: {
          ...r.media,
          size: Number(r.media.size),
          downloadUrlExpiresIn: Number(r.media.downloadUrlExpiresIn),
          uploadUrlExpiresIn: Number(r.media.uploadUrlExpiresIn),
        },
      }))
  );

  return {
    generateUploadUrl: (p) =>
      generateUploadUrlBreaker.fire(p).catch(() => null),
    generateDownloadUrl: (p) =>
      generateDownloadUrlBreaker.fire(p).catch(() => null),
  };
}
