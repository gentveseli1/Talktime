// Minimal IndexedDB wrapper for storing the user's private key locally.
// The private key NEVER leaves the browser.

const DB_NAME = 'chat-e2ee';
const STORE_NAME = 'keys';
const DB_VERSION = 1;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export type StoredKeyPair = {
  publicKey: string;
  privateKey: string;
};

export async function saveKeyPair(userId: string, kp: StoredKeyPair): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(kp, userId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function loadKeyPair(userId: string): Promise<StoredKeyPair | null> {
  const db = await openDb();
  const result = await new Promise<StoredKeyPair | null>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(userId);
    req.onsuccess = () => resolve((req.result as StoredKeyPair) ?? null);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return result;
}
