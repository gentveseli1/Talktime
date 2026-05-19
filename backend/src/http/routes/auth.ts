import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { login, register } from '../../services/auth.service.js';

const registerSchema = z.object({
  username: z.string().min(3).max(32).regex(/^[a-zA-Z0-9_.-]+$/),
  email: z.string().email(),
  password: z.string().min(8).max(128),
  // base64-encoded X25519 public key (32 bytes -> ~44 chars). Loose bound only.
  publicKey: z.string().min(16).max(256),
});

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

export const authRouter = Router();

authRouter.post('/register', async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_input', details: parsed.error.flatten() });
  }

  try {
    const result = await register(parsed.data);
    return res.status(201).json({
      userId: result.user.id,
      username: result.user.username,
      email: result.user.email,
      publicKey: result.user.publicKey,
      token: result.token,
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return res.status(409).json({ error: 'username_or_email_taken' });
    }
    throw err;
  }
});

authRouter.post('/login', async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_input' });
  }

  const result = await login(parsed.data);
  if (!result) return res.status(401).json({ error: 'invalid_credentials' });

  return res.json({
    userId: result.user.id,
    username: result.user.username,
    email: result.user.email,
    publicKey: result.user.publicKey,
    token: result.token,
  });
});
