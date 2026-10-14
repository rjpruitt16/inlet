import type { ProviderAdapter, ProviderName } from "../core/types.js";
import { AnthropicProvider } from "./anthropic.js";
import { GitHubProvider } from "./github.js";
import { ShopifyProvider } from "./shopify.js";
import { StripeProvider } from "./stripe.js";

export function defaultProviders(): ReadonlyMap<ProviderName, ProviderAdapter> {
  const providers: ProviderAdapter[] = [
    new GitHubProvider(),
    new ShopifyProvider(),
    new StripeProvider(),
    new AnthropicProvider(),
  ];
  return new Map(providers.map((provider) => [provider.name, provider]));
}

export { AnthropicProvider, GitHubProvider, ShopifyProvider, StripeProvider };
