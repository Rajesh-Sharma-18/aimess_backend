import rateLimit from "express-rate-limit";

// Runs after authenticateAccessToken on every route, so req.auth is always
// populated here; userId/sessionId fallback to req.ip only guards against
// future routes that mount this limiter without auth.
export const mediaRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req) => req.auth?.userId ?? req.auth?.sessionId ?? req.ip,
  message: {
    success: false,
    message: "Too many requests, please try again later.",
  },
});
