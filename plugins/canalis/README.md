# Canalis plugins

Inlet's providers, compiled into [Canalis](https://github.com/rjpruitt16/canalis-rs) webhook plugins. They're WebAssembly modules, built with [Extism](https://extism.org), that Canalis loads from its plugins folder and serves at `POST /hooks/<name>`. The provider code is Inlet's own (`src/providers/*.ts`), so Inlet and Canalis verify webhooks the same way.

The only part that differs is `encoding.ts`. It stands in for `src/core/encoding.ts` and calls Canalis's built-in crypto (`hmac_sha256`, `hmac_sha1`), because there's no WebCrypto inside a plugin.

## Build

You need [`extism-js`](https://github.com/extism/js-pdk/releases) and [Binaryen](https://github.com/WebAssembly/binaryen/releases) (`wasm-opt`, `wasm-merge`) on `PATH`.

```bash
npm run build:canalis-plugins
```

This writes `dist/canalis/{shopify,github,stripe,anthropic,klaviyo,mailchimp}.wasm`.

## Use with Canalis

Copy the plugins you want into Canalis's plugins folder. Then, for each one, set its secret and where its events go:

```bash
cp dist/canalis/stripe.wasm /path/to/canalis/plugins/
STRIPE_WEBHOOK_SECRET=whsec_...
CANALIS_HOOK_STRIPE_TARGET=https://app.example/webhooks/stripe
```

| Plugin | Secret | Deduplicated by | Fair per |
|---|---|---|---|
| `shopify` | `SHOPIFY_WEBHOOK_SECRET`: the app's API secret | `X-Shopify-Webhook-Id` | shop (or shop and customer) |
| `github` | `GITHUB_WEBHOOK_SECRET`: the webhook's secret | `X-GitHub-Delivery` | installation, else organization, repository owner or sender |
| `stripe` | `STRIPE_WEBHOOK_SECRET`: the endpoint's `whsec_...` signing secret | the event's `id` | connected account |
| `anthropic` | `ANTHROPIC_WEBHOOK_SECRET`: the `whsec_...` signing secret | `webhook-id` | the event's object (`data.id`), else its workspace or organization |
| `klaviyo` | `KLAVIYO_WEBHOOK_SECRET`: the system webhook signing secret | `external_id`, or a hash for a batch | common profile, else Klaviyo account |
| `mailchimp` | `MAILCHIMP_WEBHOOK_SECRET`: the one-time Marketing webhook signing secret | hash of the raw form body | member, audience, campaign or email |

Point the provider's webhook URL at `https://<canalis>/hooks/<plugin>`. Canalis verifies each delivery and refuses a bad signature with 401. Stripe and Anthropic deliveries are also refused when their signed timestamp is more than 5 minutes off. Canalis deduplicates each event and answers the provider once it's safely queued. It then delivers it to the target through Aquifer, fairly per tenant (the last column).

## The plugin interface

The interface is JSON in and out. It's documented in Canalis's `src/hooks.rs`:
- `describe() -> { name, secrets }`
- `verify(request) -> { ok: { event_id, tenant, event_type, headers } } | { reject: { status, reason } }`
