import type { Socket } from 'socket.io';
import { verifyToken } from '../services/auth.service.js';

// Socket.IO middleware: validates a JWT supplied in the handshake `auth` payload
// and attaches the resolved user id + username to `socket.data`.
export function socketAuth(socket: Socket, next: (err?: Error) => void) {
  const token = socket.handshake.auth?.token as string | undefined;
  if (!token) return next(new Error('missing_token'));

  try {
    const payload = verifyToken(token);
    socket.data.userId = payload.sub;
    socket.data.username = payload.username;
    return next();
  } catch {
    return next(new Error('invalid_token'));
  }
}
