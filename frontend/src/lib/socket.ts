import { io, Socket } from 'socket.io-client';

const SOCKET_URL = import.meta.env.VITE_SOCKET_URL ?? 'http://localhost:8080';

let socket: Socket | null = null;

export function connectSocket(token: string): Socket {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
  socket = io(SOCKET_URL, {
    auth: { token },
    transports: ['websocket', 'polling'],
  });
  return socket;
}

export function getSocket(): Socket | null {
  return socket;
}

export function disconnectSocket(): void {
  socket?.disconnect();
  socket = null;
}
