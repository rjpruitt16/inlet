# Canalis plugins

Inlet's providers, compiled into [Canalis](https://github.com/rjpruitt16/canalis-rs) webhook plugins. They're WebAssembly modules, built with [Extism](https://extism.org), that Canalis loads from its plugins folder and serves at `POST /hooks/<name>`. The provider code is Inlet's own (`src/providers/*.ts`), so Inlet and Canalis verify webhooks the same way.

The only part that differs is `encoding.ts`. It stands in for `src/core/encoding.ts` and calls Canalis's built-in crypto (`hmac_sha256`, `hmac_sha1`), because there's no WebCrypto inside a plugin.

## Build

You need [`extism-js`](https://github.com/extism/js-pdk/releases) and [Binaryen](https://github.com/WebAssembly/binaryen/releases) (`wasm-opt`, `wasm-merge`) on `PATH`.

```bash
npm run build:canalis-plugins     # dist/canalis/shopify.wasm
```

## Use with Canalis

```bash
cp dist/canalis/shopify.wasm /path/to/canalis/plugins/
SHOPIFY_WEBHOOK_SECRET=...                      # the app's API secret (what Shopify signs with)
CANALIS_HOOK_SHOPIFY_TARGET=https://app.example/webhooks/shopify
```

Point Shopify's webhook URL at `https://<canalis>/hooks/shopify`. Canalis verifies each delivery and deduplicates it by `X-Shopify-Webhook-Id`. It answers Shopify once the event is safely queued, then delivers it to the target through Aquifer, fairly per shop (or per shop and customer).

## The plugin interface

The interface is JSON in and out. It's documented in Canalis's `src/hooks.rs`:
- `describe() -> { name, secrets }`
- `verify(request) -> { ok: { event_id, tenant, event_type, headers } } | { reject: { status, reason } }`
