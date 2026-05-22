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

function initials(name: string): string {
  return name.trim().slice(0, 2).toUpperCase() || '?';
}

export function UserList({ users, selectedId, onSelect, presence }: Props) {
  return (
    <aside className="sidebar">
      <div className="sidebar__head">
        <span className="sidebar__title">Peers</span>
        <span className="sidebar__count">{users.length}</span>
      </div>
      {users.length === 0 ? (
        <div className="peer-empty">
          No other users yet.
          <br />
          Register a second account from another browser to start a conversation.
        </div>
      ) : (
        <ul className="peer-list">
          {users.map((u) => {
            const active = u.id === selectedId;
            const p = presence.get(u.id);
            const online = p?.online ?? false;
            return (
              <li key={u.id}>
                <button
                  className={`peer ${active ? 'peer--active' : ''}`}
                  onClick={() => onSelect(u)}
                >
                  <span className="avatar">{initials(u.username)}</span>
                  <span className="peer__main">
                    <span className="peer__name">{u.username}</span>
                    <span className="peer__status">
                      <span
                        className={`pdot ${online ? 'pdot--online' : 'pdot--offline'}`}
                        aria-label={online ? 'online' : 'offline'}
                      />
                      {online ? 'Online' : describeLastSeen(p?.lastSeenAt ?? null)}
                    </span>
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
