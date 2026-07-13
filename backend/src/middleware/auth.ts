import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { LocalIdentityRepository } from "../lib/aletheia/localIdentity";

let localIdentityRepository: LocalIdentityRepository | null = null;

function identities() {
  if (!localIdentityRepository) {
    localIdentityRepository = new LocalIdentityRepository();
  }
  return localIdentityRepository;
}

function bearerToken(req: Request) {
  const auth = req.headers.authorization ?? "";
  if (!auth.startsWith("Bearer ")) return "";
  return auth.slice(7).trim();
}

function constantTimeTokenEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function setLocalAletheiaUser(res: Response, token: string) {
  res.locals.userId = process.env.ALETHEIA_LOCAL_USER_ID ?? "local-user";
  res.locals.userEmail =
    process.env.ALETHEIA_LOCAL_USER_EMAIL ?? "local@aletheia.internal";
  res.locals.token = token;
  res.locals.authKind = "bootstrap";
}

function setPrincipalAletheiaUser(
  res: Response,
  authentication: {
    principalId: string;
    email: string | null;
    tokenId: string;
  },
) {
  res.locals.userId = authentication.principalId;
  res.locals.userEmail = authentication.email ?? "";
  res.locals.token = "local-principal-token";
  res.locals.authKind = "principal_token";
  res.locals.principalTokenId = authentication.tokenId;
}

export function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!req.originalUrl.startsWith("/aletheia")) {
    res.status(404).json({ detail: "Route is outside the Aletheia API." });
    return;
  }

  const authMode =
    process.env.ALETHEIA_AUTH_MODE ?? process.env.ALET_HEIA_AUTH_MODE;
  if (authMode === "single_user") {
    setLocalAletheiaUser(res, "local-single-user");
    next();
    return;
  }

  if (authMode === "private_token") {
    const expected = process.env.ALETHEIA_PRIVATE_AUTH_TOKEN?.trim() ?? "";
    if (expected.length < 32) {
      res.status(500).json({
        detail:
          "Aletheia private token auth requires ALETHEIA_PRIVATE_AUTH_TOKEN with at least 32 characters.",
      });
      return;
    }
    const token = bearerToken(req);
    if (!token) {
      res.status(401).json({ detail: "Invalid Aletheia private token." });
      return;
    }
    if (constantTimeTokenEqual(token, expected)) {
      setLocalAletheiaUser(res, "local-private-token");
      next();
      return;
    }
    if (process.env.ALETHEIA_MULTI_PRINCIPAL_ENABLED === "true") {
      try {
        const principal = identities().authenticate(token);
        if (principal) {
          setPrincipalAletheiaUser(res, principal);
          next();
          return;
        }
      } catch {
        res.status(500).json({
          detail: "Local principal identity store is unavailable.",
        });
        return;
      }
    }
    res.status(401).json({ detail: "Invalid Aletheia private token." });
    return;
  }

  res.status(500).json({
    detail:
      "ALETHEIA_AUTH_MODE must be explicitly configured as single_user or private_token.",
  });
}
