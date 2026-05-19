import { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import type { Socket } from 'socket.io-client';
import { api, type StoredMessage } from '../lib/api';
import { decryptForCurrentUser, encryptForRecipient } from '../lib/crypto';
import type { ChatUser } from './UserList';

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
};

export function ChatView({ me, socket, recipient }: Props) {
  const [messages, setMessages] = useState<DecryptedMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

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
    <section style={styles.section}>
      <header style={styles.header}>
        <strong>{recipient.username}</strong>
        <span style={styles.muted}>
          fp: <code>{recipient.publicKey.slice(0, 12)}…</code>
        </span>
      </header>

      <div ref={scrollRef} style={styles.thread}>
        {loading && <p style={styles.muted}>Loading history…</p>}
        {!loading && sorted.length === 0 && (
          <p style={styles.muted}>No messages yet. Say hello — the server will only see ciphertext.</p>
        )}
        {sorted.map((m) => {
          const mine = m.senderId === me.userId;
          return (
            <div
              key={m.id}
              style={{ ...styles.bubble, ...(mine ? styles.mine : styles.theirs) }}
              title={new Date(m.createdAt).toLocaleString()}
            >
              <div>{m.plaintext}</div>
              {mine && (
                <div style={styles.statusLine}>{describeStatus(m.deliveredAt, m.readAt)}</div>
              )}
            </div>
          );
        })}
      </div>

      {error && <p style={styles.error}>{error}</p>}

      <form onSubmit={handleSend} style={styles.composer}>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={`Message ${recipient.username}…`}
          style={styles.input}
          autoFocus
        />
        <button type="submit" disabled={!draft.trim()} style={styles.send}>
          Send
        </button>
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

function describeStatus(deliveredAt: string | null, readAt: string | null): string {
  if (readAt) return 'Read';
  if (deliveredAt) return 'Delivered';
  return 'Sent';
}

const styles: Record<string, CSSProperties> = {
  section: { flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 },
  header: {
    padding: '12px 16px',
    borderBottom: '1px solid #ddd',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 12,
  },
  thread: {
    flex: 1,
    overflowY: 'auto',
    padding: 16,
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  bubble: {
    maxWidth: '70%',
    padding: '8px 12px',
    borderRadius: 12,
    fontSize: 14,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  },
  mine: { alignSelf: 'flex-end', background: '#dbeafe' },
  theirs: { alignSelf: 'flex-start', background: '#f3f4f6' },
  statusLine: {
    fontSize: 11,
    color: '#475569',
    marginTop: 2,
    textAlign: 'right',
  },
  composer: { borderTop: '1px solid #ddd', padding: 12, display: 'flex', gap: 8 },
  input: { flex: 1, padding: '8px 10px', fontSize: 14 },
  send: { padding: '8px 14px' },
  muted: { color: '#888', fontSize: 13 },
  error: { color: '#b00', padding: '0 16px' },
};
