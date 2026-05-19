import type { CSSProperties } from 'react';
import type { PresenceEntry } from '../lib/api';

export type ChatUser = {
  id: string;
  username: string;
  publicKey: string;
};

type Props = {
  users: ChatUser[];
  selectedId: string | null;
  onSelect: (user: ChatUser) => void;
  presence: Map<string, PresenceEntry>;
};

export function UserList({ users, selectedId, onSelect, presence }: Props) {
  return (
    <aside style={styles.aside}>
      <h3 style={styles.heading}>People</h3>
      {users.length === 0 ? (
        <p style={styles.empty}>No other users yet. Register a second account from another browser.</p>
      ) : (
        <ul style={styles.list}>
          {users.map((u) => {
            const active = u.id === selectedId;
            const p = presence.get(u.id);
            const online = p?.online ?? false;
            return (
              <li key={u.id}>
                <button
                  onClick={() => onSelect(u)}
                  style={{ ...styles.item, ...(active ? styles.itemActive : null) }}
                >
                  <span
                    style={{
                      ...styles.dot,
                      background: online ? '#16a34a' : '#9ca3af',
                    }}
                    aria-label={online ? 'online' : 'offline'}
                  />
                  <span style={styles.name}>{u.username}</span>
                  <span style={styles.presence}>
                    {online ? 'Online' : describeLastSeen(p?.lastSeenAt ?? null)}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}

function describeLastSeen(iso: string | null): string {
  if (!iso) return 'Offline';
  const ts = new Date(iso);
  if (Number.isNaN(ts.getTime())) return 'Offline';
  const diffMs = Date.now() - ts.getTime();
  const diffMin = Math.round(diffMs / 60000);
  if (diffMin < 1) return 'Last seen just now';
  if (diffMin < 60) return `Last seen ${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `Last seen ${diffHr}h ago`;
  return `Last seen ${ts.toLocaleDateString()}`;
}

const styles: Record<string, CSSProperties> = {
  aside: {
    width: 240,
    borderRight: '1px solid #ddd',
    padding: 16,
    overflowY: 'auto',
  },
  heading: { margin: '0 0 12px', fontSize: 14, textTransform: 'uppercase', color: '#666' },
  list: { listStyle: 'none', padding: 0, margin: 0 },
  item: {
    width: '100%',
    textAlign: 'left',
    padding: '8px 10px',
    border: 'none',
    background: 'transparent',
    cursor: 'pointer',
    borderRadius: 4,
    fontSize: 14,
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  itemActive: { background: '#eef2ff', fontWeight: 600 },
  dot: {
    width: 8,
    height: 8,
    borderRadius: '50%',
    flexShrink: 0,
  },
  name: { flex: 1 },
  presence: { fontSize: 11, color: '#6b7280', whiteSpace: 'nowrap' },
  empty: { color: '#888', fontSize: 13 },
};
