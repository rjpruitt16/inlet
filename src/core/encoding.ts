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

export async function ecdsaP256Sha256Verify(
  publicKeySpki: Uint8Array,
  signatureDer: Uint8Array,
  value: Uint8Array,
): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "spki",
    Uint8Array.from(publicKeySpki),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    Uint8Array.from(ecdsaDerToP1363(signatureDer)),
    Uint8Array.from(value),
  );
}

function ecdsaDerToP1363(signature: Uint8Array): Uint8Array {
  let offset = 0;
  if (signature[offset++] !== 0x30) throw new Error("invalid ECDSA sequence");
  const sequence = readDerLength(signature, offset);
  offset = sequence.next;
  if (offset + sequence.length !== signature.length) throw new Error("invalid ECDSA length");

  const r = readDerInteger(signature, offset);
  const s = readDerInteger(signature, r.next);
  if (s.next !== signature.length) throw new Error("invalid ECDSA signature");

  const result = new Uint8Array(64);
  result.set(r.value, 32 - r.value.length);
  result.set(s.value, 64 - s.value.length);
  return result;
}

function readDerInteger(
  bytes: Uint8Array,
  offset: number,
): { value: Uint8Array; next: number } {
  if (bytes[offset++] !== 0x02) throw new Error("invalid ECDSA integer");
  const encoded = readDerLength(bytes, offset);
  offset = encoded.next;
  const end = offset + encoded.length;
  if (encoded.length === 0 || end > bytes.length) throw new Error("invalid ECDSA integer length");
  if (((bytes[offset] ?? 0) & 0x80) !== 0) throw new Error("negative ECDSA integer");

  let start = offset;
  while (end - start > 32 && bytes[start] === 0) start += 1;
  if (end - start > 32) throw new Error("invalid ECDSA integer value");
  return { value: bytes.slice(start, end), next: end };
}

function readDerLength(bytes: Uint8Array, offset: number): { length: number; next: number } {
  const first = bytes[offset++];
  if (first === undefined) throw new Error("missing DER length");
  if ((first & 0x80) === 0) return { length: first, next: offset };

  const count = first & 0x7f;
  if (count === 0 || count > 2 || offset + count > bytes.length) {
    throw new Error("invalid DER length");
  }
  let length = 0;
  for (let index = 0; index < count; index += 1) {
    length = (length << 8) | (bytes[offset++] ?? 0);
  }
  return { length, next: offset };
}
