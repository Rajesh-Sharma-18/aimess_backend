import winston, { type Logger } from "winston";

const npmLevels = winston.config.npm.levels;

const validLevels = new Set(Object.keys(npmLevels));

/**
 * `LOG_LEVEL` overrides everything when set to a valid npm level
 * (`error`, `warn`, `info`, `http`, `verbose`, `debug`, `silly`).
 * Use `silly` or `debug` for maximum verbosity in development.
 */
function resolveLevel(): string {
  const fromEnv = process.env.LOG_LEVEL?.toLowerCase().trim();
  if (fromEnv && validLevels.has(fromEnv)) {
    return fromEnv;
  }
  return process.env.NODE_ENV === "production" ? "info" : "debug";
}

const isProduction = process.env.NODE_ENV === "production";

const consoleFormat = winston.format.combine(
  winston.format.errors({ stack: true }),
  winston.format.splat(),
  winston.format.metadata({
    fillExcept: ["message", "level", "timestamp", "stack"],
  }),
  winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
  winston.format.colorize({ all: true }),
  winston.format.printf((info) => {
    const { timestamp, level, message, stack, metadata } = info;
    const meta =
      metadata &&
      typeof metadata === "object" &&
      Object.keys(metadata).length > 0
        ? ` ${JSON.stringify(metadata)}`
        : "";
    if (stack) {
      return `[${timestamp}] ${level}: ${stack}${meta}`;
    }
    const text =
      typeof message === "string" ? message : JSON.stringify(message);
    return `[${timestamp}] ${level}: ${text}${meta}`;
  })
);

const productionFormat = winston.format.combine(
  winston.format.errors({ stack: true }),
  winston.format.splat(),
  winston.format.timestamp(),
  winston.format.json()
);

/**
 * Shared Winston logger for all services. Supports every npm severity:
 * `error`, `warn`, `info`, `http`, `verbose`, `debug`, `silly`.
 *
 * @example
 * logger.error("payment failed", { orderId: "123" });
 * logger.warn("retrying", { attempt: 2 });
 * logger.info("user signed in %s", userId);
 * logger.http("GET /health 200");
 * logger.verbose("cache miss", { key });
 * logger.debug("payload", { body });
 * logger.silly("entering handler");
 */
export const logger: Logger = winston.createLogger({
  levels: npmLevels,
  level: resolveLevel(),
  format: isProduction ? productionFormat : consoleFormat,
  transports: [new winston.transports.Console()],
});

/** Attach default fields (e.g. `{ service: "auth-service" }`) to every line. */
export function createChildLogger(
  defaultMeta: Record<string, unknown>
): Logger {
  return logger.child(defaultMeta);
}

export type { Logger } from "winston";
