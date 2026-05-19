import type { CSSProperties } from 'react';

export type ChatUser = {
  id: string;
  username: string;
  publicKey: string;
};

type Props = {
  users: ChatUser[];
  selectedId: string | null;
  onSelect: (user: ChatUser) => void;
};

export function UserList({ users, selectedId, onSelect }: Props) {
  return (
    <aside style={styles.aside}>
      <h3 style={styles.heading}>People</h3>
      {users.length === 0 ? (
        <p style={styles.empty}>No other users yet. Register a second account from another browser.</p>
      ) : (
        <ul style={styles.list}>
          {users.map((u) => {
            const active = u.id === selectedId;
            return (
              <li key={u.id}>
                <button
                  onClick={() => onSelect(u)}
                  style={{ ...styles.item, ...(active ? styles.itemActive : null) }}
                >
                  {u.username}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}

const styles: Record<string, CSSProperties> = {
  aside: {
    width: 220,
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
  },
  itemActive: { background: '#eef2ff', fontWeight: 600 },
  empty: { color: '#888', fontSize: 13 },
};
