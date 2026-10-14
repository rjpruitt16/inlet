# Deploy Inlet On Cloudflare

The recommended shape is one Worker deployment per webhook provider:

```text
provider -> Inlet Worker -> ordered Durable Object -> Aquifer
                                      |
                                      +-> Cloudflare dead-letter queue
```

Durable Objects are selected by the route and fairness identity, so events for one user stay ordered while unrelated users progress independently.

## Configure

Copy [`wrangler.jsonc`](wrangler.jsonc) for the provider being deployed, then change:

- `name` to a provider-specific Worker name;
- the dead-letter queue name;
- `INLET_CONFIG` values for Aquifer, route, provider, secret binding, and destination.

Keep one route in each provider-specific config. The runtime supports multiple routes, but separate Workers isolate secrets, backlog, deploys, and failures.

## Deploy

From the repository root, create the dead-letter queue once, store the provider secret, build, and deploy:

```bash
npx wrangler queues create inlet-github-dead-letter \
  --config examples/cloudflare/wrangler.jsonc
npx wrangler secret put GITHUB_WEBHOOK_SECRET \
  --config examples/cloudflare/wrangler.jsonc
npm ci
npm run build
npx wrangler deploy --config examples/cloudflare/wrangler.jsonc
```

Configure the provider webhook with the deployed Worker URL plus the route path, for example `/webhooks/github/main`.

Repeat with a separate config, Worker name, dead-letter queue, and signing secret for Shopify, Stripe, or Anthropic.

## Aquifer Connectivity

The Worker must be able to reach `aquifer_url`. If Aquifer is private, expose it through a narrowly scoped authenticated gateway or Cloudflare connectivity appropriate to the deployment. Inlet chooses destinations from trusted configuration, but Aquifer should still never be exposed as a public caller-controlled relay.
