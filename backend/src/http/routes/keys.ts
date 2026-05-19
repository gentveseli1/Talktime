import { Router } from 'express';
import { getPublicKey } from '../../services/users.service.js';

export const keysRouter = Router();

// Public endpoint: anyone can fetch any user's public key. That is the entire
// point of public-key crypto — the public key is, by definition, public.
keysRouter.get('/:userId', async (req, res) => {
  const user = await getPublicKey(req.params.userId);
  if (!user) return res.status(404).json({ error: 'not_found' });
  return res.json({ userId: user.id, username: user.username, publicKey: user.publicKey });
});
