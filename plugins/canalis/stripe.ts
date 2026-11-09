import { StripeProvider } from "../../src/providers/stripe.js";
import { plugin } from "./adapter.js";

const stripe = plugin(new StripeProvider(), "STRIPE_WEBHOOK_SECRET");
export const describe = stripe.describe;
export const verify = stripe.verify;
