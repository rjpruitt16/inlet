import type { ProviderAdapter, ProviderName } from "../core/types.js";
import { AlchemyProvider } from "./alchemy.js";
import { AnthropicProvider } from "./anthropic.js";
import { GitHubProvider } from "./github.js";
import { HeliusProvider } from "./helius.js";
import { OpenAIProvider } from "./openai.js";
import { QuickNodeProvider } from "./quicknode.js";
import { SlackProvider } from "./slack.js";
import { ShopifyProvider } from "./shopify.js";
import { StripeProvider } from "./stripe.js";
import { TelegramProvider } from "./telegram.js";
import { TwilioProvider } from "./twilio.js";
import { WhatsAppProvider } from "./whatsapp.js";

export function defaultProviders(): ReadonlyMap<ProviderName, ProviderAdapter> {
  const providers: ProviderAdapter[] = [
    new GitHubProvider(),
    new ShopifyProvider(),
    new StripeProvider(),
    new AnthropicProvider(),
    new TwilioProvider(),
    new TelegramProvider(),
    new WhatsAppProvider(),
    new OpenAIProvider(),
    new SlackProvider(),
    new AlchemyProvider(),
    new QuickNodeProvider(),
    new HeliusProvider(),
  ];
  return new Map(providers.map((provider) => [provider.name, provider]));
}

export {
  AlchemyProvider,
  AnthropicProvider,
  GitHubProvider,
  HeliusProvider,
  OpenAIProvider,
  QuickNodeProvider,
  SlackProvider,
  ShopifyProvider,
  StripeProvider,
  TelegramProvider,
  TwilioProvider,
  WhatsAppProvider,
};
