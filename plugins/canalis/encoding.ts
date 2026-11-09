// Stands in for src/core/encoding.ts inside a Canalis plugin: the same
// exports, with HMAC done by Canalis (there's no WebCrypto in a plugin).
// Everything else is the same code as Inlet's.
export {
  base64ToBytes,
  bytesToBase64,
  bytesToHex,
  constantTimeEqual,
  utf8,
  utf8String,
} from "../../src/core/encoding.portable.js";
import { base64ToBytes, bytesToBase64, bytesToHex, utf8 } from "../../src/core/encoding.portable.js";

function host(name: string, payload: string): string {
  const fn = Host.getFunctions()[name];
  if (fn === undefined) throw new Error(`Canalis doesn't provide ${name}`);
  return Memory.find(fn(Memory.fromString(payload).offset)).readString();
}

function hmac(name: "hmac_sha256" | "hmac_sha1", secret: Uint8Array, value: Uint8Array): Uint8Array {
  return base64ToBytes(host(name, JSON.stringify({ key_base64: bytesToBase64(secret), message_base64: bytesToBase64(value) })));
}

export async function hmacSha256(secret: Uint8Array, value: Uint8Array): Promise<Uint8Array> {
  return hmac("hmac_sha256", secret, value);
}

export async function hmacSha1(secret: Uint8Array, value: Uint8Array): Promise<Uint8Array> {
  return hmac("hmac_sha1", secret, value);
}

export async function sha256HexBytes(value: Uint8Array): Promise<string> {
  return bytesToHex(base64ToBytes(host("sha256", bytesToBase64(value))));
}

export async function sha256Hex(value: string): Promise<string> {
  return sha256HexBytes(utf8(value));
}
