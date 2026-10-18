import { AnthropicProvider } from "../../src/providers/anthropic.js";
import { plugin } from "./adapter.js";

const anthropic = plugin(new AnthropicProvider(), "ANTHROPIC_WEBHOOK_SECRET");
export const describe = anthropic.describe;
export const verify = anthropic.verify;
