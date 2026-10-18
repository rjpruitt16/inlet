// Exports and imports, for extism-js.
declare module "main" {
  export function describe(): I32;
  export function verify(): I32;
}

declare module "extism:host" {
  interface user {
    hmac_sha256(ptr: I64): I64;
    hmac_sha1(ptr: I64): I64;
    sha256(ptr: I64): I64;
  }
}
