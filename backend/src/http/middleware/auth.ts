import type { Request, Response, NextFunction } from 'express';
import { verifyToken } from '../../services/auth.service.js';

// Express middleware: extracts a Bearer token from the Authorization header,
// verifies the JWT, and attaches the resolved user id + username to req.
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'missing_token' });
  }
  const token = header.slice('Bearer '.length).trim();

  try {
    const payload = verifyToken(token);
    req.userId = payload.sub;
    req.username = payload.username;
    return next();
  } catch {
    return res.status(401).json({ error: 'invalid_token' });
  }
}

// Augment the Express Request type so handlers can read req.userId without `as`.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId?: string;
      username?: string;
    }
  }
}
