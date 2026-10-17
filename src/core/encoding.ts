export {
  base64ToBytes,
  bytesToBase64,
  bytesToHex,
  constantTimeEqual,
  utf8,
  utf8String,
} from "./encoding.portable.js";
import { bytesToHex, utf8 } from "./encoding.portable.js";

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
