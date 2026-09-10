import { PrismaClient } from "./src/generated/prisma/index.js";
import { env } from "./src/config/env.js";
const prisma = new PrismaClient({ datasourceUrl: env.MONGO_DATABASE_URL });
const total = await prisma.mediaFile.count();
const e2ee = await prisma.mediaFile.count({ where: { objectKey: { startsWith: "e2ee-" } } });
const rows = await prisma.mediaFile.findMany({ where: { objectKey: { startsWith: "e2ee-" } }, take: 3 });
console.log({ total, e2ee });
console.log(rows.map(r => ({ objectKey: r.objectKey, resourceType: r.resourceType, resourceId: r.resourceId, ownerId: r.ownerId, scanStatus: r.scanStatus, contentType: r.contentType })));
await prisma.$disconnect();
