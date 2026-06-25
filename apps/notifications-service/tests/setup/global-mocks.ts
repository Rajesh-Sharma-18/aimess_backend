/**
 * Global I/O-boundary mocks for notifications-service, applied to every test
 * file (Jest `setupFilesAfterEnv`). These are the seams that must NEVER touch
 * real infrastructure or pull in ESM-only / native libs that CommonJS-mode Jest
 * cannot `require`. Per-test files may re-`jest.mock()` any of these to inject
 * richer behaviour for a specific scenario (a test-file mock overrides this one).
 *
 * `jest` is the Jest-injected global (typed by @types/jest); not importing it
 * keeps `jest.mock` hoisting maximally reliable under ts-jest.
 *
 * NOTE: `src/app.ts`'s import graph only reaches `config/prisma.js` as real I/O
 * (health.routes + device.routes → device.controller → device-token.service →
 * device-token.repository → config/prisma). `config/prisma.ts` imports
 * `../generated/prisma/index.js` (the Prisma-7 native client) at module load, so
 * it MUST be mocked. The remaining seams (redis, gRPC client factories, firebase
 * admin, mail transporter) are reached only by the consumer / push / settings
 * paths — pre-mocked here so any future spec that pulls them never hits real
 * infra or an ESM-only native lib.
 */

// --- Datastore (MongoDB via Prisma 7): never open a real connection ----------
//     prisma.ts imports the generated native client at load; this keeps it out.
jest.mock("../../src/config/prisma.js", () => ({
  prisma: {},
  connectDatabase: jest.fn(async () => undefined),
  disconnectDatabase: jest.fn(async () => undefined),
}));

// --- Redis (ioredis settings cache): never open a real connection ------------
jest.mock("../../src/config/redis.js", () => ({
  redis: {
    status: "ready",
    on: jest.fn(),
    once: jest.fn(),
    off: jest.fn(),
    get: jest.fn(async () => null),
    set: jest.fn(async () => "OK"),
    del: jest.fn(async () => 0),
  },
}));

// --- Outbound gRPC client factories (opossum-wrapped @grpc/grpc-js): stubs ----
jest.mock("../../src/grpc/user-settings.client.js", () => ({
  createUserSettingsClient: jest.fn(() => ({
    getNotificationSettings: jest.fn(),
  })),
}));
jest.mock("../../src/grpc/chat-notification.client.js", () => ({
  createChatNotificationClient: jest.fn(() => ({
    createNotification: jest.fn(),
  })),
}));
// community.client.js uses import.meta.url at module load (proto path) which the
// CJS-mode Jest cannot evaluate — stub the seam. Default is fail-open (not muted)
// so suppression specs must explicitly re-mock to assert the muted path.
jest.mock("../../src/grpc/community.client.js", () => ({
  createCommunityClient: jest.fn(() => ({
    checkCommunityMute: jest.fn(async () => ({
      isMuted: false,
      mutedUntil: 0,
    })),
  })),
  communityClient: {
    checkCommunityMute: jest.fn(async () => ({
      isMuted: false,
      mutedUntil: 0,
    })),
  },
}));

// --- Firebase Admin (pulls native/ESM firebase-admin at import) --------------
//     Mocking the thin wrapper keeps the real SDK out of the CJS require graph.
jest.mock("../../src/providers/firebase/firebase.js", () => ({
  messaging: { send: jest.fn(), sendEachForMulticast: jest.fn() },
}));

// --- Mail transporter (nodemailer): no real SMTP transport ------------------
jest.mock("../../src/providers/mail/transporter.js", () => ({
  transporter: { sendMail: jest.fn(async () => ({ messageId: "test" })) },
}));

export {};
