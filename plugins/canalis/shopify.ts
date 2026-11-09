import { ShopifyProvider } from "../../src/providers/shopify.js";
import { plugin } from "./adapter.js";

const shopify = plugin(new ShopifyProvider(), "SHOPIFY_WEBHOOK_SECRET");
export const describe = shopify.describe;
export const verify = shopify.verify;
