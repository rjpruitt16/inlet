import type { ProviderAdapter, ProviderName } from "../core/types.js";
import { AnthropicProvider } from "./anthropic.js";
import { GitHubProvider } from "./github.js";
import { OpenAIProvider } from "./openai.js";
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
  ];
  return new Map(providers.map((provider) => [provider.name, provider]));
}

export {
  AnthropicProvider,
  GitHubProvider,
  OpenAIProvider,
  SlackProvider,
  ShopifyProvider,
  StripeProvider,
  TelegramProvider,
  TwilioProvider,
  WhatsAppProvider,
};
