/**
 * Client-side AES-256-GCM encryption using the browser's native Web Crypto
 * API (window.crypto.subtle). This runs entirely in the browser — the raw
 * file bytes and the encryption key never leave the sender's machine
 * unencrypted, and the key is never sent to our server at all.
 */

// Generates a fresh random 256-bit AES-GCM key for one file.
async function generateFileKey() {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
    'encrypt',
    'decrypt',
  ]);
}

async function exportKeyToBase64Url(key) {
  const raw = await crypto.subtle.exportKey('raw', key);
  return arrayBufferToBase64Url(raw);
}

async function importKeyFromBase64Url(base64url) {
  const raw = base64UrlToArrayBuffer(base64url);
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, true, ['decrypt']);
}

// AES-GCM needs a 12-byte (96-bit) IV. A fresh random one is generated per
// encryption operation — reusing an IV with the same key would break GCM's
// security guarantees.
function generateIv() {
  return crypto.getRandomValues(new Uint8Array(12));
}

async function encryptBuffer(key, iv, arrayBuffer) {
  return crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, arrayBuffer);
}

async function decryptBuffer(key, iv, arrayBuffer) {
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, arrayBuffer);
}

async function encryptString(key, iv, str) {
  const encoded = new TextEncoder().encode(str);
  const ciphertext = await encryptBuffer(key, iv, encoded);
  return arrayBufferToBase64Url(ciphertext);
}

async function decryptString(key, iv, base64url) {
  const ciphertext = base64UrlToArrayBuffer(base64url);
  const plaintext = await decryptBuffer(key, iv, ciphertext);
  return new TextDecoder().decode(plaintext);
}

// --- base64url helpers (URL-fragment safe, no padding/+//) ---

function arrayBufferToBase64Url(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToArrayBuffer(base64url) {
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/').padEnd(
    base64url.length + ((4 - (base64url.length % 4)) % 4),
    '='
  );
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function ivToBase64(iv) {
  return arrayBufferToBase64Url(iv.buffer);
}

function ivFromBase64(base64) {
  return new Uint8Array(base64UrlToArrayBuffer(base64));
}
