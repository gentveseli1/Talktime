import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { getConversation } from '../../services/messages.service.js';

export const messagesRouter = Router();

// Return the encrypted message history between the caller and the given user.
// Both ciphertexts are returned for every row; the client picks the one it
// can actually decrypt (ciphertextForSender if it sent the message,
// ciphertextForRecipient otherwise).
messagesRouter.get('/:recipientId', requireAuth, async (req, res) => {
  const me = req.userId!;
  const other = req.params.recipientId;
  const messages = await getConversation(me, other);
  res.json({ messages });
});
