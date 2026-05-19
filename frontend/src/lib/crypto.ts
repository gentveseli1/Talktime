import sodium from 'libsodium-wrappers';

// Module-level promise so callers can `await ready` once at startup.
export const ready: Promise<void> = sodium.ready;

export type KeyPair = {
  publicKey: string;   // base64
  privateKey: string;  // base64
};

// Generate a fresh X25519 keypair. The private key must be persisted in
// browser-local storage and never sent to the server.
export function generateKeyPair(): KeyPair {
  const kp = sodium.crypto_box_keypair();
  return {
    publicKey: sodium.to_base64(kp.publicKey, sodium.base64_variants.ORIGINAL),
    privateKey: sodium.to_base64(kp.privateKey, sodium.base64_variants.ORIGINAL),
  };
}

// Sealed-box encryption: the sender needs only the recipient's public key.
// The sender does NOT need its own keypair — sealed boxes generate an
// ephemeral keypair per message and embed it in the ciphertext.
export function encryptForRecipient(recipientPublicKey: string, plaintext: string): string {
  const recipientPub = sodium.from_base64(recipientPublicKey, sodium.base64_variants.ORIGINAL);
  const message = sodium.from_string(plaintext);
  const ciphertext = sodium.crypto_box_seal(message, recipientPub);
  return sodium.to_base64(ciphertext, sodium.base64_variants.ORIGINAL);
}

// Sealed-box decryption: requires the recipient's own public AND private key.
// (Note: the SENDER's public key is not needed and is, by design, unknowable
// from a sealed box — that's the "sealed" part.)
export function decryptForCurrentUser(
  currentUserPublicKey: string,
  currentUserPrivateKey: string,
  ciphertext: string,
): string {
  const pub = sodium.from_base64(currentUserPublicKey, sodium.base64_variants.ORIGINAL);
  const priv = sodium.from_base64(currentUserPrivateKey, sodium.base64_variants.ORIGINAL);
  const ct = sodium.from_base64(ciphertext, sodium.base64_variants.ORIGINAL);
  const plaintext = sodium.crypto_box_seal_open(ct, pub, priv);
  return sodium.to_string(plaintext);
}
