import { KlaviyoProvider } from "../../src/providers/klaviyo.js";
import { plugin } from "./adapter.js";

const klaviyo = plugin(new KlaviyoProvider(), "KLAVIYO_WEBHOOK_SECRET");
export const describe = klaviyo.describe;
export const verify = klaviyo.verify;
