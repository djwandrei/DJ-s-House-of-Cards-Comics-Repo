const encoder = new TextEncoder();
const decoder = new TextDecoder();

function base64Url(bytes: Uint8Array) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function fromBase64Url(value: string) {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function encryptionKey(secret: string, usages: KeyUsage[]) {
  if (String(secret || '').trim().length < 24) {
    throw new Error('SHOPIFY_TOKEN_ENCRYPTION_KEY must contain at least 24 characters.');
  }
  const keyBytes = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(secret)));
  return await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, usages);
}

export async function encryptSecret(value: string, secret: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await encryptionKey(secret, ['encrypt']);
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(value));
  return {
    encryptedValue: base64Url(new Uint8Array(encrypted)),
    initializationVector: base64Url(iv)
  };
}

export async function decryptSecret(encryptedValue: string, initializationVector: string, secret: string) {
  const key = await encryptionKey(secret, ['decrypt']);
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64Url(initializationVector) },
    key,
    fromBase64Url(encryptedValue)
  );
  return decoder.decode(decrypted);
}
