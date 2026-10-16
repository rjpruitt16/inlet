# Cloudflare Worker And Private Fly.io Aquifer

This quick start deploys a public Inlet Worker in front of a private Aquifer Machine on Fly.io. A Cloudflare VPC Service and Tunnel carry only the Worker's Aquifer requests into the Fly private network. Aquifer receives no public IP address.

```text
webhook provider
      |
      v
Inlet Worker -> Durable Object -> INLET_AQUIFER VPC binding
                                      |
                                      v
Cloudflare Tunnel -> tiny connector on Fly.io -> Aquifer Flycast
                                                       |
                                                       v
                                                paced backend
```

Use one Worker deployment per provider so each provider keeps its signing secret, ordered backlog, and failures isolated.

## Prerequisites

- `flyctl`, authenticated to the Fly organization that will host both apps
- Node.js 20 or later, npm, Git, `curl`, `jq`, and OpenSSL
- Wrangler authentication
- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN` with Workers write, Cloudflare Tunnel write, and Connectivity Directory admin access
- `GITHUB_WEBHOOK_SECRET` for this GitHub example

Workers VPC is currently a Cloudflare beta. Validate its availability and limits for your account before treating this evaluation topology as production infrastructure.

## Deploy

From the Inlet repository root:

```bash
export CLOUDFLARE_ACCOUNT_ID=your-account-id
export CLOUDFLARE_API_TOKEN=your-api-token
export GITHUB_WEBHOOK_SECRET=your-github-webhook-secret

FLY_ORG=your-fly-org \
FLY_REGION=ord \
WEBHOOK_DESTINATION=https://backend.example.com/webhooks/github \
./examples/cloudflare-fly/deploy-quickstart.sh
```

The script refuses to reuse existing Fly app names. It writes a non-secret state file under `.inlet-quickstart/` containing the exact resource names and IDs created by that run. Aquifer uses a 256 MB `shared-cpu-1x` Machine for this evaluation; benchmark and size it for real traffic.

The combined quick start defaults to `AQUIFER_VERSION=source` because the current `v0.14.0` release predates callback-free jobs. Set an explicit release version after publishing one that contains Aquifer commit `893971c` or later.

Configure GitHub to send webhooks to the printed Worker URL plus `/webhooks/github/main` using the same secret. The Worker verifies the signature, durably orders the event, and submits it through the private `INLET_AQUIFER` binding.

The quick start omits a Cloudflare dead-letter queue to keep evaluation cleanup small. Add `INLET_DLQ` before production use.

## Remove

Use the exact cleanup command printed by the deploy script:

```bash
./examples/cloudflare-fly/destroy-quickstart.sh \
  .inlet-quickstart/RESOURCE_PREFIX/state.json
```

The cleanup script reads the recorded IDs, deletes the Worker and VPC Service, destroys the connector and Aquifer Fly apps, and then deletes the Cloudflare Tunnel. It does not enumerate and delete unrelated resources.
