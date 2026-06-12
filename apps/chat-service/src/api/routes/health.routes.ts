import { Router, type Router as RouterType } from "express";

const router = Router();

router.get("/health", (_req, res) => {
  res.status(200).json({
    success: true,
    service: "chat-service",
    timestamp: new Date().toISOString(),
  });
});

export const healthRoutes: RouterType = router;
