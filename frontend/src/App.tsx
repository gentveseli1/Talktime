import { useEffect, useState, type CSSProperties, type FormEvent } from 'react';
import type { Socket } from 'socket.io-client';
import { api, type AuthResponse } from './lib/api';
import { connectSocket, disconnectSocket } from './lib/socket';
import { generateKeyPair, ready as cryptoReady } from './lib/crypto';
import { loadKeyPair, saveKeyPair } from './storage/keys';
import { UserList, type ChatUser } from './components/UserList';
import { ChatView } from './components/ChatView';

type Session = {
  user: AuthResponse;
  privateKey: string;
};

export function App() {
  const [cryptoLoaded, setCryptoLoaded] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [socket, setSocket] = useState<Socket | null>(null);
  const [users, setUsers] = useState<ChatUser[]>([]);
  const [selected, setSelected] = useState<ChatUser | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [healthNode, setHealthNode] = useState<string | null>(null);
  const [socketNode, setSocketNode] = useState<string | null>(null);

  useEffect(() => {
    cryptoReady.then(() => setCryptoLoaded(true));
  }, []);

  // Open the socket as soon as we have a session.
  useEffect(() => {
    if (!session) return;
    const s = connectSocket(session.user.token);
    s.on('connect_error', (err) => setError(`socket: ${err.message}`));
    s.on('connect', () => {
      s.emit('ping', (reply: { nodeId: string }) => setSocketNode(reply.nodeId));
    });
    setSocket(s);
    return () => {
      disconnectSocket();
      setSocket(null);
    };
  }, [session]);

  // Load the user list once authenticated.
  useEffect(() => {
    if (!session) return;
    api
      .listUsers(session.user.token)
      .then((res) => setUsers(res.users))
      .catch((err) => setError(err instanceof Error ? err.message : 'load_users_failed'));
  }, [session]);

  async function handleRegister(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const form = new FormData(e.currentTarget);
    const username = String(form.get('username') ?? '');
    const email = String(form.get('email') ?? '');
    const password = String(form.get('password') ?? '');

    try {
      const kp = generateKeyPair();
      const res = await api.register({ username, email, password, publicKey: kp.publicKey });
      await saveKeyPair(res.userId, kp);
      setSession({ user: res, privateKey: kp.privateKey });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'register_failed');
    }
  }

  async function handleLogin(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const form = new FormData(e.currentTarget);
    const username = String(form.get('username') ?? '');
    const password = String(form.get('password') ?? '');

    try {
      const res = await api.login({ username, password });
      const kp = await loadKeyPair(res.userId);
      if (!kp) {
        setError('no_local_key_for_this_user_register_first_on_this_device');
        return;
      }
      setSession({ user: res, privateKey: kp.privateKey });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'login_failed');
    }
  }

  async function pingHealth() {
    try {
      const res = await api.health();
      setHealthNode(`${res.nodeId} (db=${res.db}, redis=${res.redis})`);
    } catch (err) {
      setHealthNode(`error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  function logout() {
    disconnectSocket();
    setSession(null);
    setSocket(null);
    setUsers([]);
    setSelected(null);
    setSocketNode(null);
    setHealthNode(null);
  }

  if (!cryptoLoaded) {
    return <main style={styles.center}><p>Loading libsodium…</p></main>;
  }

  if (!session) {
    return (
      <main style={styles.auth}>
        <h1>Distributed E2EE Chat</h1>
        {error && <p style={styles.error}>{error}</p>}
        <section style={styles.grid}>
          <form onSubmit={handleRegister} style={styles.card}>
            <h2>Register</h2>
            <label>Username<input name="username" required minLength={3} /></label>
            <label>Email<input name="email" type="email" required /></label>
            <label>Password<input name="password" type="password" required minLength={8} /></label>
            <button type="submit">Register &amp; generate keypair</button>
            <p style={styles.muted}>
              A new X25519 keypair is generated in your browser. The private key
              is stored in IndexedDB and never sent to the server.
            </p>
          </form>
          <form onSubmit={handleLogin} style={styles.card}>
            <h2>Login</h2>
            <label>Username<input name="username" required /></label>
            <label>Password<input name="password" type="password" required /></label>
            <button type="submit">Login</button>
            <p style={styles.muted}>
              Login only works on the device where you registered — the private
              key lives in this browser's IndexedDB.
            </p>
          </form>
        </section>
      </main>
    );
  }

  return (
    <div style={styles.app}>
      <header style={styles.appHeader}>
        <strong>{session.user.username}</strong>
        <span style={styles.muted}>
          socket node: {socketNode ?? '—'} · health:&nbsp;
          <button onClick={pingHealth} style={styles.linkButton}>check</button>
          {healthNode ? ` ${healthNode}` : ''}
        </span>
        <button onClick={logout}>Log out</button>
      </header>

      {error && <p style={styles.error}>{error}</p>}

      <div style={styles.workspace}>
        <UserList
          users={users}
          selectedId={selected?.id ?? null}
          onSelect={setSelected}
        />
        {selected && socket ? (
          <ChatView
            me={{
              userId: session.user.userId,
              username: session.user.username,
              token: session.user.token,
              publicKey: session.user.publicKey,
              privateKey: session.privateKey,
            }}
            socket={socket}
            recipient={selected}
          />
        ) : (
          <section style={styles.placeholder}>
            <p style={styles.muted}>Select a person on the left to start an encrypted chat.</p>
          </section>
        )}
      </div>
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  center: { display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh' },
  auth: {
    maxWidth: 880,
    margin: '40px auto',
    padding: '0 20px',
    fontFamily: 'system-ui, sans-serif',
    lineHeight: 1.5,
  },
  grid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 },
  card: {
    border: '1px solid #ddd',
    borderRadius: 8,
    padding: 20,
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  },
  app: {
    display: 'flex',
    flexDirection: 'column',
    height: '100vh',
    fontFamily: 'system-ui, sans-serif',
  },
  appHeader: {
    padding: '8px 16px',
    borderBottom: '1px solid #ddd',
    display: 'flex',
    alignItems: 'center',
    gap: 16,
  },
  workspace: { flex: 1, display: 'flex', minHeight: 0 },
  placeholder: {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
  },
  muted: { color: '#666', fontSize: 13, marginRight: 'auto' },
  linkButton: { background: 'none', border: 'none', color: '#2563eb', cursor: 'pointer', padding: 0 },
  error: { color: '#b00', padding: '8px 16px', margin: 0 },
};
