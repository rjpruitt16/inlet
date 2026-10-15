const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function utf8(value: string): Uint8Array {
  return encoder.encode(value);
}

export function utf8String(value: Uint8Array): string {
  return decoder.decode(value);
}

export function bytesToHex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function bytesToBase64(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

export async function hmacSha256(secret: Uint8Array, value: Uint8Array): Promise<Uint8Array> {
  return hmac(secret, value, "SHA-256");
}

export async function hmacSha1(secret: Uint8Array, value: Uint8Array): Promise<Uint8Array> {
  return hmac(secret, value, "SHA-1");
}

async function hmac(
  secret: Uint8Array,
  value: Uint8Array,
  hash: "SHA-1" | "SHA-256",
): Promise<Uint8Array> {
  const keyBytes = Uint8Array.from(secret);
  const valueBytes = Uint8Array.from(value);
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, valueBytes));
}

export async function sha256HexBytes(value: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(value));
  return bytesToHex(new Uint8Array(digest));
}

export async function sha256Hex(value: string): Promise<string> {
  return sha256HexBytes(utf8(value));
}
