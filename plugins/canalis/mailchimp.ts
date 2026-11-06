import { MailchimpProvider } from "../../src/providers/mailchimp.js";
import { plugin } from "./adapter.js";

const mailchimp = plugin(new MailchimpProvider(), "MAILCHIMP_WEBHOOK_SECRET");
export const describe = mailchimp.describe;
export const verify = mailchimp.verify;
