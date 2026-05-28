import { NextFunction, Request, Response } from "express";
import { v4 as uuid } from "uuid";

export function requestIdMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const requestId = uuid();

  req.headers["x-request-id"] = requestId;

  res.setHeader("x-request-id", requestId);

  next();
}
