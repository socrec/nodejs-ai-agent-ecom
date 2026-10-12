// Mock auth: x-org-id (store), x-session-id (shopper), x-user-id (operator console). Swap-in: Clerk/JWT.
import type { NextFunction, Request, Response } from "express";

export type ReqCtx = { orgId: string; sessionId: string; userId?: string };
declare global { namespace Express { interface Request { ctx: ReqCtx } } }

export function tenant(req: Request, res: Response, next: NextFunction) {
  const orgId = req.header("x-org-id") ?? "";
  if (!/^[a-z0-9_-]{1,40}$/.test(orgId)) return res.status(400).json({ error: "x-org-id header required" });
  const sessionId = (req.header("x-session-id") ?? "").slice(0, 80);
  req.ctx = { orgId, sessionId, userId: req.header("x-user-id") };
  next();
}

export function operatorOnly(req: Request, res: Response, next: NextFunction) {
  if (req.ctx.userId !== "operator") return res.status(403).json({ error: "operator only" });
  next();
}
