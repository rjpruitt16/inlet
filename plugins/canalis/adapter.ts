// Turns an Inlet provider into a Canalis plugin: describe() and verify()
// in the JSON shape Canalis expects (canalis-rs src/hooks.rs).
import { base64ToBytes } from "../../src/core/encoding.js";
import { InletError } from "../../src/core/errors.js";
import type { HeadersRecord, ProviderAdapter } from "../../src/core/types.js";

interface VerifyInput {
  method: string;
  path: string;
  query: string;
  headers: HeadersRecord;
  body_base64: string;
  secrets: Record<string, string>;
}

export function plugin(provider: ProviderAdapter, secret: string): { describe(): number; verify(): Promise<number> } {
  return {
    describe(): number {
      Host.outputString(JSON.stringify({ name: provider.name, secrets: [secret] }));
      return 0;
    },
    async verify(): Promise<number> {
      const input = JSON.parse(Host.inputString()) as VerifyInput;
      try {
        const verified = await provider.verify(
          { method: input.method, path: input.path, headers: input.headers, body: base64ToBytes(input.body_base64) },
          input.secrets[secret] ?? "",
        );
        Host.outputString(
          JSON.stringify({
            ok: {
              event_id: verified.eventId,
              tenant: verified.defaultUserId,
              event_type: verified.eventType,
              headers: verified.forwardedHeaders,
            },
          }),
        );
      } catch (error) {
        // Inlet's own errors carry the status to answer with (401 for a
        // bad signature, 400 for a bad payload).
        const status = error instanceof InletError ? error.statusCode : 400;
        const reason = error instanceof Error ? error.message : String(error);
        Host.outputString(JSON.stringify({ reject: { status, reason } }));
      }
      return 0;
    },
  };
}
