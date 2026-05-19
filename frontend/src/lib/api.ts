const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:8080';

async function request<T>(path: string, init: RequestInit = {}, token?: string): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body?.error ?? `request_failed_${res.status}`);
  }
  return body as T;
}

export type AuthResponse = {
  userId: string;
  username: string;
  email: string;
  publicKey: string;
  token: string;
};

export const api = {
  health: () => request<{ nodeId: string; uptime: number; db: string; redis: string }>('/health'),

  register: (input: { username: string; email: string; password: string; publicKey: string }) =>
    request<AuthResponse>('/auth/register', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  login: (input: { username: string; password: string }) =>
    request<AuthResponse>('/auth/login', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  getPublicKey: (userId: string) =>
    request<{ userId: string; username: string; publicKey: string }>(`/keys/${userId}`),

  listUsers: (token: string) =>
    request<{ users: Array<{ id: string; username: string; publicKey: string }> }>(
      '/users',
      {},
      token,
    ),

  getMessages: (token: string, recipientId: string) =>
    request<{ messages: StoredMessage[] }>(`/messages/${recipientId}`, {}, token),
};

// A row as returned by GET /messages/:recipientId. Both sealed-box copies are
// included so the client can pick the one it can actually decrypt. The
// `deliveredAt`/`readAt` receipt timestamps are server-assigned and are
// nullable until the recipient transitions them.
export type StoredMessage = {
  id: string;
  senderId: string;
  recipientId: string;
  ciphertextForRecipient: string;
  ciphertextForSender: string;
  algorithm: string;
  createdAt: string;
  deliveredAt: string | null;
  readAt: string | null;
};
