import { Router } from "express";

export const healthRouter: Router = Router();

healthRouter.get("/", (_, res) => {
  res.json({
    success: true,
    message: "API Gateway Running",
  });
});
