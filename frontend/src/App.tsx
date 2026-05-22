import { useEffect, useState, type FormEvent } from 'react';
import type { Socket } from 'socket.io-client';
import { api, type AuthResponse, type PresenceEntry } from './lib/api';
import { connectSocket, disconnectSocket } from './lib/socket';
import { generateKeyPair, ready as cryptoReady } from './lib/crypto';
import { loadKeyPair, saveKeyPair } from './storage/keys';
import { UserList, type ChatUser } from './components/UserList';
import { ChatView } from './components/ChatView';
import { IconLock, IconShield, IconKey, IconNodes, IconBolt, IconDatabase } from './components/icons';

type Session = {
  user: AuthResponse;
  privateKey: string;
};

function initials(name: string): string {
  return name.trim().slice(0, 2).toUpperCase() || '?';
}

export function App() {
  const [cryptoLoaded, setCryptoLoaded] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [socket, setSocket] = useState<Socket | null>(null);
  const [users, setUsers] = useState<ChatUser[]>([]);
  const [presence, setPresence] = useState<Map<string, PresenceEntry>>(new Map());
  const [selected, setSelected] = useState<ChatUser | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [healthNode, setHealthNode] = useState<string | null>(null);
  const [socketNode, setSocketNode] = useState<string | null>(null);
  const [authTab, setAuthTab] = useState<'register' | 'login'>('register');

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

    // Live presence transitions. The server broadcasts to a shared room
    // (any logged-in client subscribes) and the Redis adapter fans the
    // event out across backend nodes.
    const onPresence = (entry: PresenceEntry) => {
      setPresence((prev) => {
        const next = new Map(prev);
        next.set(entry.userId, entry);
        return next;
      });
    };
    s.on('presence:update', onPresence);

    setSocket(s);
    return () => {
      s.off('presence:update', onPresence);
      disconnectSocket();
      setSocket(null);
    };
  }, [session]);

  // Load the user list + initial presence snapshot once authenticated.
  useEffect(() => {
    if (!session) return;
    api
      .listUsers(session.user.token)
      .then((res) => setUsers(res.users))
      .catch((err) => setError(err instanceof Error ? err.message : 'load_users_failed'));
    api
      .getPresence(session.user.token)
      .then((res) => {
        const map = new Map<string, PresenceEntry>();
        for (const entry of res.presence) map.set(entry.userId, entry);
        // Merge with anything the live socket has already pushed in.
        setPresence((prev) => {
          const merged = new Map(map);
          for (const [k, v] of prev) merged.set(k, v);
          return merged;
        });
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'load_presence_failed'));
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
    setPresence(new Map());
    setSelected(null);
    setSocketNode(null);
    setHealthNode(null);
  }

  if (!cryptoLoaded) {
    return (
      <div className="boot">
        <div className="spinner" />
        <div className="boot__text">Initializing libsodium encryption…</div>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="auth-wrap">
        <div className="auth-card">
          <aside className="auth-aside">
            <div className="auth-brand">
              <span className="brand-mark"><IconLock /></span>
              <div>
                <div className="brand-name">TalkTime</div>
                <div className="brand-sub">Distributed E2EE Chat</div>
              </div>
            </div>

            <div>
              <h2 className="auth-aside__title">End-to-end encrypted messaging on a distributed backend.</h2>
              <p className="auth-aside__tag">
                Private key stays in your browser. Server stores only encrypted ciphertext.
              </p>
            </div>

            <ul className="sec-list">
              <li className="sec-item">
                <span className="sec-item__icon"><IconKey /></span>
                <div>
                  <div className="sec-item__title">Keys never leave your device</div>
                  <div className="sec-item__text">
                    An X25519 keypair is generated in your browser and the private key is kept in IndexedDB.
                  </div>
                </div>
              </li>
              <li className="sec-item">
                <span className="sec-item__icon"><IconShield /></span>
                <div>
                  <div className="sec-item__title">Server sees only ciphertext</div>
                  <div className="sec-item__text">
                    Messages are sealed with libsodium before they ever leave this tab.
                  </div>
                </div>
              </li>
              <li className="sec-item">
                <span className="sec-item__icon"><IconNodes /></span>
                <div>
                  <div className="sec-item__title">Distributed &amp; replicated</div>
                  <div className="sec-item__text">
                    3 backend nodes behind Nginx, Redis realtime, PostgreSQL primary/replica.
                  </div>
                </div>
              </li>
            </ul>

            <div className="auth-badges">
              <span className="badge badge--purple"><IconLock /> E2EE enabled</span>
              <span className="badge badge--cyan"><IconNodes /> 3 nodes</span>
              <span className="badge badge--cyan"><IconBolt /> Redis realtime</span>
              <span className="badge badge--cyan"><IconDatabase /> DB replicated</span>
            </div>
          </aside>

          <main className="auth-main">
            <div className="auth-tabs">
              <button
                type="button"
                className={`auth-tab ${authTab === 'register' ? 'auth-tab--active' : ''}`}
                onClick={() => { setAuthTab('register'); setError(null); }}
              >
                Create account
              </button>
              <button
                type="button"
                className={`auth-tab ${authTab === 'login' ? 'auth-tab--active' : ''}`}
                onClick={() => { setAuthTab('login'); setError(null); }}
              >
                Sign in
              </button>
            </div>

            {error && <p className="banner-error">{error}</p>}

            {authTab === 'register' ? (
              <form onSubmit={handleRegister} className="auth-form">
                <div>
                  <h3 className="auth-head__title">Create a secure account</h3>
                  <p className="auth-head__text">A fresh X25519 keypair is generated locally as you register.</p>
                </div>
                <label className="field">
                  <span className="field__label">Username</span>
                  <input className="input" name="username" required minLength={3} placeholder="alice" />
                </label>
                <label className="field">
                  <span className="field__label">Email</span>
                  <input className="input" name="email" type="email" required placeholder="alice@example.test" />
                </label>
                <label className="field">
                  <span className="field__label">Password</span>
                  <input className="input" name="password" type="password" required minLength={8} placeholder="At least 8 characters" />
                </label>
                <button type="submit" className="btn btn--primary btn--block">
                  Register &amp; generate keypair
                </button>
                <p className="form-hint">
                  <IconLock />
                  The private key is stored in this browser's IndexedDB and is never sent to the server.
                </p>
              </form>
            ) : (
              <form onSubmit={handleLogin} className="auth-form">
                <div>
                  <h3 className="auth-head__title">Unlock your session</h3>
                  <p className="auth-head__text">Your private key is loaded from this browser's local storage.</p>
                </div>
                <label className="field">
                  <span className="field__label">Username</span>
                  <input className="input" name="username" required placeholder="alice" />
                </label>
                <label className="field">
                  <span className="field__label">Password</span>
                  <input className="input" name="password" type="password" required placeholder="Your password" />
                </label>
                <button type="submit" className="btn btn--primary btn--block">
                  Sign in
                </button>
                <p className="form-hint">
                  <IconLock />
                  Login only works on the device where you registered — the private key lives in this browser.
                </p>
              </form>
            )}
          </main>
        </div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark"><IconLock /></span>
          <div className="brand-text">
            <div className="brand-name">TalkTime</div>
            <div className="brand-sub">Distributed E2EE Chat</div>
          </div>
        </div>

        <div className="sys-badges">
          <span className="badge badge--purple"><IconLock /> E2EE enabled</span>
          <span className="badge badge--cyan"><IconNodes /> 3 nodes</span>
          <span className="badge badge--cyan"><IconBolt /> Redis realtime</span>
          <span className="badge badge--cyan"><IconDatabase /> DB replicated</span>
        </div>

        <div className="topbar-right">
          <button className="node-pill" onClick={pingHealth} title="Ping backend health">
            <span className="node-pill__dot" />
            node {socketNode ?? '—'}
            {healthNode && <span className="node-pill__detail">· {healthNode}</span>}
          </button>
          <div className="user-chip">
            <span className="avatar avatar--sm">{initials(session.user.username)}</span>
            {session.user.username}
          </div>
          <button className="btn btn--ghost" onClick={logout}>Log out</button>
        </div>
      </header>

      {error && <p className="banner-error">{error}</p>}

      <div className="workspace">
        <UserList
          users={users}
          selectedId={selected?.id ?? null}
          onSelect={setSelected}
          presence={presence}
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
            recipientOnline={presence.get(selected.id)?.online ?? false}
          />
        ) : (
          <section className="placeholder">
            <div className="placeholder__icon"><IconShield /></div>
            <div>
              <div className="placeholder__title">Select a peer to start an encrypted session</div>
              <p className="placeholder__text">
                Every message is sealed with an X25519 sealed-box inside your browser. The distributed
                backend only ever relays and stores ciphertext.
              </p>
            </div>
            <div className="placeholder__hints">
              <span className="hint-chip"><IconKey /> X25519 sealed-box</span>
              <span className="hint-chip"><IconNodes /> 3 backend nodes</span>
              <span className="hint-chip"><IconBolt /> Redis pub/sub</span>
              <span className="hint-chip"><IconDatabase /> Postgres primary + replica</span>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
