import jwt from "jsonwebtoken";
import bcrypt from "bcrypt";
import type { Request, Response, NextFunction } from "express";

const JWT_SECRET: string = (() => {
  const secret = process.env.JWT_SECRET || process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error("JWT_SECRET or SESSION_SECRET environment variable is required");
  }
  return secret;
})();
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || JWT_SECRET + "-refresh";

const ACCESS_TOKEN_EXPIRY = "15m";
const REFRESH_TOKEN_EXPIRY = "30d";
export const REFRESH_TOKEN_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const ACCESS_TOKEN_EXPIRY_SECONDS = 900; // 15 minutes

export interface TokenPayload {
  userId: string;
  isVendor: boolean;
  isPhotographer?: boolean;
  isAdmin?: boolean;
  businessId?: string;
  photographerId?: string;
}

export interface AuthenticatedRequest extends Request {
  user?: TokenPayload;
}

export async function hashPassword(password: string): Promise<string> {
  const saltRounds = 10;
  return bcrypt.hash(password, saltRounds);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export function generateAccessToken(payload: TokenPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: ACCESS_TOKEN_EXPIRY });
}

export function generateRefreshToken(payload: TokenPayload): string {
  return jwt.sign(payload, JWT_REFRESH_SECRET, { expiresIn: REFRESH_TOKEN_EXPIRY });
}

export function verifyAccessToken(token: string): TokenPayload | null {
  try {
    return jwt.verify(token, JWT_SECRET) as TokenPayload;
  } catch (error) {
    return null;
  }
}

export function verifyRefreshToken(token: string): TokenPayload | null {
  try {
    return jwt.verify(token, JWT_REFRESH_SECRET) as TokenPayload;
  } catch (error) {
    return null;
  }
}

export function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const authReq = req as AuthenticatedRequest;
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ 
      success: false, 
      error: { 
        code: "NO_TOKEN", 
        message: "Authorization token required" 
      } 
    });
  }
  
  const token = authHeader.substring(7);
  const payload = verifyAccessToken(token);
  
  if (!payload) {
    return res.status(401).json({ 
      success: false, 
      error: { 
        code: "TOKEN_INVALID", 
        message: "Invalid or expired token" 
      } 
    });
  }
  
  authReq.user = payload;
  next();
}

export function optionalAuthMiddleware(req: Request, res: Response, next: NextFunction) {
  const authReq = req as AuthenticatedRequest;
  const authHeader = req.headers.authorization;
  
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.substring(7);
    const payload = verifyAccessToken(token);
    if (payload) {
      authReq.user = payload;
    }
  }
  
  next();
}

/**
 * Hybrid auth middleware - accepts EITHER JWT (Authorization header) OR session cookies
 * Use this for endpoints that need to work with both mobile (JWT) and web (session) clients
 * 
 * If JWT is present and valid, sets req.user with token payload AND req.session.userId
 * If no JWT, falls back to existing session-based auth
 * Returns 401 only if NEITHER JWT nor session is valid
 */
export function hybridAuthMiddleware(req: Request, res: Response, next: NextFunction) {
  const authReq = req as AuthenticatedRequest;
  const authHeader = req.headers.authorization;
  
  // First try JWT authentication
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.substring(7);
    const payload = verifyAccessToken(token);
    if (payload) {
      authReq.user = payload;
      // Also set session userId for compatibility with existing code
      if (req.session) {
        req.session.userId = payload.userId;
      }
      return next();
    }
    // Invalid JWT - return 401 immediately
    return res.status(401).json({ 
      success: false, 
      error: { 
        code: "TOKEN_INVALID", 
        message: "Invalid or expired token" 
      } 
    });
  }
  
  // Fall back to session-based auth
  if (req.session?.userId) {
    return next();
  }
  
  // Neither JWT nor session - return 401
  return res.status(401).json({ 
    success: false, 
    error: { 
      code: "NO_AUTH", 
      message: "Authentication required" 
    } 
  });
}

/**
 * Helper function to get userId from request (JWT or session)
 * Use this in route handlers when you need the userId but don't want middleware
 */
export function getUserIdFromRequest(req: Request): string | null {
  // First try JWT authentication
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.substring(7);
    const payload = verifyAccessToken(token);
    if (payload) {
      return payload.userId;
    }
  }
  
  // Fall back to session
  return req.session?.userId || null;
}
