import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { Socket } from 'socket.io-client';
import { api, type StoredMessage } from '../lib/api';
import { decryptForCurrentUser, encryptForRecipient } from '../lib/crypto';
import type { ChatUser } from './UserList';
import { IconLock, IconShield, IconSend, IconCheck, IconCheckDouble } from './icons';

type Me = {
  userId: string;
  username: string;
  token: string;
  publicKey: string;
  privateKey: string;
};

// A decrypted message ready for rendering. We keep the metadata alongside so
// rendering is purely local once the plaintext has been recovered.
type DecryptedMessage = {
  id: string;
  senderId: string;
  recipientId: string;
  plaintext: string;
  createdAt: string;
  deliveredAt: string | null;
  readAt: string | null;
};

type IncomingPayload = {
  id: string;
  senderId: string;
  recipientId: string;
  ciphertext: string;
  algorithm: string;
  createdAt: string;
  deliveredAt: string | null;
  readAt: string | null;
};

type StatusPayload = {
  messageId: string;
  deliveredAt: string | null;
  readAt: string | null;
};

type Props = {
  me: Me;
  socket: Socket;
  recipient: ChatUser;
  recipientOnline: boolean;
};

const TYPING_DEBOUNCE_MS = 1200;

function initials(name: string): string {
  return name.trim().slice(0, 2).toUpperCase() || '?';
}

export function ChatView({ me, socket, recipient, recipientOnline }: Props) {
  const [messages, setMessages] = useState<DecryptedMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [recipientTyping, setRecipientTyping] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Tracks the in-flight "stop typing" timer and whether we've already told
  // the server we're typing (so we don't re-emit `typing:start` on every
  // keystroke).
  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sentTypingStartRef = useRef(false);

  // Sort by createdAt, dedup by id — events can arrive both from history and live.
  const sorted = useMemo(
    () =>
      [...messages]
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .filter((m, i, arr) => i === 0 || arr[i - 1].id !== m.id),
    [messages],
  );

  // Reset when the active recipient changes.
  useEffect(() => {
    setMessages([]);
    setError(null);
    setLoading(true);

    let cancelled = false;
    (async () => {
      try {
        const { messages: history } = await api.getMessages(me.token, recipient.id);
        if (cancelled) return;
        const decrypted = history
          .map((m) => decryptStored(m, me))
          .filter((m): m is DecryptedMessage => m !== null);
        setMessages(decrypted);

        // Any history rows that were sent to us and have not yet been marked
        // read should be marked read now — the conversation is open and the
        // user is looking at them.
        for (const m of decrypted) {
          if (m.recipientId === me.userId && m.readAt === null) {
            socket.emit('message:read', { messageId: m.id });
          }
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'history_load_failed');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [me, recipient.id, socket]);

  // Listen for live messages for this conversation only.
  useEffect(() => {
    const onNew = (payload: IncomingPayload) => {
      const involvesUs =
        (payload.senderId === me.userId && payload.recipientId === recipient.id) ||
        (payload.senderId === recipient.id && payload.recipientId === me.userId);
      if (!involvesUs) return;

      try {
        const plaintext = decryptForCurrentUser(me.publicKey, me.privateKey, payload.ciphertext);
        setMessages((prev) => [
          ...prev,
          {
            id: payload.id,
            senderId: payload.senderId,
            recipientId: payload.recipientId,
            plaintext,
            createdAt: payload.createdAt,
            deliveredAt: payload.deliveredAt,
            readAt: payload.readAt,
          },
        ]);

        // If the message came from the active recipient (i.e. we are the
        // recipient of this message), transition receipts on the server.
        // We were able to decrypt the ciphertext above, so the client has
        // genuinely received the message — that satisfies "delivered". The
        // conversation is currently open and visible to the user, so we can
        // also send "read" right away.
        if (payload.senderId === recipient.id && payload.recipientId === me.userId) {
          socket.emit('message:delivered', { messageId: payload.id });
          socket.emit('message:read', { messageId: payload.id });
        }
      } catch {
        // Ciphertext we can't decrypt isn't useful to surface — likely a stale
        // session from before our keypair was rotated.
      }
    };
    socket.on('message:new', onNew);
    return () => {
      socket.off('message:new', onNew);
    };
  }, [me, recipient.id, socket]);

  // Typing indicator from the active recipient. We only react when the
  // event's userId matches the open conversation — typing notices for
  // other people in the user list are ignored here (the user list does
  // not surface typing in v1).
  useEffect(() => {
    setRecipientTyping(false);
    const onTyping = (payload: { userId: string; typing: boolean }) => {
      if (payload.userId !== recipient.id) return;
      setRecipientTyping(payload.typing);
    };
    socket.on('typing:update', onTyping);
    return () => {
      socket.off('typing:update', onTyping);
    };
  }, [recipient.id, socket]);

  // When the active conversation changes (or the component unmounts), make
  // sure we don't leave a "still typing" state hanging on the server.
  useEffect(() => {
    return () => {
      if (typingTimerRef.current !== null) {
        clearTimeout(typingTimerRef.current);
        typingTimerRef.current = null;
      }
      if (sentTypingStartRef.current) {
        socket.emit('typing:stop', { recipientId: recipient.id });
        sentTypingStartRef.current = false;
      }
    };
  }, [recipient.id, socket]);

  function handleDraftChange(value: string) {
    setDraft(value);

    if (value.length === 0) {
      // The user cleared the input — stop immediately rather than waiting
      // for the debounce.
      if (typingTimerRef.current !== null) {
        clearTimeout(typingTimerRef.current);
        typingTimerRef.current = null;
      }
      if (sentTypingStartRef.current) {
        socket.emit('typing:stop', { recipientId: recipient.id });
        sentTypingStartRef.current = false;
      }
      return;
    }

    if (!sentTypingStartRef.current) {
      socket.emit('typing:start', { recipientId: recipient.id });
      sentTypingStartRef.current = true;
    }

    if (typingTimerRef.current !== null) {
      clearTimeout(typingTimerRef.current);
    }
    typingTimerRef.current = setTimeout(() => {
      if (sentTypingStartRef.current) {
        socket.emit('typing:stop', { recipientId: recipient.id });
        sentTypingStartRef.current = false;
      }
      typingTimerRef.current = null;
    }, TYPING_DEBOUNCE_MS);
  }

  // Listen for receipt transitions on any message in the open conversation.
  useEffect(() => {
    const onStatus = (payload: StatusPayload) => {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === payload.messageId
            ? { ...m, deliveredAt: payload.deliveredAt, readAt: payload.readAt }
            : m,
        ),
      );
    };
    socket.on('message:status', onStatus);
    return () => {
      socket.off('message:status', onStatus);
    };
  }, [socket]);

  // Auto-scroll to the bottom on new messages.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [sorted.length]);

  async function handleSend(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;

    let ciphertextForRecipient: string;
    let ciphertextForSender: string;
    try {
      ciphertextForRecipient = encryptForRecipient(recipient.publicKey, text);
      ciphertextForSender = encryptForRecipient(me.publicKey, text);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'encrypt_failed');
      return;
    }

    setDraft('');
    setError(null);

    // The conversation has produced a concrete message — there is nothing
    // left to "still be typing" about. Clear the indicator immediately.
    if (typingTimerRef.current !== null) {
      clearTimeout(typingTimerRef.current);
      typingTimerRef.current = null;
    }
    if (sentTypingStartRef.current) {
      socket.emit('typing:stop', { recipientId: recipient.id });
      sentTypingStartRef.current = false;
    }

    socket.emit(
      'message:send',
      { recipientId: recipient.id, ciphertextForRecipient, ciphertextForSender },
      (ack: { ok: boolean; error?: string }) => {
        if (!ack?.ok) setError(ack?.error ?? 'send_failed');
        // Successful sends arrive back as a `message:new` event addressed to
        // the sender room, so we don't append here — that avoids duplicates.
      },
    );
  }

  return (
    <section className="chat">
      <header className="chat__head">
        <span className="avatar">{initials(recipient.username)}</span>
        <div className="chat__peer-text">
          <div className="chat__name">{recipient.username}</div>
          <div className="chat__sub">
            <span className={`pdot ${recipientOnline ? 'pdot--online' : 'pdot--offline'}`} />
            {recipientOnline ? 'Online' : 'Offline'}
          </div>
        </div>
        <div className="chat__head-right">
          <span className="e2ee-tag"><IconLock /> E2EE sealed</span>
          <span className="chat__fp">key {recipient.publicKey.slice(0, 14)}…</span>
        </div>
      </header>

      <div ref={scrollRef} className="thread">
        {loading && <div className="thread__note">Decrypting message history…</div>}
        {!loading && sorted.length === 0 && (
          <div className="msg-empty">
            <div className="msg-empty__icon"><IconShield /></div>
            <div className="msg-empty__title">No messages yet</div>
            <p className="msg-empty__text">
              Say hello — your message is sealed in this browser and the server only ever stores ciphertext.
            </p>
          </div>
        )}
        {sorted.map((m) => {
          const mine = m.senderId === me.userId;
          const receipt = receiptInfo(m.deliveredAt, m.readAt);
          return (
            <div key={m.id} className={`msg-line ${mine ? 'msg-line--mine' : 'msg-line--theirs'}`}>
              <div
                className={`msg ${mine ? 'msg--mine' : 'msg--theirs'}`}
                title={new Date(m.createdAt).toLocaleString()}
              >
                <div className="msg__body">{m.plaintext}</div>
                <div className="msg__meta">
                  <IconLock className="msg__lock" />
                  <span className="msg__time">{formatTime(m.createdAt)}</span>
                </div>
              </div>
              {mine && (
                <div className={`receipt receipt--${receipt.level}`}>
                  {receipt.level === 'sent' ? <IconCheck /> : <IconCheckDouble />}
                  {receipt.label}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {recipientTyping && (
        <div className="typing" aria-live="polite">
          <span className="typing__dots"><i /><i /><i /></span>
          {recipient.username} is typing
        </div>
      )}

      {error && <p className="banner-error chat__error">{error}</p>}

      <form onSubmit={handleSend} className="composer">
        <div className="composer__row">
          <input
            className="composer__input"
            value={draft}
            onChange={(e) => handleDraftChange(e.target.value)}
            placeholder={`Message ${recipient.username}…`}
            autoFocus
          />
          <button type="submit" className="composer__send" disabled={!draft.trim()} aria-label="Send message">
            <IconSend />
          </button>
        </div>
        <div className="composer__hint">
          <IconLock /> Messages are encrypted before leaving this browser.
        </div>
      </form>
    </section>
  );
}

// Pick the ciphertext we can decrypt (sender vs recipient copy) and return the
// plaintext + metadata, or null if decryption failed.
function decryptStored(m: StoredMessage, me: Me): DecryptedMessage | null {
  const ciphertext = m.senderId === me.userId ? m.ciphertextForSender : m.ciphertextForRecipient;
  try {
    const plaintext = decryptForCurrentUser(me.publicKey, me.privateKey, ciphertext);
    return {
      id: m.id,
      senderId: m.senderId,
      recipientId: m.recipientId,
      plaintext,
      createdAt: m.createdAt,
      deliveredAt: m.deliveredAt,
      readAt: m.readAt,
    };
  } catch {
    return null;
  }
}

type ReceiptLevel = 'sent' | 'delivered' | 'read';

function receiptInfo(
  deliveredAt: string | null,
  readAt: string | null,
): { label: string; level: ReceiptLevel } {
  if (readAt) return { label: 'Read', level: 'read' };
  if (deliveredAt) return { label: 'Delivered', level: 'delivered' };
  return { label: 'Sent', level: 'sent' };
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
