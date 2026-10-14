import { ConfigurationError } from "../../core/errors.js";
import type { SecretResolver } from "../../core/types.js";
import type { CloudflareEnv } from "./types.js";

export class CloudflareSecretResolver implements SecretResolver {
  constructor(private readonly env: CloudflareEnv) {}

  async resolve(reference: string): Promise<string> {
    const binding = reference.startsWith("binding:") ? reference.slice("binding:".length) : reference;
    const value = this.env[binding];
    if (typeof value !== "string" || value.length === 0) {
      throw new ConfigurationError(`secret binding did not resolve: ${reference}`);
    }
    return value;
  }
}
