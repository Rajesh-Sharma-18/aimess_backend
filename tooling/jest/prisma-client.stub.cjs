/**
 * Universal stub for every service's generated Prisma client
 * (`src/generated/prisma/client.js`).
 *
 * Why: Prisma 7's `prisma-client` generator emits an ESM module that runs
 * `import.meta.url` at top level, which CommonJS-mode Jest cannot parse. Tests
 * mock the repository layer, so the real client is never needed for queries —
 * only two things are consumed as runtime values:
 *   1. the `Prisma` namespace (notably `Prisma.PrismaClientKnownRequestError`,
 *      used by error handlers for `instanceof` checks), and
 *   2. string enums (e.g. `AccountStatus.ACTIVE`).
 *
 * Prisma string enums equal their own member name, so an enum access is stubbed
 * by echoing the key: `AccountStatus.ACTIVE === "ACTIVE"`. This makes the stub
 * service-agnostic — it needs no knowledge of any particular schema's enums.
 *
 * A test that wants to simulate a known DB error can throw
 * `new Prisma.PrismaClientKnownRequestError("...", { code: "P2002" })`.
 */

class PrismaClientKnownRequestError extends Error {
  constructor(message, opts = {}) {
    super(message);
    this.name = "PrismaClientKnownRequestError";
    this.code = opts.code;
    this.meta = opts.meta;
    this.clientVersion = opts.clientVersion ?? "test";
  }
}
class PrismaClientValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "PrismaClientValidationError";
  }
}
class PrismaClientUnknownRequestError extends Error {}
class PrismaClientInitializationError extends Error {}
class PrismaClientRustPanicError extends Error {}

const Prisma = {
  PrismaClientKnownRequestError,
  PrismaClientValidationError,
  PrismaClientUnknownRequestError,
  PrismaClientInitializationError,
  PrismaClientRustPanicError,
  JsonNull: Symbol("Prisma.JsonNull"),
  DbNull: Symbol("Prisma.DbNull"),
  AnyNull: Symbol("Prisma.AnyNull"),
  skip: Symbol("Prisma.skip"),
  sql: (strings, ...values) => ({ strings, values }),
  raw: (value) => ({ raw: value }),
  join: (values, separator) => ({ join: values, separator }),
  empty: { sql: "" },
};

class PrismaClient {
  $connect() {
    return Promise.resolve();
  }
  $disconnect() {
    return Promise.resolve();
  }
  $transaction(arg) {
    return typeof arg === "function" ? arg(this) : Promise.all(arg);
  }
  $on() {}
  $use() {}
  $extends() {
    return this;
  }
  $queryRaw() {
    return Promise.resolve([]);
  }
  $executeRaw() {
    return Promise.resolve(0);
  }
}

// Any property not explicitly defined is treated as a string enum whose members
// echo their own name (matching Prisma's string-enum runtime representation).
const enumLike = () =>
  new Proxy(
    {},
    { get: (_t, key) => (typeof key === "string" ? key : undefined) }
  );

module.exports = new Proxy(
  { Prisma, PrismaClient },
  {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (prop === "__esModule") return true;
      if (prop === "default") return module.exports;
      if (typeof prop === "symbol") return undefined;
      return enumLike();
    },
  }
);
