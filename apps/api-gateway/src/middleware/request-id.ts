import { NextFunction, Request, Response } from "express";
import { v4 as uuid } from "uuid";

/**
 * Accepts an id the client generated so a trace starts in the browser rather
 * than at the edge. Constrained on purpose: the value is echoed into response
 * headers, log lines and error bodies, so an unbounded attacker-controlled
 * string would be a header-injection and log-forging vector. UUIDs, ULIDs and
 * the frontend's own ids all satisfy this.
 */
const VALID_REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;

export function requestIdMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const inbound = req.headers["x-request-id"];
  const candidate = Array.isArray(inbound) ? inbound[0] : inbound;

  // Previously this always overwrote the inbound header, so a client-side id
  // could never be correlated with the server's view of the same request.
  const requestId =
    typeof candidate === "string" && VALID_REQUEST_ID.test(candidate)
      ? candidate
      : uuid();

  req.headers["x-request-id"] = requestId;

  res.setHeader("x-request-id", requestId);

  next();
}
