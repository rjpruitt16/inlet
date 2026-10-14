import {
  GetSecretValueCommand,
  SecretsManagerClient,
  type SecretsManagerClientConfig,
} from "@aws-sdk/client-secrets-manager";
import { ConfigurationError } from "../../core/errors.js";
import type { SecretResolver } from "../../core/types.js";

export class AwsSecretResolver implements SecretResolver {
  private readonly client: SecretsManagerClient;
  private readonly cache = new Map<string, string>();

  constructor(config: SecretsManagerClientConfig = {}) {
    this.client = new SecretsManagerClient(config);
  }

  async resolve(reference: string): Promise<string> {
    const cached = this.cache.get(reference);
    if (cached !== undefined) return cached;

    let value: string | undefined;
    if (reference.startsWith("env:")) {
      value = process.env[reference.slice(4)];
    } else if (reference.startsWith("aws-secrets:")) {
      const response = await this.client.send(
        new GetSecretValueCommand({ SecretId: reference.slice("aws-secrets:".length) }),
      );
      value = response.SecretString;
      if (value === undefined && response.SecretBinary !== undefined) {
        value = new TextDecoder().decode(response.SecretBinary);
      }
    } else {
      value = process.env[reference];
    }

    if (!value) {
      throw new ConfigurationError(`secret reference did not resolve: ${reference}`);
    }
    this.cache.set(reference, value);
    return value;
  }
}
