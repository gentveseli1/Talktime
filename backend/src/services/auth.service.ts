import argon2 from 'argon2';
import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma.js';
import { env } from '../config/env.js';

const JWT_EXPIRES_IN = '7d';

export type JwtPayload = {
  sub: string;       // user id
  username: string;
};

export function signToken(payload: JwtPayload): string {
  return jwt.sign(payload, env.JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

export function verifyToken(token: string): JwtPayload {
  return jwt.verify(token, env.JWT_SECRET) as JwtPayload;
}

export type RegisterInput = {
  username: string;
  email: string;
  password: string;
  publicKey: string;
};

export async function register(input: RegisterInput) {
  const passwordHash = await argon2.hash(input.password, { type: argon2.argon2id });

  const user = await prisma.user.create({
    data: {
      username: input.username,
      email: input.email,
      passwordHash,
      publicKey: input.publicKey,
    },
    select: { id: true, username: true, email: true, publicKey: true },
  });

  const token = signToken({ sub: user.id, username: user.username });
  return { user, token };
}

export type LoginInput = {
  username: string;
  password: string;
};

export async function login(input: LoginInput) {
  const user = await prisma.user.findUnique({
    where: { username: input.username },
  });
  if (!user) return null;

  const ok = await argon2.verify(user.passwordHash, input.password);
  if (!ok) return null;

  const token = signToken({ sub: user.id, username: user.username });
  return {
    user: { id: user.id, username: user.username, email: user.email, publicKey: user.publicKey },
    token,
  };
}
